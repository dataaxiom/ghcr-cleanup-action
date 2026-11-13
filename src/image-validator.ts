import * as core from '@actions/core'
import { CleanupContext, ValidationResult } from './cleanup-types.js'
import { LogLevel } from './config.js'
import { logListing, parentDigestFromReferrerTag } from './utils.js'

export class ImageValidator {
  private context: CleanupContext

  constructor(context: CleanupContext) {
    this.context = context
  }

  /**
   * Validate manifests list packages
   */
  async validate(
    subjectReferrers: Map<string, Set<string>> = new Map()
  ): Promise<ValidationResult> {
    core.startGroup(
      `[${this.context.targetPackage}] Validating multi-architecture/referrers images`
    )

    let hasErrors = false
    const processedManifests = new Set<string>()
    const digests = this.context.packageRepo.getDigests()

    for (const digest of digests) {
      if (!processedManifests.has(digest)) {
        const manifest = await this.context.registry.getManifestByDigest(digest)
        const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
        if (!ghPackage) {
          throw new Error(
            `cache invariant: digest ${digest} not in package cache`
          )
        }
        const tags = ghPackage.metadata.container.tags

        if (manifest.manifests) {
          for (const childImage of manifest.manifests) {
            processedManifests.add(childImage.digest)
            if (!this.context.packageRepo.getIdByDigest(childImage.digest)) {
              hasErrors = true
              if (tags.length > 0) {
                core.warning(
                  `digest ${childImage.digest} not found on image ${tags}`
                )
              } else {
                core.warning(
                  `digest ${childImage.digest} not found on untagged image ${digest}`
                )
              }
            }
            digests.delete(childImage.digest)
          }
        }
      }
    }

    // Check for orphaned tags (referrers/cosign etc)
    const tagsInUse = this.context.packageRepo.getTags()
    for (const tag of tagsInUse) {
      const digest = parentDigestFromReferrerTag(tag)
      if (digest && !this.context.packageRepo.getIdByDigest(digest)) {
        hasErrors = true
        core.warning(
          `parent image for referrer tag ${tag} not found in repository`
        )
      }
    }

    // Check for orphaned OCI 1.1 subject-bearing referrers
    for (const [subjectDigest, referrers] of subjectReferrers) {
      if (!this.context.packageRepo.getIdByDigest(subjectDigest)) {
        for (const referrerDigest of referrers) {
          if (this.context.packageRepo.getIdByDigest(referrerDigest)) {
            hasErrors = true
            core.warning(
              `subject ${subjectDigest} for referrer ${referrerDigest} not found in repository`
            )
          }
        }
      }
    }

    if (!hasErrors) {
      core.info('no errors found')
    }
    core.endGroup()

    // Return basic result - can be extended later
    return {
      hasErrors,
      ghostImages: new Set<string>(),
      partialImages: new Set<string>(),
      orphanedImages: new Set<string>()
    }
  }

  /**
   * Find ghost images (all child manifests missing)
   */
  async findGhostImages(filterSet: Set<string>): Promise<Set<string>> {
    const ghostImages = new Set<string>()
    const lines: string[] = []

    for (const digest of filterSet) {
      const manifest = await this.context.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        let missing = 0
        for (const imageManifest of manifest.manifests) {
          if (!this.context.packageRepo.getIdByDigest(imageManifest.digest)) {
            missing += 1
          }
        }
        if (missing === manifest.manifests.length) {
          ghostImages.add(digest)
          const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
          if (!ghPackage) {
            throw new Error(
              `cache invariant: digest ${digest} not in package cache`
            )
          }
          if (ghPackage.metadata.container.tags.length > 0) {
            lines.push(`${digest} ${ghPackage.metadata.container.tags}`)
          } else {
            lines.push(`${digest}`)
          }
        }
      }
    }

    logListing(
      `[${this.context.targetPackage}] Finding ghost images to delete`,
      lines,
      {
        debug: this.context.config.logLevel >= LogLevel.DEBUG,
        emptyMessage: 'no ghost images found'
      }
    )

