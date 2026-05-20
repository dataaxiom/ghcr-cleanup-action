import * as core from '@actions/core'
import { LogLevel } from './config.js'
import { CleanupContext } from './cleanup-types.js'
import { ManifestEntry, runWithConcurrency } from './utils.js'

// Concurrency cap for parallel registry manifest fetches. Registry traffic
// goes to ghcr.io (separate rate budget from api.github.com) and the axios
// client retries 429s, so a modest fan-out is safe. Conservative default —
// can be lifted if real workloads ask for more.
const MANIFEST_FETCH_CONCURRENCY = 10

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
    const digests = this.context.packageRepo.getDigests()
    const digestCount = digests.size
    const digestList = Array.from(digests)
    let processed = 0
    let lastReportMs = Date.now()

    // Fan out the per-digest manifest fetches. The previous implementation
    // skipped re-fetching digests already seen as children of a parent
    // index; we drop that optimization here because (1) the cross-run
    // distilled cache makes those fetches free on warm runs, and (2) the
    // sequential dependency the skip required prevents parallelism, which
    // is the bigger win. Children of multi-arch indexes still register
    // their parent links correctly — the outer iteration visits every
    // digest exactly once.
    core.startGroup(`[${this.context.targetPackage}] Loading manifests`)
    await runWithConcurrency(
      digestList,
      MANIFEST_FETCH_CONCURRENCY,
      async digest => {
        const manifest = await this.context.registry.getManifestByDigest(digest)
        // JS Maps are single-thread-safe — mutating shared maps from
        // multiple awaited workers is fine.
        if (manifest.manifests) {
          for (const imageManifest of manifest.manifests) {
            if (digests.has(imageManifest.digest)) {
              let parents = digestUsedBy.get(imageManifest.digest)
              if (!parents) {
                parents = new Set<string>()
                digestUsedBy.set(imageManifest.digest, parents)
              }
              parents.add(digest)
            }
          }
        }

        // OCI 1.1 subject-bearing referrer (sigstore bundle, etc). ghcr.io
        // does not implement the /referrers API but echoes the subject
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

        processed++
        if (this.context.config.logLevel === LogLevel.DEBUG) {
          const encoded = JSON.stringify(manifest, null, 4)
          core.info(`${digest}:${encoded}`)
        } else {
          const now = Date.now()
          if (now - lastReportMs >= 3000) {
            lastReportMs = now
            core.info(`loaded ${processed} of ${digestCount} manifests`)
          }
        }
      }
    )
    core.info(`loaded ${processed} manifests`)
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

      // Process any associated images tagged with `sha256-<digest>.*`
      // via the pre-built reverse index — O(1) lookup instead of an
      // O(T) scan over every tag in the repo.
      const referrerTags =
        this.context.packageRepo.getReferrerTagsForDigest(digest)
      for (const tag of referrerTags) {
        const tagDigest = this.context.packageRepo.getDigestByTag(tag)
        if (tagDigest) {
          digests.delete(tagDigest)
          // Process any children
          const childManifest =
            await this.context.registry.getManifestByTag(tag)
          if (childManifest?.manifests) {
            for (const manifestEntry of childManifest.manifests) {
              digests.delete(manifestEntry.digest)
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
  async buildLabel(imageManifest: ManifestEntry): Promise<string> {
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
      // Process tagged digests (referrers) via the pre-built index.
      const referrerTags =
        this.context.packageRepo.getReferrerTagsForDigest(digest)
      for (const tag of referrerTags) {
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
