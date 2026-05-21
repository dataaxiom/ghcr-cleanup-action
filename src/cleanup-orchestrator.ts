import * as core from '@actions/core'
import { Config } from './config.js'
import { Registry } from './registry.js'
import { PackageRepo } from './package-repo.js'
import { OctokitClient } from './octokit-client.js'
import { CleanupTaskStatistics } from './utils.js'
import { ImageFilter } from './image-filter.js'
import { ManifestAnalyzer } from './manifest-analyzer.js'
import { ImageValidator } from './image-validator.js'
import { DeletionStrategy } from './deletion-strategy.js'
import { ImageDeleter } from './image-deleter.js'
import { CleanupContext } from './cleanup-types.js'
import { ManifestCache } from './manifest-cache.js'

/**
 * Orchestrates the cleanup process using modular components
 */
export class CleanupOrchestrator {
  private config: Config
  private targetPackage: string
  private octokitClient: OctokitClient
  private packageRepo: PackageRepo
  private registry: Registry
  private context: CleanupContext
  private manifestCache: ManifestCache | null

  // Modules
  private imageFilter: ImageFilter
  private manifestAnalyzer: ManifestAnalyzer
  private imageValidator: ImageValidator
  private deletionStrategy: DeletionStrategy
  private imageDeleter: ImageDeleter | null = null

  // State
  private filterSet = new Set<string>()
  private deleteSet = new Set<string>()
  private excludeTags: string[] = []
  private digestUsedBy = new Map<string, Set<string>>()
  private subjectReferrers = new Map<string, Set<string>>()
  private statistics: CleanupTaskStatistics

  constructor(
    config: Config,
    targetPackage: string,
    octokitClient: OctokitClient,
    manifestCache: ManifestCache | null = null
  ) {
    this.config = config
    this.targetPackage = targetPackage
    this.octokitClient = octokitClient
    this.manifestCache = manifestCache
    this.packageRepo = new PackageRepo(config, octokitClient)
    this.registry = new Registry(config, this.packageRepo, manifestCache)
    this.statistics = new CleanupTaskStatistics(targetPackage, 0, 0)

    // Create context for modules
    this.context = {
      config,
      registry: this.registry,
      packageRepo: this.packageRepo,
      targetPackage
    }

    // Initialize modules
    this.imageFilter = new ImageFilter(this.context)
    this.manifestAnalyzer = new ManifestAnalyzer(this.context)
    this.imageValidator = new ImageValidator(this.context)
    this.deletionStrategy = new DeletionStrategy(this.context)
  }

  async init(): Promise<void> {
    await this.registry.login(this.targetPackage)
  }

  async reload(): Promise<void> {
    this.deleteSet.clear()

    // Prime the list of current packages. The afterLoad callback runs
    // inside the "[Loaded package data]" log group, so the manifest-
    // cache prune's diagnostic line lands inside that group rather than
    // floating alone above subsequent groups.
    //
    // The prune itself: drop cached manifest entries whose digests no
    // longer exist in the package list. Without this, the cross-run
    // cache accumulates entries for deleted packages forever — they'll
    // never come back (digests are content-addressed) so they're pure
    // bloat.
    await this.packageRepo.loadPackages(this.targetPackage, true, () => {
      this.manifestCache?.prune(this.packageRepo.getDigests())
    })

    // Build digestUsedBy + subjectReferrers maps in one pass
    const analysis = await this.manifestAnalyzer.loadDigestUsedByMap()
    this.digestUsedBy = analysis.digestUsedBy
    this.subjectReferrers = analysis.subjectReferrers

    // Initialize imageDeleter with both relationship maps
    this.imageDeleter = new ImageDeleter(
      this.context,
      this.digestUsedBy,
      this.subjectReferrers
    )

    // Initialize filterSet - remove manifest image children, referrers etc
    this.filterSet = await this.manifestAnalyzer.initFilterSet(
      this.subjectReferrers
    )

    // Apply exclusion filters
    this.excludeTags = this.imageFilter.applyExclusionFilters(this.filterSet)

    // Apply age filter
    this.imageFilter.applyAgeFilter(this.filterSet)
  }

