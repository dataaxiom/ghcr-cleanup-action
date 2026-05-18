import * as core from '@actions/core'
import { CleanupContext, ValidationResult } from './cleanup-types.js'
import { parentDigestFromReferrerTag } from './utils.js'

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
        if (!ghPackage) continue
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
    core.startGroup(
      `[${this.context.targetPackage}] Finding ghost images to delete`
    )
    const ghostImages = new Set<string>()

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
          if (ghPackage && ghPackage.metadata.container.tags.length > 0) {
            core.info(`${digest} ${ghPackage.metadata.container.tags}`)
          } else {
            core.info(`${digest}`)
          }
        }
      }
    }

    if (ghostImages.size === 0) {
      core.info('no ghost images found')
    }
    core.endGroup()

    return ghostImages
  }

  /**
   * Find partial images: multi-arch images where some, but not all, child
   * manifests are missing. Images where every child is missing are fully
   * ghost images and are handled by findGhostImages instead.
   */
  async findPartialImages(filterSet: Set<string>): Promise<Set<string>> {
    core.startGroup(
      `[${this.context.targetPackage}] Finding partial images to delete`
    )
    const partialImages = new Set<string>()

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
          if (ghPackage && ghPackage.metadata.container.tags.length > 0) {
            core.info(`${digest} ${ghPackage.metadata.container.tags}`)
          } else {
            core.info(`${digest}`)
          }
        }
      }
    }

    if (partialImages.size === 0) {
      core.info('no partial images found')
    }
    core.endGroup()

    return partialImages
  }

  /**
   * Find orphaned images (parent image doesn't exist). Covers both the
   * sha256-* fallback tag shape and OCI 1.1 subject-bearing referrers
   * whose subject is no longer in the repo.
   */
  findOrphanedImages(
    subjectReferrers: Map<string, Set<string>> = new Map()
  ): Set<string> {
    core.startGroup(
      `[${this.context.targetPackage}] Finding orphaned images (tags) to delete`
    )
    const orphanedImages = new Set<string>()

    for (const tag of this.context.packageRepo.getTags()) {
      const digest = parentDigestFromReferrerTag(tag)
      if (
        digest &&
        this.context.packageRepo.getIdByDigest(digest) === undefined
      ) {
        const orphanDigest = this.context.packageRepo.getDigestByTag(tag)
        if (orphanDigest) {
          orphanedImages.add(orphanDigest)
          core.info(tag)
        }
      }
    }

    for (const [subjectDigest, referrers] of subjectReferrers) {
      if (this.context.packageRepo.getIdByDigest(subjectDigest) === undefined) {
        for (const referrerDigest of referrers) {
          if (this.context.packageRepo.getIdByDigest(referrerDigest)) {
            orphanedImages.add(referrerDigest)
            core.info(`${referrerDigest} (subject ${subjectDigest} missing)`)
          }
        }
      }
    }

    if (orphanedImages.size === 0) {
      core.info('no orphaned images found')
    }
    core.endGroup()

    return orphanedImages
  }
}
