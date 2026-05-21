import * as core from '@actions/core'
import { CleanupContext, DeletionResult } from './cleanup-types.js'
import { ManifestAnalyzer } from './manifest-analyzer.js'
import {
  BufferedLogger,
  consoleLogger,
  GhPackage,
  Logger,
  Manifest,
  ManifestEntry,
  runWithConcurrency
} from './utils.js'

// Concurrency for the parallel PUT + DELETE phases of performUntagging.
// Modest fan-out — ghcr.io accepts writes happily but writes are
// account-quota relevant.
const UNTAG_WRITE_CONCURRENCY = 5

// Concurrency for child/referrer deletes spawned by a single deleteImage
// call. The top-level deleteImages loop stays sequential — failures while
// processing one parent shouldn't leave a wide trail of partial deletes
// across the repo. Inside a single parent the failure profile is already
// "parent gone, children may remain" (children run after the parent),
// so fanning out the children doesn't introduce a new corruption mode;
// it just makes the existing one happen faster. 5 keeps us well under
// the Packages API's secondary rate limit on a typical 4-platform image
// plus its sigstore attestation.
const CHILD_DELETE_CONCURRENCY = 5

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
   * Delete a single image and its children.
   *
   * Order is parent-first, then children. Same as the previous serial
   * implementation — keeps the failure profile of "parent gone, some
   * children may remain" rather than introducing the worse "children
   * gone, parent intact" profile. Children fan out with bounded
   * concurrency ({@link CHILD_DELETE_CONCURRENCY}) inside this method;
   * the calling deleteImages loop stays sequential at the top level.
   *
   * The `logger` is threaded through every log call (this method's own
   * "skipping" lines, the underlying packageRepo.deletePackageVersion,
   * and recursive sub-deleteImage calls for referrers). The top-level
   * deleteImages loop hands each invocation a {@link BufferedLogger}
   * and flushes after the whole tree completes, so a parent and its
   * descendants emit as one contiguous block in the workflow log
   * instead of interleaving with sibling parents' children.
   */
  async deleteImage(
    ghPackage: GhPackage,
    logger: Logger = consoleLogger
  ): Promise<{ deleted: number; multiDeleted: number }> {
    if (this.deleted.has(ghPackage.name)) {
      return { deleted: 0, multiDeleted: 0 }
    }

    const manifest = await this.context.registry.getManifestByDigest(
      ghPackage.name
    )

    await this.context.packageRepo.deletePackageVersion(
      this.context.targetPackage,
      ghPackage.id,
      ghPackage.name,
      ghPackage.metadata.container.tags,
      undefined,
      logger
    )
    this.deleted.add(ghPackage.name)
    let imagesDeleted = 1
    let multiImagesDeleted = 0

    // Collect child-delete jobs from three sources (multi-arch platforms,
    // sha256-* fallback referrers, OCI 1.1 subject referrers) and run
    // them under a single shared concurrency budget. Mutations on the
    // shared maps (this.deleted, this.digestUsedBy, parents sets) are
    // safe to interleave because Map/Set ops are atomic between awaits
    // and each job either touches its own keys or applies an idempotent
    // delete that other jobs would also have produced.
    const childJobs: Array<
      () => Promise<{ deleted: number; multiDeleted: number }>
    > = []

    if (manifest.manifests) {
      multiImagesDeleted += 1
      for (const imageManifest of manifest.manifests) {
        childJobs.push(
          async () =>
            await this.deletePlatformChild(ghPackage, imageManifest, logger)
        )
      }
    }

    // sha256-* fallback referrer tags (cosign default, attestations).
    // Pre-built reverse index — O(1) lookup instead of scanning every
    // tag in the repo for every digest we delete.
    const referrerTags = this.context.packageRepo.getReferrerTagsForDigest(
      ghPackage.name
    )
    for (const tag of referrerTags) {
      childJobs.push(async () => await this.deleteReferrerByTag(tag, logger))
    }

    // OCI 1.1 subject-bearing referrers. ghcr.io doesn't tag these with a
    // sha256-* fallback when the publisher uses --registry-referrers-mode
    // oci-1-1 (or equivalent), so we follow the reverse index built by
    // ManifestAnalyzer.
    const referrers = this.subjectReferrers.get(ghPackage.name)
    if (referrers) {
      for (const referrerDigest of referrers) {
        childJobs.push(
          async () => await this.deleteReferrerByDigest(referrerDigest, logger)
        )
      }
    }

    await runWithConcurrency(childJobs, CHILD_DELETE_CONCURRENCY, async job => {
      const result = await job()
      imagesDeleted += result.deleted
      multiImagesDeleted += result.multiDeleted
    })

    return { deleted: imagesDeleted, multiDeleted: multiImagesDeleted }
  }

  /**
   * Delete one entry from a multi-arch manifest's `manifests[]` array if
   * this parent is its only reference. If the child is shared with
   * another parent, log and decrement the parent set instead.
   */
  private async deletePlatformChild(
    parent: GhPackage,
    imageManifest: ManifestEntry,
    logger: Logger
  ): Promise<{ deleted: number; multiDeleted: number }> {
    const manifestPackage = this.context.packageRepo.getPackageByDigest(
      imageManifest.digest
    )
    if (!manifestPackage || this.deleted.has(manifestPackage.name)) {
      return { deleted: 0, multiDeleted: 0 }
    }
    const parents = this.digestUsedBy.get(manifestPackage.name)
    if (!parents) {
      return { deleted: 0, multiDeleted: 0 }
    }
    if (parents.size === 1 && parents.has(parent.name)) {
      await this.context.packageRepo.deletePackageVersion(
        this.context.targetPackage,
        manifestPackage.id,
        manifestPackage.name,
        [],
        await this.manifestAnalyzer.buildLabel(imageManifest),
        logger
      )
      this.deleted.add(manifestPackage.name)
      this.digestUsedBy.delete(manifestPackage.name)
      return { deleted: 1, multiDeleted: 0 }
    }
    logger.info(
      ` skipping package id: ${manifestPackage.id} digest: ${manifestPackage.name} as it's in use by another image`
    )
    parents.delete(parent.name)
    return { deleted: 0, multiDeleted: 0 }
  }

  /**
   * Resolve a sha256-* fallback referrer tag to its package and cascade.
   */
  private async deleteReferrerByTag(
    tag: string,
    logger: Logger
  ): Promise<{ deleted: number; multiDeleted: number }> {
    const manifestDigest = this.context.packageRepo.getDigestByTag(tag)
    if (!manifestDigest) return { deleted: 0, multiDeleted: 0 }
    const attestationPackage =
      this.context.packageRepo.getPackageByDigest(manifestDigest)
    if (!attestationPackage) return { deleted: 0, multiDeleted: 0 }
    return await this.deleteImage(attestationPackage, logger)
  }

  /**
   * Resolve an OCI 1.1 subject-bearing referrer digest and cascade.
   * Short-circuits when the referrer was already deleted via another
   * path (e.g. it also had a sha256-* fallback tag).
   */
  private async deleteReferrerByDigest(
    digest: string,
    logger: Logger
  ): Promise<{ deleted: number; multiDeleted: number }> {
    if (this.deleted.has(digest)) return { deleted: 0, multiDeleted: 0 }
    const referrerPackage = this.context.packageRepo.getPackageByDigest(digest)
    if (!referrerPackage) return { deleted: 0, multiDeleted: 0 }
    return await this.deleteImage(referrerPackage, logger)
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
        // Each top-level delete gets its own buffer. Child fan-out
        // inside deleteImage runs concurrently, so streaming straight
        // to core.info would interleave a parent's children with the
        // recursive sub-trees of its referrers. Buffering keeps the
        // unit (parent + all descendants) emitted as one contiguous
        // block in the workflow log. flush() runs only after the
        // whole tree resolves, so a thrown error mid-tree drops the
        // partial buffer — the user sees what completed, not a
        // half-written audit trail.
        const logger = new BufferedLogger()
        const result = await this.deleteImage(deleteImage, logger)
        logger.flush()
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
