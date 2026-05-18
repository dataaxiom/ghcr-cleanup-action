import * as core from '@actions/core'
import { CleanupContext, DeletionPlan } from './cleanup-types.js'
import { ImageFilter } from './image-filter.js'
import { GhPackage } from './utils.js'

export class DeletionStrategy {
  private context: CleanupContext
  private imageFilter: ImageFilter

  constructor(context: CleanupContext) {
    this.context = context
    this.imageFilter = new ImageFilter(context)
  }

  /**
   * Process tag deletions including untagging operations
   */
  async processTagDeletions(
    filterSet: Set<string>,
    excludeTags: string[]
  ): Promise<DeletionPlan> {
    const plan: DeletionPlan = {
      deleteSet: new Set<string>(),
      untagOperations: new Map<string, string[]>()
    }

    if (!this.context.config.deleteTags) {
      return plan
    }

    const matchTags = this.imageFilter.expandTags(filterSet)

    if (matchTags.size === 0) {
      core.startGroup(
        `[${this.context.targetPackage}] Finding tagged images to delete: ${this.context.config.deleteTags}`
      )
      core.info('no matching tags found')
      core.endGroup()
      return plan
    }

    // Separate untagging events and standard deletions
    const untaggingTags = new Set<string>()
    const standardTags = new Set<string>()

    for (const tag of matchTags) {
      if (!excludeTags.includes(tag)) {
        if (tag.startsWith('sha256:')) {
          standardTags.add(tag)
        } else {
          const manifestDigest = this.context.packageRepo.getDigestByTag(tag)
          if (manifestDigest) {
            const ghPackage =
              this.context.packageRepo.getPackageByDigest(manifestDigest)
            if (!ghPackage) continue
            if (ghPackage.metadata.container.tags.length > 1) {
              untaggingTags.add(tag)
              if (!plan.untagOperations.has(manifestDigest)) {
                plan.untagOperations.set(manifestDigest, [])
              }
              const operations = plan.untagOperations.get(manifestDigest)
              if (operations) {
                operations.push(tag)
              }
            } else if (ghPackage.metadata.container.tags.length === 1) {
              standardTags.add(tag)
            }
          }
        }
      }
    }

    // Process standard deletions - only if keep-n-tagged is not set
    // When keep-n-tagged IS set, it will handle ALL tagged deletions later
    if (standardTags.size > 0 && this.context.config.keepNtagged == null) {
      core.startGroup(
        `[${this.context.targetPackage}] Find tagged images to delete: ${this.context.config.deleteTags}`
      )
      for (const tag of standardTags) {
        core.info(tag)
        let manifestDigest: string | undefined
        if (tag.startsWith('sha256:')) {
          manifestDigest = tag
        } else {
          manifestDigest = this.context.packageRepo.getDigestByTag(tag)
        }
        if (manifestDigest) {
          plan.deleteSet.add(manifestDigest)
          filterSet.delete(manifestDigest)
        }
      }
      core.endGroup()
    }

    return plan
  }

  /**
   * Keep N untagged images
   */
  keepNUntagged(filterSet: Set<string>): Set<string> {
    const deleteSet = new Set<string>()

    if (this.context.config.keepNuntagged == null) {
      return deleteSet
    }

    core.startGroup(
      `[${this.context.targetPackage}] Finding untagged images to delete, keeping ${this.context.config.keepNuntagged} versions`
    )

    const unTaggedPackages: GhPackage[] = []
    for (const digest of filterSet) {
      const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
      if (!ghPackage) continue
      if (ghPackage.metadata.container.tags.length === 0) {
        unTaggedPackages.push(ghPackage)
      }
    }

    if (unTaggedPackages.length > 0) {
      // Sort descending by date
      unTaggedPackages.sort((a, b) => {
        return Date.parse(b.updated_at) - Date.parse(a.updated_at)
      })

      if (unTaggedPackages.length > this.context.config.keepNuntagged) {
        const deletePackages = unTaggedPackages.splice(
          this.context.config.keepNuntagged
        )
        for (const deletePackage of deletePackages) {
          deleteSet.add(deletePackage.name)
          filterSet.delete(deletePackage.name)
          core.info(`${deletePackage.name}`)
        }
      }
    }

    if (deleteSet.size === 0) {
      core.info('no untagged images found to delete')
    }
    core.endGroup()

    return deleteSet
  }

