import * as core from '@actions/core'
import { CleanupContext, ValidationResult } from './cleanup-types.js'

export class ImageValidator {
  private context: CleanupContext

  constructor(context: CleanupContext) {
    this.context = context
  }

  /**
   * Validate manifests list packages
   */
  async validate(): Promise<ValidationResult> {
    core.startGroup(
      `[${this.context.targetPackage}] Validating multi-architecture/referrers images`
    )

    let hasErrors = false
    const processedManifests = new Set<string>()
    const digests = this.context.packageRepo.getDigests()

    for (const digest of digests) {
      if (!processedManifests.has(digest)) {
        const manifest = await this.context.registry.getManifestByDigest(digest)
        const tags =
          this.context.packageRepo.getPackageByDigest(digest).metadata.container
            .tags

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
      if (tag.startsWith('sha256-')) {
        let digest = tag.replace('sha256-', 'sha256:')
        if (digest.length > 71) {
          digest = digest.substring(0, 71)
        }
        if (!this.context.packageRepo.getIdByDigest(digest)) {
          hasErrors = true
          core.warning(
            `parent image for referrer tag ${tag} not found in repository`
          )
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
          if (ghPackage.metadata.container.tags.length > 0) {
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
   * Find partial images (some child manifests missing)
   */
  async findPartialImages(filterSet: Set<string>): Promise<Set<string>> {
    core.startGroup(
      `[${this.context.targetPackage}] Finding partial images to delete`
    )
    const partialImages = new Set<string>()

    for (const digest of filterSet) {
      const manifest = await this.context.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          if (!this.context.packageRepo.getIdByDigest(imageManifest.digest)) {
            partialImages.add(digest)
            const ghPackage =
              this.context.packageRepo.getPackageByDigest(digest)
            if (ghPackage.metadata.container.tags.length > 0) {
              core.info(`${digest} ${ghPackage.metadata.container.tags}`)
            } else {
              core.info(`${digest}`)
            }
            break
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
   * Find orphaned images (parent image doesn't exist)
   */
  findOrphanedImages(): Set<string> {
    core.startGroup(
      `[${this.context.targetPackage}] Finding orphaned images (tags) to delete`
    )
    const orphanedImages = new Set<string>()

    for (const tag of this.context.packageRepo.getTags()) {
      if (tag.startsWith('sha256-')) {
        let digest = tag.replace('sha256-', 'sha256:')
        if (digest.length > 71) {
          digest = digest.substring(0, 71)
        }
        // Check if that digest exists
        if (this.context.packageRepo.getIdByDigest(digest) === undefined) {
          const orphanDigest = this.context.packageRepo.getDigestByTag(tag)
          if (orphanDigest) {
            orphanedImages.add(orphanDigest)
            core.info(tag)
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
