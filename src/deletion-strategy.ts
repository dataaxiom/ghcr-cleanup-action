import * as core from '@actions/core'
import { CleanupContext, DeletionPlan } from './cleanup-types.js'
import { ImageFilter } from './image-filter.js'

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

    const unTaggedPackages = []
    for (const digest of filterSet) {
      const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
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

    const taggedPackages = []

    if (this.context.config.deleteTags != null) {
      // Apply keep-n mode only on the supplied/expanded tags
      const matchTags = this.imageFilter.expandTags(filterSet)
      for (const tag of matchTags) {
        const digest = this.context.packageRepo.getDigestByTag(tag)
        if (digest) {
          const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
          if (ghPackage) {
            taggedPackages.push(ghPackage)
          }
        }
      }
    } else {
      // Copy images with tags from the full set
      for (const digest of filterSet) {
        const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
        if (ghPackage.metadata.container.tags.length > 0) {
          taggedPackages.push(ghPackage)
        }
      }
    }

    // Sort descending by date
    taggedPackages.sort((a, b) => {
      return Date.parse(b.updated_at) - Date.parse(a.updated_at)
    })

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
        core.info(`${deletePackage.name} ${ghPackage.metadata.container.tags}`)
      }
    } else {
      core.info('no tagged images found to delete')
    }
    core.endGroup()

    return deleteSet
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
