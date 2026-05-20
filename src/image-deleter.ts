import * as core from '@actions/core'
import { CleanupContext, DeletionResult } from './cleanup-types.js'
import { ManifestAnalyzer } from './manifest-analyzer.js'
import { GhPackage, Manifest, runWithConcurrency } from './utils.js'

// Concurrency for the parallel PUT + DELETE phases of performUntagging.
// Modest fan-out — ghcr.io accepts writes happily but writes are
// account-quota relevant.
const UNTAG_WRITE_CONCURRENCY = 5

export class ImageDeleter {
  private context: CleanupContext
  private manifestAnalyzer: ManifestAnalyzer
  private deleted: Set<string>
  private digestUsedBy: Map<string, Set<string>>
  private subjectReferrers: Map<string, Set<string>>

  constructor(
    context: CleanupContext,
    digestUsedBy: Map<string, Set<string>>,
    subjectReferrers: Map<string, Set<string>> = new Map()
  ) {
    this.context = context
    this.manifestAnalyzer = new ManifestAnalyzer(context)
    this.deleted = new Set<string>()
    this.digestUsedBy = digestUsedBy
    this.subjectReferrers = subjectReferrers
  }

  /**
   * Perform untagging operations.
   *
   * Strategy: each tag we want to strip gets a freshly-annotated empty
   * manifest PUT under it. The unique annotation (timestamp + tag name)
   * makes every PUT body byte-distinct, so every PUT lands as its own
   * package version with its own digest. We can then issue ONE
   * loadPackages to discover all the new version IDs, and batch the
   * deletes. This replaces an older per-tag PUT→reload→delete loop that
   * paid a full loadPackages round-trip per tag — catastrophic on large
   * repos where each reload is ~600 paginated API calls.
   */
  async performUntagging(
    untagOperations: Map<string, string[]>
  ): Promise<boolean> {
    if (untagOperations.size === 0) {
      return false
    }

    // Build the list of (digest, tag) pairs we will actually strip.
    // Honor the original "always leave at least one tag on the image"
    // invariant: if untagOperations asks for more tags than the image
    // has (-1), silently keep the remainder.
    interface UntagJob {
      manifestDigest: string
      tag: string
    }
    const jobs: UntagJob[] = []
    for (const [manifestDigest, tags] of untagOperations) {
      const ghPackage =
        this.context.packageRepo.getPackageByDigest(manifestDigest)
      if (!ghPackage) {
        throw new Error(
          `cache invariant: digest ${manifestDigest} not in package cache`
        )
      }
      const allowable = Math.max(
        0,
        ghPackage.metadata.container.tags.length - 1
      )
      for (let i = 0; i < tags.length && i < allowable; i++) {
        jobs.push({ manifestDigest, tag: tags[i] })
      }
    }

    if (jobs.length === 0) {
      return false
    }

    const allTags = jobs.map(j => j.tag)
    core.startGroup(
      `[${this.context.targetPackage}] Untagging images: ${allTags}`
    )

    // Stamp every PUT body uniquely so each lands as a distinct digest.
    // The timestamp resolves at submit time so the suffix is monotonic
    // and human-readable in `oci-inspect` output if anyone goes hunting.
    const stampPrefix = new Date().toISOString()

    // Pre-fetch each unique source manifest exactly once.
    // getRawManifestByDigest deliberately bypasses Registry's in-memory
    // cache (which may hold a reconstituted, field-incomplete entry
    // from the distilled disk cache) — so without this pre-fetch a
    // multi-tag untag on the same image would re-GET the full body once
    // per tag.
    const uniqueSourceDigests = Array.from(
      new Set(jobs.map(j => j.manifestDigest))
    )
    const rawManifestCache = new Map<string, Manifest>()
    await runWithConcurrency(
      uniqueSourceDigests,
      UNTAG_WRITE_CONCURRENCY,
      async digest => {
        rawManifestCache.set(
          digest,
          await this.context.registry.getRawManifestByDigest(digest)
        )
      }
    )

    await runWithConcurrency(
      jobs,
      UNTAG_WRITE_CONCURRENCY,
      async ({ manifestDigest, tag }) => {
        const manifest = rawManifestCache.get(manifestDigest)
        if (!manifest) {
          throw new Error(
            `untag invariant: missing raw manifest for ${manifestDigest}`
          )
        }

        // Deep clone, then strip content and stamp the annotation.
        const newManifest = JSON.parse(JSON.stringify(manifest))
        newManifest.annotations = {
          ...(newManifest.annotations || {}),
          'org.opencontainers.image.created': stampPrefix,
          'io.github.ghcr-cleanup-action.untag-source-tag': tag
        }

        const isMultiArch = !!newManifest.manifests
        if (isMultiArch) {
          newManifest.manifests = []
        } else {
          newManifest.layers = []
        }

        core.info(`${tag}`)
        await this.context.registry.putManifest(tag, newManifest, isMultiArch)
      }
    )

    // ONE reload to discover all newly-created empty versions in one
    // paginated sweep, instead of per-tag.
    await this.context.packageRepo.loadPackages(
      this.context.targetPackage,
      false
    )

    // Delete the newly-created empty versions in parallel.
    await runWithConcurrency(jobs, UNTAG_WRITE_CONCURRENCY, async ({ tag }) => {
      const untaggedDigest = this.context.packageRepo.getDigestByTag(tag)
      if (!untaggedDigest) {
        core.info(
          `couldn't find newly created package for tag ${tag} to delete`
        )
        return
      }
      const id = this.context.packageRepo.getIdByDigest(untaggedDigest)
      if (!id) {
        core.info(
          `couldn't find newly created package with digest ${untaggedDigest} to delete`
        )
        return
      }
      await this.context.packageRepo.deletePackageVersion(
        this.context.targetPackage,
        id,
        untaggedDigest,
        [tag]
      )
    })

    core.endGroup()
    return true
  }