    return ghostImages
  }

  /**
   * Find partial images: multi-arch images where some, but not all, child
   * manifests are missing. Images where every child is missing are fully
   * ghost images and are handled by findGhostImages instead.
   */
  async findPartialImages(filterSet: Set<string>): Promise<Set<string>> {
    const partialImages = new Set<string>()
    const lines: string[] = []

    for (const digest of filterSet) {
      const manifest = await this.context.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        let missing = 0
        for (const imageManifest of manifest.manifests) {
          if (!this.context.packageRepo.getIdByDigest(imageManifest.digest)) {
            missing += 1
          }
        }
        // Partial: at least one child missing AND at least one child present.
        // Excludes the all-missing case (ghost images) so the two options
        // don't overlap.
        if (missing > 0 && missing < manifest.manifests.length) {
          partialImages.add(digest)
          const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
          if (!ghPackage) {
            throw new Error(
              `cache invariant: digest ${digest} not in package cache`
            )
          }
          if (ghPackage.metadata.container.tags.length > 0) {
            lines.push(`${digest} ${ghPackage.metadata.container.tags}`)
          } else {
            lines.push(`${digest}`)
          }
        }
      }
    }

    logListing(
      `[${this.context.targetPackage}] Finding partial images to delete`,
      lines,
      {
        debug: this.context.config.logLevel >= LogLevel.DEBUG,
        emptyMessage: 'no partial images found'
      }
    )

    return partialImages
  }

  /**
   * Find orphaned images (parent image doesn't exist). Covers both the
   * sha256-* fallback tag shape and OCI 1.1 subject-bearing referrers
   * whose subject is no longer in the repo.
   *
   * `excludeTags` (the expanded exclude list — matched tag and digest
   * strings) is honored here even though orphans are reached outside the
   * top-level filterSet: an orphan is a stand-alone leftover being
   * independently staged for deletion, so exclude-tags protects it.
   *
   * Deleting an image also deletes its children (the cascade ignores
   * exclude-tags by design: children are parts of their parent's image).
   * So an orphan with an excluded child is kept too — otherwise staging
   * the orphan would delete that excluded child along with it.
   * `digestUsedBy` (child digest → parent digests) supplies that link.
   */
  findOrphanedImages(
    subjectReferrers: Map<string, Set<string>> = new Map(),
    excludeTags: string[] = [],
    digestUsedBy: Map<string, Set<string>> = new Map()
  ): Set<string> {
    const orphanedImages = new Set<string>()
    const excluded = new Set(excludeTags)
    const lines: string[] = []

    // Parents of any excluded image (by digest, or by a matched tag).
    const parentsOfExcluded = new Set<string>()
    for (const entry of excluded) {
      const digest = this.context.packageRepo.getIdByDigest(entry)
        ? entry
        : this.context.packageRepo.getDigestByTag(entry)
      for (const parent of (digest && digestUsedBy.get(digest)) || []) {
        parentsOfExcluded.add(parent)
      }
    }

    // An orphan is protected if the exclude pattern matched its digest or
    // any of its tags (a referrer may carry more than the sha256-* tag),
    // or if one of its children is excluded.
    const isExcluded = (digest: string, tag?: string): boolean => {
      if (tag && excluded.has(tag)) return true
      if (excluded.has(digest)) return true
      if (parentsOfExcluded.has(digest)) return true
      const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
      return (
        ghPackage?.metadata.container.tags.some(t => excluded.has(t)) ?? false
      )
    }

    for (const tag of this.context.packageRepo.getTags()) {
      const digest = parentDigestFromReferrerTag(tag)
      if (
        digest &&
        this.context.packageRepo.getIdByDigest(digest) === undefined
      ) {
        const orphanDigest = this.context.packageRepo.getDigestByTag(tag)
        if (orphanDigest && !isExcluded(orphanDigest, tag)) {
          orphanedImages.add(orphanDigest)
          lines.push(tag)
        }
      }
    }

    for (const [subjectDigest, referrers] of subjectReferrers) {
      if (this.context.packageRepo.getIdByDigest(subjectDigest) === undefined) {
        for (const referrerDigest of referrers) {
          if (
            this.context.packageRepo.getIdByDigest(referrerDigest) &&
            !isExcluded(referrerDigest)
          ) {
            orphanedImages.add(referrerDigest)
            lines.push(`${referrerDigest} (subject ${subjectDigest} missing)`)
          }
        }
      }
    }

    logListing(
      `[${this.context.targetPackage}] Finding orphaned images (tags) to delete`,
      lines,
      {
        debug: this.context.config.logLevel >= LogLevel.DEBUG,
        emptyMessage: 'no orphaned images found'
      }
    )

    return orphanedImages
  }
}