  /**
   * Keep N tagged images
   */
  keepNTagged(filterSet: Set<string>): Set<string> {
    const deleteSet = new Set<string>()

    if (this.context.config.keepNtagged == null) {
      return deleteSet
    }

    core.startGroup(
      `[${this.context.targetPackage}] Finding tagged images to delete, keeping ${this.context.config.keepNtagged} versions`
    )

    const taggedPackages = this.collectKeepNTaggedCandidates(filterSet)

    if (taggedPackages.length > this.context.config.keepNtagged) {
      const deletePackages = taggedPackages.splice(
        this.context.config.keepNtagged
      )
      for (const deletePackage of deletePackages) {
        deleteSet.add(deletePackage.name)
        filterSet.delete(deletePackage.name)
        const ghPackage = this.context.packageRepo.getPackageByDigest(
          deletePackage.name
        )
        const tags = ghPackage?.metadata.container.tags ?? []
        core.info(`${deletePackage.name} ${tags}`)
      }
    } else {
      core.info('no tagged images found to delete')
    }
    core.endGroup()

    return deleteSet
  }

  /**
   * Returns the set of digests that keep-n-tagged would protect — i.e. the
   * top-N most recent images among the keep-n-tagged candidate set. Used by
   * the orchestrator to gate untag operations so that a multi-tagged image
   * in the keep set doesn't have a matched tag stripped before keep-n-tagged
   * is consulted.
   */
  computeKeepNTaggedDigests(filterSet: Set<string>): Set<string> {
    const keepSet = new Set<string>()
    if (this.context.config.keepNtagged == null) {
      return keepSet
    }
    const candidates = this.collectKeepNTaggedCandidates(filterSet)
    const kept = candidates.slice(0, this.context.config.keepNtagged)
    for (const pkg of kept) {
      keepSet.add(pkg.name)
    }
    return keepSet
  }

  /**
   * Collect the candidate set for keep-n-tagged, deduplicated by digest, and
   * sorted newest-first. Shared by keepNTagged() (which deletes the tail) and
   * computeKeepNTaggedDigests() (which protects the head).
   *
   * Dedup matters because the delete-tags branch walks per-tag and would
   * otherwise enter the same image N times when an image has N matched tags —
   * wrongly making each tag count as a separate keep-set slot.
   */
  private collectKeepNTaggedCandidates(filterSet: Set<string>): GhPackage[] {
    const byDigest = new Map<string, GhPackage>()

    if (this.context.config.deleteTags != null) {
      // Apply keep-n mode only on the supplied/expanded tags
      const matchTags = this.imageFilter.expandTags(filterSet)
      for (const tag of matchTags) {
        const digest = this.context.packageRepo.getDigestByTag(tag)
        if (digest && !byDigest.has(digest)) {
          const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
          if (ghPackage) {
            byDigest.set(digest, ghPackage)
          }
        }
      }
    } else {
      // Copy images with tags from the full set
      for (const digest of filterSet) {
        if (byDigest.has(digest)) continue
        const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
        if (ghPackage && ghPackage.metadata.container.tags.length > 0) {
          byDigest.set(digest, ghPackage)
        }
      }
    }

    const taggedPackages = Array.from(byDigest.values())
    taggedPackages.sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
    )
    return taggedPackages
  }

  /**
   * Delete all untagged images
   */
  deleteAllUntagged(filterSet: Set<string>): Set<string> {
    const deleteSet = new Set<string>()

    core.startGroup(
      `[${this.context.targetPackage}] Finding all untagged images to delete`
    )

    for (const digest of filterSet) {
      const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
      if (!ghPackage) continue
      if (ghPackage.metadata.container.tags.length === 0) {
        deleteSet.add(digest)
        filterSet.delete(digest)
        core.info(`${digest}`)
      }
    }

    if (deleteSet.size === 0) {
      core.info('no untagged images found')
    }
    core.endGroup()

    return deleteSet
  }
}
