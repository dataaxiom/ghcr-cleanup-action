import * as core from '@actions/core'
import { Config } from './config.js'
import { Registry } from './registry.js'
import { PackageRepo } from './package-repo.js'
import { CleanupTaskStatistics } from './utils.js'
import { ImageFilter } from './image-filter.js'
import { ManifestAnalyzer } from './manifest-analyzer.js'
import { ImageValidator } from './image-validator.js'
import { DeletionStrategy } from './deletion-strategy.js'
import { ImageDeleter } from './image-deleter.js'
import { CleanupContext } from './cleanup-types.js'

/**
 * Orchestrates the cleanup process using modular components
 */
export class CleanupOrchestrator {
  private config: Config
  private targetPackage: string
  private packageRepo: PackageRepo
  private registry: Registry
  private context: CleanupContext

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
  private statistics: CleanupTaskStatistics

  constructor(config: Config, targetPackage: string) {
    this.config = config
    this.targetPackage = targetPackage
    this.packageRepo = new PackageRepo(config)
    this.registry = new Registry(config, this.packageRepo)
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

    // Prime the list of current packages
    await this.packageRepo.loadPackages(this.targetPackage, true)

    // Build digestUsedBy map
    this.digestUsedBy = await this.manifestAnalyzer.loadDigestUsedByMap()

    // Initialize imageDeleter with the digestUsedBy map
    this.imageDeleter = new ImageDeleter(this.context, this.digestUsedBy)

    // Initialize filterSet - remove manifest image children, referrers etc
    this.filterSet = await this.manifestAnalyzer.initFilterSet()

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

      // Perform untagging if needed
      let reloadOccurred = false
      if (plan.untagOperations.size > 0 && this.imageDeleter) {
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
        // After reload, process all tag deletions again
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
      const orphanedImages = this.imageValidator.findOrphanedImages()
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
    if (this.imageDeleter) {
      const result = await this.imageDeleter.deleteImages(this.deleteSet)
      this.statistics.numberImagesDeleted = result.numberImagesDeleted
      this.statistics.numberMultiImagesDeleted = result.numberMultiImagesDeleted
    }

    // Print statistics
    this.statistics.print()

    // Run validation if requested
    if (this.config.validate) {
      core.info(` [${this.targetPackage}] Running Validation Task `)
      await this.reload()
      await this.imageValidator.validate()
      core.info('')
    }

    return this.statistics
  }
}