  /**
   * Delete a single image and its children
   */
  async deleteImage(
    ghPackage: GhPackage
  ): Promise<{ deleted: number; multiDeleted: number }> {
    let imagesDeleted = 0
    let multiImagesDeleted = 0

    if (this.deleted.has(ghPackage.name)) {
      return { deleted: imagesDeleted, multiDeleted: multiImagesDeleted }
    }

    // Get the manifest first
    const manifest = await this.context.registry.getManifestByDigest(
      ghPackage.name
    )

    // Delete the package
    await this.context.packageRepo.deletePackageVersion(
      this.context.targetPackage,
      ghPackage.id,
      ghPackage.name,
      ghPackage.metadata.container.tags
    )
    this.deleted.add(ghPackage.name)
    imagesDeleted += 1

    // If manifests based image, delete children
    if (manifest.manifests) {
      multiImagesDeleted += 1
      for (const imageManifest of manifest.manifests) {
        const manifestPackage = this.context.packageRepo.getPackageByDigest(
          imageManifest.digest
        )
        if (manifestPackage && !this.deleted.has(manifestPackage.name)) {
          const parents = this.digestUsedBy.get(manifestPackage.name)
          if (parents) {
            if (parents.size === 1 && parents.has(ghPackage.name)) {
              // Only referenced from this image
              await this.context.packageRepo.deletePackageVersion(
                this.context.targetPackage,
                manifestPackage.id,
                manifestPackage.name,
                [],
                await this.manifestAnalyzer.buildLabel(imageManifest)
              )
              this.deleted.add(manifestPackage.name)
              imagesDeleted += 1
              this.digestUsedBy.delete(manifestPackage.name)
            } else {
              core.info(
                ` skipping package id: ${manifestPackage.id} digest: ${manifestPackage.name} as it's in use by another image`
              )
              parents.delete(ghPackage.name)
            }
          }
        }
      }
    }

    // Process referrers/cosign (sha256-* tagged fallback shape) via the
    // pre-built reverse index — O(1) lookup instead of scanning every
    // tag in the repo for every digest we delete.
    const referrerTags = this.context.packageRepo.getReferrerTagsForDigest(
      ghPackage.name
    )
    for (const tag of referrerTags) {
      const manifestDigest = this.context.packageRepo.getDigestByTag(tag)
      if (manifestDigest) {
        const attestationPackage =
          this.context.packageRepo.getPackageByDigest(manifestDigest)
        if (attestationPackage) {
          const result = await this.deleteImage(attestationPackage)
          imagesDeleted += result.deleted
          multiImagesDeleted += result.multiDeleted
        }
      }
    }

    // Cascade OCI 1.1 subject-bearing referrers. ghcr.io doesn't tag these
    // with a sha256-* fallback when the publisher uses --registry-referrers-
    // mode oci-1-1 (or equivalent), so we follow the reverse index built by
    // ManifestAnalyzer.
    const referrers = this.subjectReferrers.get(ghPackage.name)
    if (referrers) {
      for (const referrerDigest of referrers) {
        if (this.deleted.has(referrerDigest)) {
          continue
        }
        const referrerPackage =
          this.context.packageRepo.getPackageByDigest(referrerDigest)
        if (referrerPackage) {
          const result = await this.deleteImage(referrerPackage)
          imagesDeleted += result.deleted
          multiImagesDeleted += result.multiDeleted
        }
      }
    }

    return { deleted: imagesDeleted, multiDeleted: multiImagesDeleted }
  }

  /**
   * Delete all images in the delete set
   * @param deleteSet digests to delete
   * @param afterDelete optional hook that runs INSIDE the "Deleting
   *   packages" log group after the deletes finish but before the group
   *   closes — lets callers (the orchestrator) emit related log lines
   *   under the same group instead of having them dangle afterward.
   */
  async deleteImages(
    deleteSet: Set<string>,
    afterDelete?: (deleted: Set<string>) => void
  ): Promise<DeletionResult> {
    // Prime manifests
    await this.manifestAnalyzer.primeManifests(deleteSet)

    core.startGroup(`[${this.context.targetPackage}] Deleting packages`)

    let totalDeleted = 0
    let totalMultiDeleted = 0

    if (deleteSet.size > 0) {
      for (const deleteDigest of deleteSet) {
        const deleteImage =
          this.context.packageRepo.getPackageByDigest(deleteDigest)
        if (!deleteImage) {
          throw new Error(
            `cache invariant: digest ${deleteDigest} not in package cache`
          )
        }
        const result = await this.deleteImage(deleteImage)
        totalDeleted += result.deleted
        totalMultiDeleted += result.multiDeleted
      }
    } else {
      core.info(`Nothing to delete`)
    }

    if (afterDelete) {
      afterDelete(this.deleted)
    }

    core.endGroup()

    return {
      deleted: this.deleted,
      numberImagesDeleted: totalDeleted,
      numberMultiImagesDeleted: totalMultiDeleted
    }
  }
}