  async run(): Promise<CleanupTaskStatistics> {
    // Process tag deletions first - to support untagging
    if (this.config.deleteTags) {
      const plan = await this.deletionStrategy.processTagDeletions(
        this.filterSet,
        this.excludeTags
      )

      // When keep-n-tagged is set, gate the untag operations: any image that
      // keep-n-tagged would protect must not be partially untagged here.
      // Otherwise multi-tagged images in the keep set get a matched tag
      // stripped before keep-n-tagged runs, defeating its protection.
      if (this.config.keepNtagged != null && plan.untagOperations.size > 0) {
        const keepSet = this.deletionStrategy.computeKeepNTaggedDigests(
          this.filterSet
        )
        for (const digest of keepSet) {
          plan.untagOperations.delete(digest)
        }
      }

      // Perform untagging if needed
      let reloadOccurred = false
      if (plan.untagOperations.size > 0) {
        if (!this.imageDeleter) {
          throw new Error(
            'CleanupOrchestrator.run() invariant: imageDeleter is not initialized — reload() must be called before run()'
          )
        }
        const reloadNeeded = await this.imageDeleter.performUntagging(
          plan.untagOperations
        )
        if (reloadNeeded) {
          core.info('Reloading action due to untagging')
          await this.reload()
          reloadOccurred = true
        }
      }

      // Only process the original plan if we didn't reload
      // If we reloaded, we need to re-process tag deletions
      if (!reloadOccurred) {
        for (const digest of plan.deleteSet) {
          this.deleteSet.add(digest)
        }
      } else {
        // After reload, re-process tag deletions to pick up images
        // whose deletion candidacy depended on tags that survived the
        // first pass (e.g. multi-tagged images whose untag was gated
        // out by keep-n-tagged — their other tags are still present
        // and may now resolve to a delete-set entry).
        //
        // We only ingest newPlan.deleteSet — newPlan.untagOperations
        // is intentionally dropped. When keep-n-tagged gates a
        // multi-tagged image out of the first pass's untag list, that
        // image still has the matched tag after reload, so the second
        // pass re-derives the same untag operation. Re-running it
        // would defeat the keep-n-tagged protection that filtered it
        // out in the first place — re-applying the gate here would
        // simply remove the same entry again. Skipping the work is
        // equivalent and avoids a redundant gate computation.
        const newPlan = await this.deletionStrategy.processTagDeletions(
          this.filterSet,
          this.excludeTags
        )
        for (const digest of newPlan.deleteSet) {
          this.deleteSet.add(digest)
        }
      }
    }

    // Process ghost/partial/orphaned images
    if (this.config.deletePartialImages) {
      const partialImages = await this.imageValidator.findPartialImages(
        this.filterSet
      )
      for (const digest of partialImages) {
        this.deleteSet.add(digest)
        this.filterSet.delete(digest)
      }
    } else if (this.config.deleteGhostImages) {
      const ghostImages = await this.imageValidator.findGhostImages(
        this.filterSet
      )
      for (const digest of ghostImages) {
        this.deleteSet.add(digest)
        this.filterSet.delete(digest)
      }
    }

    if (this.config.deleteOrphanedImages) {
      const orphanedImages = this.imageValidator.findOrphanedImages(
        this.subjectReferrers
      )
      for (const digest of orphanedImages) {
        this.deleteSet.add(digest)
        this.filterSet.delete(digest)
      }
    }

    // Process keep-n policies
    if (this.config.keepNtagged != null) {
      const toDelete = this.deletionStrategy.keepNTagged(this.filterSet)
      for (const digest of toDelete) {
        this.deleteSet.add(digest)
      }
    }

    if (this.config.keepNuntagged != null) {
      const toDelete = this.deletionStrategy.keepNUntagged(this.filterSet)
      for (const digest of toDelete) {
        this.deleteSet.add(digest)
      }
    } else if (this.config.deleteUntagged) {
      const toDelete = this.deletionStrategy.deleteAllUntagged(this.filterSet)
      for (const digest of toDelete) {
        this.deleteSet.add(digest)
      }
    }

    // Perform the actual deletion
    if (!this.imageDeleter) {
      throw new Error(
        'CleanupOrchestrator.run() invariant: imageDeleter is not initialized — reload() must be called before run()'
      )
    }
    // The afterDelete hook fires inside the "Deleting packages" log
    // group so the "pruned N stale entries" line lands under the same
    // collapsible section as the deletes that caused it. Reload-time
    // prune only saw pre-deletion state; without this, a run that
    // deleted 5000 packages would persist 5000 dead entries until the
    // next run's reload prune caught them.
    const result = await this.imageDeleter.deleteImages(
      this.deleteSet,
      deleted => {
        if (this.manifestCache && deleted.size > 0) {
          const stillAlive = new Set(this.packageRepo.getDigests())
          for (const digest of deleted) {
            stillAlive.delete(digest)
          }
          this.manifestCache.prune(stillAlive)
        }
      }
    )
    this.statistics.numberImagesDeleted = result.numberImagesDeleted
    this.statistics.numberMultiImagesDeleted = result.numberMultiImagesDeleted

    // Print statistics
    this.statistics.print()

    // Run validation if requested
    if (this.config.validate) {
      core.info(` [${this.targetPackage}] Running Validation Task `)
      await this.reload()
      await this.imageValidator.validate(this.subjectReferrers)
      core.info('')
    }

    return this.statistics
  }
}
