import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import { CleanupOrchestrator } from '../cleanup-orchestrator'
import { Config } from '../config'
import { OctokitClient } from '../octokit-client'
import { Registry } from '../registry'
import { PackageRepo } from '../package-repo'
import { ImageFilter } from '../image-filter'
import { ManifestAnalyzer } from '../manifest-analyzer'
import { ImageValidator } from '../image-validator'
import { DeletionStrategy } from '../deletion-strategy'
import { ImageDeleter } from '../image-deleter'
import { CleanupTaskStatistics } from '../utils'

vi.mock('@actions/core')
vi.mock('../registry')
vi.mock('../package-repo')
vi.mock('../image-filter')
vi.mock('../manifest-analyzer')
vi.mock('../image-validator')
vi.mock('../deletion-strategy')
vi.mock('../image-deleter')
vi.mock('../utils')

describe('CleanupOrchestrator', () => {
  let config: Config
  let octokitClient: OctokitClient
  let orchestrator: CleanupOrchestrator
  let mockRegistry: vi.Mocked<Registry>
  let mockPackageRepo: vi.Mocked<PackageRepo>
  let mockImageFilter: vi.Mocked<ImageFilter>
  let mockManifestAnalyzer: vi.Mocked<ManifestAnalyzer>
  let mockImageValidator: vi.Mocked<ImageValidator>
  let mockDeletionStrategy: vi.Mocked<DeletionStrategy>
  let mockImageDeleter: vi.Mocked<ImageDeleter>

  beforeEach(() => {
    vi.clearAllMocks()

    config = {
      deleteTags: '',
      deleteTagsRegex: [],
      excludeTags: '',
      excludeTagsRegex: [],
      olderThanDays: 0,
      olderThan: null,
      olderThanReadable: null,
      expandPackages: false,
      packageQueryLimit: 100,
      deletePartialImages: false,
      deleteGhostImages: false,
      deleteOrphanedImages: false,
      deleteUntagged: false,
      keepNtagged: null,
      keepNuntagged: null,
      validate: false,
      missingManifestAction: 'keep',
      dryRun: false,
      verboseMode: false,
      skipChildManifests: false,
      isPrivateRepo: false,
      repoType: 'Container',
      owner: 'test-owner',
      repository: 'test-repo',
      token: 'test-token',
      useRegex: false
    } as Config

    octokitClient = {} as OctokitClient

    // Mock Registry
    mockRegistry = {
      login: vi.fn().mockResolvedValue(undefined)
    } as any
    vi.mocked(Registry).mockImplementation(() => mockRegistry)

    // Mock PackageRepo
    mockPackageRepo = {
      loadPackages: vi.fn().mockResolvedValue(undefined)
    } as any
    vi.mocked(PackageRepo).mockImplementation(() => mockPackageRepo)

    // Mock ImageFilter
    mockImageFilter = {
      applyExclusionFilters: vi.fn().mockReturnValue([]),
      applyAgeFilter: vi.fn()
    } as any
    vi.mocked(ImageFilter).mockImplementation(() => mockImageFilter)

    // Mock ManifestAnalyzer
    mockManifestAnalyzer = {
      loadDigestUsedByMap: vi.fn().mockResolvedValue(new Map()),
      initFilterSet: vi.fn().mockResolvedValue(new Set())
    } as any
    vi.mocked(ManifestAnalyzer).mockImplementation(() => mockManifestAnalyzer)

    // Mock ImageValidator
    mockImageValidator = {
      findPartialImages: vi.fn().mockResolvedValue(new Set()),
      findGhostImages: vi.fn().mockResolvedValue(new Set()),
      findOrphanedImages: vi.fn().mockReturnValue(new Set()),
      validate: vi.fn().mockResolvedValue(undefined)
    } as any
    vi.mocked(ImageValidator).mockImplementation(() => mockImageValidator)

    // Mock DeletionStrategy
    mockDeletionStrategy = {
      processTagDeletions: vi.fn().mockResolvedValue({
        deleteSet: new Set(),
        untagOperations: new Map()
      }),
      keepNTagged: vi.fn().mockReturnValue(new Set()),
      keepNUntagged: vi.fn().mockReturnValue(new Set()),
      deleteAllUntagged: vi.fn().mockReturnValue(new Set())
    } as any
    vi.mocked(DeletionStrategy).mockImplementation(() => mockDeletionStrategy)

    // Mock ImageDeleter
    mockImageDeleter = {
      performUntagging: vi.fn().mockResolvedValue(false),
      deleteImages: vi.fn().mockResolvedValue({
        numberImagesDeleted: 0,
        numberMultiImagesDeleted: 0
      })
    } as any
    vi.mocked(ImageDeleter).mockImplementation(() => mockImageDeleter)

    // Mock CleanupTaskStatistics
    const mockStats = {
      print: vi.fn(),
      numberImagesDeleted: 0,
      numberMultiImagesDeleted: 0
    }
    vi.mocked(CleanupTaskStatistics).mockImplementation(() => mockStats as any)

    orchestrator = new CleanupOrchestrator(
      config,
      'test-package',
      octokitClient
    )
  })

  describe('constructor', () => {
    it('should initialize all modules correctly', () => {
      expect(Registry).toHaveBeenCalled()
      expect(Registry).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          loadPackages: expect.any(Function)
        })
      )
      expect(PackageRepo).toHaveBeenCalledWith(config, octokitClient)
      expect(ImageFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          registry: mockRegistry,
          packageRepo: mockPackageRepo,
          targetPackage: 'test-package'
        })
      )
      expect(ManifestAnalyzer).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          registry: mockRegistry,
          packageRepo: mockPackageRepo,
          targetPackage: 'test-package'
        })
      )
      expect(ImageValidator).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          registry: mockRegistry,
          packageRepo: mockPackageRepo,
          targetPackage: 'test-package'
        })
      )
      expect(DeletionStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          registry: mockRegistry,
          packageRepo: mockPackageRepo,
          targetPackage: 'test-package'
        })
      )
    })
  })

  describe('init', () => {
    it('should login to registry', async () => {
      await orchestrator.init()
      expect(mockRegistry.login).toHaveBeenCalledWith('test-package')
    })
  })

  describe('reload', () => {
    it('should reload packages and initialize filter sets', async () => {
      const digestMap = new Map([['digest1', new Set(['tag1'])]])
      const filterSet = new Set(['image1', 'image2'])

      mockManifestAnalyzer.loadDigestUsedByMap.mockResolvedValue(digestMap)
      mockManifestAnalyzer.initFilterSet.mockResolvedValue(filterSet)
      mockImageFilter.applyExclusionFilters.mockReturnValue(['excluded1'])

      await orchestrator.reload()

      expect(mockPackageRepo.loadPackages).toHaveBeenCalledWith(
        'test-package',
        true
      )
      expect(mockManifestAnalyzer.loadDigestUsedByMap).toHaveBeenCalled()
      expect(mockManifestAnalyzer.initFilterSet).toHaveBeenCalled()
      expect(mockImageFilter.applyExclusionFilters).toHaveBeenCalledWith(
        filterSet
      )
      expect(mockImageFilter.applyAgeFilter).toHaveBeenCalledWith(filterSet)
      expect(ImageDeleter).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          registry: mockRegistry,
          packageRepo: mockPackageRepo,
          targetPackage: 'test-package'
        }),
        digestMap
      )
    })
  })

  describe('run', () => {
    beforeEach(async () => {
      await orchestrator.reload()
    })

    it('should process tag deletions when deleteTags is configured', async () => {
      config.deleteTags = 'tag1,tag2'
      const deleteSet = new Set(['digest1', 'digest2'])
      mockDeletionStrategy.processTagDeletions.mockResolvedValue({
        deleteSet,
        untagOperations: new Map()
      })

      const stats = await orchestrator.run()

      expect(mockDeletionStrategy.processTagDeletions).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(deleteSet)
      expect(stats).toBeDefined()
    })

    it('should handle untagging operations with reload', async () => {
      config.deleteTags = 'tag1'
      const untagOps = new Map([['digest1', ['tag1']]])
      mockDeletionStrategy.processTagDeletions
        .mockResolvedValueOnce({
          deleteSet: new Set(),
          untagOperations: untagOps
        })
        .mockResolvedValueOnce({
          deleteSet: new Set(['digest1']),
          untagOperations: new Map()
        })

      mockImageDeleter.performUntagging.mockResolvedValue(true)

      await orchestrator.run()

      expect(mockImageDeleter.performUntagging).toHaveBeenCalledWith(untagOps)
      expect(core.info).toHaveBeenCalledWith(
        'Reloading action due to untagging'
      )
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(2)
      expect(mockDeletionStrategy.processTagDeletions).toHaveBeenCalledTimes(2)
    })

    it('should process partial images when deletePartialImages is true', async () => {
      config.deletePartialImages = true
      const partialImages = new Set(['partial1', 'partial2'])
      mockImageValidator.findPartialImages.mockResolvedValue(partialImages)

      await orchestrator.run()

      expect(mockImageValidator.findPartialImages).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(partialImages)
    })

    it('should process ghost images when deleteGhostImages is true', async () => {
      config.deleteGhostImages = true
      const ghostImages = new Set(['ghost1', 'ghost2'])
      mockImageValidator.findGhostImages.mockResolvedValue(ghostImages)

      await orchestrator.run()

      expect(mockImageValidator.findGhostImages).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(ghostImages)
    })

    it('should process orphaned images when deleteOrphanedImages is true', async () => {
      config.deleteOrphanedImages = true
      const orphanedImages = new Set(['orphan1', 'orphan2'])
      mockImageValidator.findOrphanedImages.mockReturnValue(orphanedImages)

      await orchestrator.run()

      expect(mockImageValidator.findOrphanedImages).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(orphanedImages)
    })

    it('should apply keepNtagged policy', async () => {
      config.keepNtagged = 5
      const toDelete = new Set(['old1', 'old2'])
      mockDeletionStrategy.keepNTagged.mockReturnValue(toDelete)

      await orchestrator.run()

      expect(mockDeletionStrategy.keepNTagged).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(toDelete)
    })

    it('should apply keepNuntagged policy', async () => {
      config.keepNuntagged = 3
      const toDelete = new Set(['untagged1', 'untagged2'])
      mockDeletionStrategy.keepNUntagged.mockReturnValue(toDelete)

      await orchestrator.run()

      expect(mockDeletionStrategy.keepNUntagged).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(toDelete)
    })

    it('should delete all untagged when deleteUntagged is true', async () => {
      config.deleteUntagged = true
      const toDelete = new Set(['untagged1', 'untagged2', 'untagged3'])
      mockDeletionStrategy.deleteAllUntagged.mockReturnValue(toDelete)

      await orchestrator.run()

      expect(mockDeletionStrategy.deleteAllUntagged).toHaveBeenCalled()
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(toDelete)
    })

    it('should run validation when validate is true', async () => {
      config.validate = true

      await orchestrator.run()

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Running Validation Task')
      )
      expect(mockImageValidator.validate).toHaveBeenCalled()
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(2)
    })

    it('should combine multiple deletion strategies', async () => {
      config.deleteTags = 'old'
      config.deleteUntagged = true
      config.deleteGhostImages = true

      const tagDeleteSet = new Set(['tag-delete1'])
      const untaggedSet = new Set(['untagged1'])
      const ghostSet = new Set(['ghost1'])

      mockDeletionStrategy.processTagDeletions.mockResolvedValue({
        deleteSet: tagDeleteSet,
        untagOperations: new Map()
      })
      mockDeletionStrategy.deleteAllUntagged.mockReturnValue(untaggedSet)
      mockImageValidator.findGhostImages.mockResolvedValue(ghostSet)

      await orchestrator.run()

      const expectedDeleteSet = new Set(['tag-delete1', 'untagged1', 'ghost1'])
      expect(mockImageDeleter.deleteImages).toHaveBeenCalledWith(
        expectedDeleteSet
      )
    })

    it('should update statistics with deletion results', async () => {
      const deleteResult = {
        deleted: new Set<string>(),
        numberImagesDeleted: 5,
        numberMultiImagesDeleted: 2
      }
      mockImageDeleter.deleteImages.mockResolvedValue(deleteResult)

      const stats = await orchestrator.run()

      expect(stats.numberImagesDeleted).toBe(5)
      expect(stats.numberMultiImagesDeleted).toBe(2)
    })
  })
})
