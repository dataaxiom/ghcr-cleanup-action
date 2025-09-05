import * as core from '@actions/core'
import { LogLevel } from './config.js'
import { CleanupContext } from './cleanup-types.js'

export class ManifestAnalyzer {
  private context: CleanupContext

  constructor(context: CleanupContext) {
    this.context = context
  }

  /**
   * Builds a map of child images back to their parents
   * The map is used to determine if image can be safely deleted
   */
  async loadDigestUsedByMap(): Promise<Map<string, Set<string>>> {
    const digestUsedBy = new Map<string, Set<string>>()
    let stopWatch = new Date()
    const digests = this.context.packageRepo.getDigests()
    const digestCount = digests.size
    let processed = 0
    let skipped = 0

    core.startGroup(`[${this.context.targetPackage}] Loading manifests`)
    for (const digest of digests) {
      const manifest = await this.context.registry.getManifestByDigest(digest)
      processed++
      if (this.context.config.logLevel === LogLevel.DEBUG) {
        const encoded = JSON.stringify(manifest, null, 4)
        core.info(`${digest}:${encoded}`)
      } else {
        // Output a status message if 3 seconds has passed
        const now = new Date()
        if (now.getMilliseconds() - stopWatch.getMilliseconds() >= 3000) {
          core.info(`loaded ${processed} of ${digestCount} manifests`)
          stopWatch = new Date() // Reset the clock
        }
      }

      // We only map multi-arch images
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          // Only add existing packages
          if (digests.has(imageManifest.digest)) {
            let parents = digestUsedBy.get(imageManifest.digest)
            if (!parents) {
              parents = new Set<string>()
              digestUsedBy.set(imageManifest.digest, parents)
            }
            parents.add(digest)

            // Now remove so we don't download the child manifest later on in loop
            digests.delete(imageManifest.digest)
            skipped++
            processed++
          }
        }
      }
    }
    core.info(`loaded ${processed} manifests, ${skipped} skipped`)
    core.endGroup()

    return digestUsedBy
  }

  /**
   * Remove all multi architecture platform images from the filterSet including its
   * referrer image if present. Filtering/processing only occurs on top level images.
   */
  async initFilterSet(): Promise<Set<string>> {
    const digests = this.context.packageRepo.getDigests()

    for (const digest of digests) {
      const manifest = await this.context.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          digests.delete(imageManifest.digest)
        }
      }

      // Process any associated images which have been tagged using the digest
      const digestTag = digest.replace('sha256:', 'sha256-')
      const tags = this.context.packageRepo.getTags()
      for (const tag of tags) {
        if (tag.startsWith(digestTag)) {
          // Remove it
          const tagDigest = this.context.packageRepo.getDigestByTag(tag)
          if (tagDigest) {
            digests.delete(tagDigest)
            // Process any children
            const childManifest =
              await this.context.registry.getManifestByTag(tag)
            if (childManifest.manifests) {
              for (const manifestEntry of childManifest.manifests) {
                digests.delete(manifestEntry.digest)
              }
            }
          }
        }
      }
    }

    return digests
  }

  /**
   * Builds a label for a manifest based on its type
   */
  async buildLabel(imageManifest: any): Promise<string> {
    let label = ''
    if (imageManifest.platform) {
      if (imageManifest.platform.architecture) {
        label = imageManifest.platform.architecture
      }
      if (label !== 'unknown') {
        if (imageManifest.platform.variant) {
          label += `/${imageManifest.platform.variant}`
        }
        label = `architecture: ${label}`
      } else {
        // Check if it's a buildx attestation
        const manifest = await this.context.registry.getManifestByDigest(
          imageManifest.digest
        )
        // Kinda crude
        if (manifest.layers) {
          if (manifest.layers[0].mediaType === 'application/vnd.in-toto+json') {
            label = 'application/vnd.in-toto+json'
          }
        }
      }
    } else if (imageManifest.artifactType) {
      // Check if it's a github attestation
      if (
        imageManifest.artifactType.startsWith(
          'application/vnd.dev.sigstore.bundle'
        )
      ) {
        label = 'sigstore attestation'
      } else {
        label = imageManifest.artifactType
      }
    }
    return label
  }

  /**
   * Pre-loads manifests needed for deletion process
   */
  async primeManifests(deleteSet: Set<string>): Promise<void> {
    const digests = this.context.packageRepo.getDigests()

    for (const digest of deleteSet) {
      const manifest = await this.context.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          // Call the buildLabel method which will prime manifest if needed
          if (digests.has(imageManifest.digest)) {
            await this.buildLabel(imageManifest)
          }
        }
      }
      // Process tagged digests (referrers)
      const digestTag = digest.replace('sha256:', 'sha256-')
      const tags = this.context.packageRepo.getTags()
      for (const tag of tags) {
        if (tag.startsWith(digestTag)) {
          const tagDigest = this.context.packageRepo.getDigestByTag(tag)
          if (tagDigest) {
            const tagManifest =
              await this.context.registry.getManifestByDigest(tagDigest)
            if (tagManifest.manifests) {
              for (const manifestEntry of tagManifest.manifests) {
                if (digests.has(manifestEntry.digest)) {
                  await this.buildLabel(manifestEntry)
                }
              }
            }
          }
        }
      }
    }
  }
}
