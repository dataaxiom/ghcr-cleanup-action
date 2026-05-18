import * as core from '@actions/core'
import { LogLevel } from './config.js'
import { CleanupContext } from './cleanup-types.js'

export class ManifestAnalyzer {
  private context: CleanupContext

  constructor(context: CleanupContext) {
    this.context = context
  }

  /**
   * Builds two relationship maps in a single pass:
   *  - digestUsedBy: child digest → set of multi-arch parent indexes
   *  - subjectReferrers: subject digest → set of OCI 1.1 referrer digests
   *    (manifests with a `subject` descriptor; subject may or may not be in
   *    the repo — entries where the subject is missing surface as orphans
   *    in the validator).
   */
  async loadDigestUsedByMap(): Promise<{
    digestUsedBy: Map<string, Set<string>>
    subjectReferrers: Map<string, Set<string>>
  }> {
    const digestUsedBy = new Map<string, Set<string>>()
    const subjectReferrers = new Map<string, Set<string>>()
    let stopWatch = new Date()
    const digests = this.context.packageRepo.getDigests()
    const digestCount = digests.size
    let processed = 0
    let skipped = 0
    // Track digests we've already seen as children of some parent index.
    // Used to skip the redundant manifest fetch when the outer loop reaches
    // them — they have no children of their own to map. NOTE: we must NOT
    // remove these from `digests`, otherwise subsequent parents that also
    // reference the same child can't register themselves as a parent, and
    // the cascade-delete safety check in image-deleter would treat
    // multi-parent shared children as single-parent and wrongly delete them.
    const knownChildren = new Set<string>()

    core.startGroup(`[${this.context.targetPackage}] Loading manifests`)
    for (const digest of digests) {
      if (knownChildren.has(digest)) {
        // Already mapped as a child of a previously-seen parent index;
        // no need to fetch its manifest again.
        skipped++
        processed++
        continue
      }
      const manifest = await this.context.registry.getManifestByDigest(digest)
      processed++
      if (this.context.config.logLevel === LogLevel.DEBUG) {
        const encoded = JSON.stringify(manifest, null, 4)
        core.info(`${digest}:${encoded}`)
      } else {
        // Output a status message if 3 seconds has passed
        const now = new Date()
        if (now.getTime() - stopWatch.getTime() >= 3000) {
          core.info(`loaded ${processed} of ${digestCount} manifests`)
          stopWatch = now // Reset the clock
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
            knownChildren.add(imageManifest.digest)
          }
        }
      }

      // OCI 1.1 subject-bearing referrer (sigstore bundle, etc). ghcr.io
      // does not implement the /referrers API but does echo the subject
      // field, so we build the reverse index ourselves. Record the link
      // even when the subject is not in the repo so the validator can
      // surface orphans.
      const subjectDigest = manifest.subject?.digest
      if (subjectDigest) {
        let referrers = subjectReferrers.get(subjectDigest)
        if (!referrers) {
          referrers = new Set<string>()
          subjectReferrers.set(subjectDigest, referrers)
        }
        referrers.add(digest)
      }
    }
    core.info(`loaded ${processed} manifests, ${skipped} skipped`)
    core.endGroup()

    return { digestUsedBy, subjectReferrers }
  }

  /**
   * Remove all multi architecture platform images from the filterSet including
   * its referrer image if present (whether linked via a sha256-* tag or via an
   * OCI 1.1 subject descriptor). Filtering/processing only occurs on top
   * level images.
   */
  async initFilterSet(
    subjectReferrers: Map<string, Set<string>> = new Map()
  ): Promise<Set<string>> {
    const digests = this.context.packageRepo.getDigests()

    // Remove all OCI 1.1 subject-bearing referrers from top-level
    // processing — they are not stand-alone artifacts. If the subject is
    // still in the repo, the referrer follows it through the cascade. If
    // the subject is missing, the referrer is an orphan and is reached
    // via delete-orphaned-images (symmetric with how orphaned sha256-*
    // fallback tags work).
    for (const referrers of subjectReferrers.values()) {
      for (const referrerDigest of referrers) {
        digests.delete(referrerDigest)
      }
    }

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
