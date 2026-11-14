import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest'
import * as core from '@actions/core'
import { DeletionStrategy } from '../deletion-strategy'
import { CleanupContext } from '../cleanup-types'
import { ImageFilter } from '../image-filter'

vi.mock('@actions/core')
vi.mock('../image-filter')

describe('DeletionStrategy', () => {
  let strategy: DeletionStrategy
  let context: CleanupContext
  let mockImageFilter: Mocked<ImageFilter>
  let mockPackageRepo: any
  let mockRegistry: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Create mock package repository
    mockPackageRepo = {
      getDigestByTag: vi.fn(),
      getPackageByDigest: vi.fn()
    }

    // Create mock registry
    mockRegistry = {}

    // Create context
    context = {
      config: {
        deleteTags: '',
        deleteTagsRegex: [],
        excludeTags: '',
        excludeTagsRegex: [],
        keepNtagged: null,
        keepNuntagged: null,
        deleteUntagged: false,
        useRegex: false
      } as any,
      registry: mockRegistry,
      packageRepo: mockPackageRepo,
      targetPackage: 'test-package'
    }

    // Create mock ImageFilter
    mockImageFilter = {
      expandTags: vi.fn().mockReturnValue(new Set())
    } as any
    vi.mocked(ImageFilter).mockImplementation(function () {
      return mockImageFilter
    } as any)

    strategy = new DeletionStrategy(context)
  })

  describe('processTagDeletions', () => {
    it('should return empty plan when deleteTags is not configured', async () => {
      context.config.deleteTags = ''

      const result = await strategy.processTagDeletions(new Set(), [])

      expect(result.deleteSet.size).toBe(0)
      expect(result.untagOperations.size).toBe(0)
    })

    it('should return empty plan when no matching tags found', async () => {
      context.config.deleteTags = 'v1.0'
      mockImageFilter.expandTags.mockReturnValue(new Set())

      const result = await strategy.processTagDeletions(new Set(), [])

      expect(result.deleteSet.size).toBe(0)
      expect(result.untagOperations.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no matching tags found')
    })

    it('warns once when keep-n-tagged leaves digest matches undeleted', async () => {
      // keep-n-tagged ranks images by tag, so bare-digest matches are never
      // deleted: say so (once, with a count) instead of dropping silently.
      context.config.deleteTags = 'sha256:*'
      context.config.keepNtagged = 2
      mockImageFilter.expandTags.mockReturnValue(
        new Set(['sha256:aaa', 'sha256:bbb', 'v1'])
      )
      // v1 resolves to sha256:aaa, so only sha256:bbb is ignored.
      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) =>
        tag === 'v1' ? 'sha256:aaa' : undefined
      )
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'sha256:aaa',
        metadata: { container: { tags: ['v1'] } }
      })

      await strategy.processTagDeletions(new Set(), [])
      await strategy.processTagDeletions(new Set(), [])

      expect(core.warning).toHaveBeenCalledTimes(1)
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringMatching(/matched 1 image digest\(s\).*sha256:bbb$/)
      )
    })

    it('does not warn about ignored digests without keep-n-tagged', async () => {
      context.config.deleteTags = 'sha256:*'
      context.config.keepNtagged = null
      mockImageFilter.expandTags.mockReturnValue(new Set(['sha256:bbb']))

      await strategy.processTagDeletions(new Set(), [])

      expect(core.warning).not.toHaveBeenCalled()
    })

    it('should handle single-tagged images for deletion', async () => {
      context.config.deleteTags = 'v1.0'
      context.config.keepNtagged = null
      const filterSet = new Set(['digest1', 'digest2'])
      mockImageFilter.expandTags.mockReturnValue(new Set(['v1.0']))
      mockPackageRepo.getDigestByTag.mockReturnValue('digest1')
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0'] } }
      })

      const result = await strategy.processTagDeletions(filterSet, [])

      expect(result.deleteSet).toContain('digest1')
      expect(result.untagOperations.size).toBe(0)
      expect(filterSet.has('digest1')).toBe(false)
    })

    it('should handle multi-tagged images for untagging', async () => {
      context.config.deleteTags = 'v1.0'
      const filterSet = new Set(['digest1'])
      mockImageFilter.expandTags.mockReturnValue(new Set(['v1.0']))
      mockPackageRepo.getDigestByTag.mockReturnValue('digest1')
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0', 'latest'] } }
      })

      const result = await strategy.processTagDeletions(filterSet, [])

      expect(result.deleteSet.size).toBe(0)
      expect(result.untagOperations.has('digest1')).toBe(true)
      expect(result.untagOperations.get('digest1')).toEqual(['v1.0'])
    })

    it('should skip excluded tags', async () => {
      context.config.deleteTags = 'v1.0,v2.0'
      context.config.keepNtagged = null
      const filterSet = new Set(['digest1', 'digest2'])
      const excludeTags = ['v1.0']
      mockImageFilter.expandTags.mockReturnValue(new Set(['v1.0', 'v2.0']))
      mockPackageRepo.getDigestByTag.mockImplementation(tag =>
        tag === 'v1.0' ? 'digest1' : 'digest2'
      )
      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        metadata: {
          container: { tags: [digest === 'digest1' ? 'v1.0' : 'v2.0'] }
        }
      }))

      const result = await strategy.processTagDeletions(filterSet, excludeTags)

      expect(result.deleteSet).toContain('digest2')
      expect(result.deleteSet).not.toContain('digest1')
    })

    it('should handle sha256 digests directly', async () => {
      context.config.deleteTags = 'sha256:abc123'
      context.config.keepNtagged = null
      const filterSet = new Set(['sha256:abc123'])
      mockImageFilter.expandTags.mockReturnValue(new Set(['sha256:abc123']))

      const result = await strategy.processTagDeletions(filterSet, [])

      expect(result.deleteSet).toContain('sha256:abc123')
      expect(filterSet.has('sha256:abc123')).toBe(false)
    })

    it('should not process deletions when keepNtagged is set', async () => {
      context.config.deleteTags = 'v1.0'
      context.config.keepNtagged = 5
      const filterSet = new Set(['digest1'])
      mockImageFilter.expandTags.mockReturnValue(new Set(['v1.0']))
      mockPackageRepo.getDigestByTag.mockReturnValue('digest1')
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0'] } }
      })

      const result = await strategy.processTagDeletions(filterSet, [])

      expect(result.deleteSet.size).toBe(0)
      expect(result.untagOperations.size).toBe(0)
    })
  })

  describe('keepNUntagged', () => {
    it('should return empty set when keepNuntagged is not configured', () => {
      context.config.keepNuntagged = null

      const result = strategy.keepNUntagged(new Set())

      expect(result.size).toBe(0)
    })

    it('should keep N newest untagged images', () => {
      context.config.keepNuntagged = 2
      const filterSet = new Set(['digest1', 'digest2', 'digest3', 'digest4'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: `2024-01-0${digest.slice(-1)}T00:00:00Z`,
        metadata: { container: { tags: [] } }
      }))

      const result = strategy.keepNUntagged(filterSet)

      expect(result.size).toBe(2)
      expect(result).toContain('digest1')
      expect(result).toContain('digest2')
      expect(filterSet.has('digest1')).toBe(false)
      expect(filterSet.has('digest2')).toBe(false)
      expect(filterSet.has('digest3')).toBe(true)
      expect(filterSet.has('digest4')).toBe(true)
    })

    it('should not delete when untagged count is less than keepN', () => {
      context.config.keepNuntagged = 5
      const filterSet = new Set(['digest1', 'digest2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: '2024-01-01T00:00:00Z',
        metadata: { container: { tags: [] } }
      }))

      const result = strategy.keepNUntagged(filterSet)

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith(
        'no untagged images found to delete'
      )
    })

    it('should skip tagged images', () => {
      context.config.keepNuntagged = 1
      const filterSet = new Set(['tagged1', 'untagged1', 'untagged2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: '2024-01-01T00:00:00Z',
        metadata: {
          container: { tags: digest === 'tagged1' ? ['v1.0'] : [] }
        }
      }))

      const result = strategy.keepNUntagged(filterSet)

      expect(result.size).toBe(1)
      expect(result).toContain('untagged2')
      expect(result).not.toContain('tagged1')
    })
  })

  describe('keepNTagged', () => {
    it('should return empty set when keepNtagged is not configured', () => {
      context.config.keepNtagged = null

      const result = strategy.keepNTagged(new Set())

      expect(result.size).toBe(0)
    })

    it('should keep N newest tagged images when deleteTags is not set', () => {
      context.config.keepNtagged = 2
      context.config.deleteTags = null
      const filterSet = new Set(['digest1', 'digest2', 'digest3', 'digest4'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: `2024-01-0${digest.slice(-1)}T00:00:00Z`,
        metadata: { container: { tags: [`v${digest.slice(-1)}`] } }
      }))

      const result = strategy.keepNTagged(filterSet)

      expect(result.size).toBe(2)
      expect(result).toContain('digest1')
      expect(result).toContain('digest2')
      expect(filterSet.has('digest1')).toBe(false)
      expect(filterSet.has('digest2')).toBe(false)
    })

    it('should apply keepN only on specified tags when deleteTags is set', () => {
      context.config.keepNtagged = 1
      context.config.deleteTags = 'v1,v2'
      const filterSet = new Set(['digest1', 'digest2', 'digest3'])

      mockImageFilter.expandTags.mockReturnValue(new Set(['v1', 'v2']))
      mockPackageRepo.getDigestByTag.mockImplementation(tag =>
        tag === 'v1' ? 'digest1' : 'digest2'
      )
      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at:
          digest === 'digest2'
            ? '2024-01-02T00:00:00Z'
            : '2024-01-01T00:00:00Z',
        metadata: {
          container: {
            tags:
              digest === 'digest1'
                ? ['v1']
                : digest === 'digest2'
                  ? ['v2']
                  : ['v3']
          }
        }
      }))

      const result = strategy.keepNTagged(filterSet)

      expect(result.size).toBe(1)
      expect(result).toContain('digest1')
      expect(result).not.toContain('digest3')
    })

    it('should not delete when tagged count is less than keepN', () => {
      context.config.keepNtagged = 5
      context.config.deleteTags = null
      const filterSet = new Set(['digest1', 'digest2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: '2024-01-01T00:00:00Z',
        metadata: { container: { tags: ['v1.0'] } }
      }))

      const result = strategy.keepNTagged(filterSet)

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no tagged images found to delete')
    })

    it('counts a multi-tagged image as one keep slot, not N (#10 dedup regression)', () => {
      // Image_3 has three tags all matched by deleteTags. Without dedup,
      // the candidate list becomes [Image_3, Image_3, Image_3, Image_2,
      // Image_1] — top-2 are both Image_3, Image_2 falls off the keep set,
      // and Image_2 gets wrongly deleted instead of Image_1.
      context.config.keepNtagged = 2
      context.config.deleteTags = '^(v.+|latest|stable)$'
      context.config.useRegex = true
      const filterSet = new Set(['image3', 'image2', 'image1'])

      mockImageFilter.expandTags.mockReturnValue(
        new Set(['v1.2', 'latest', 'stable', 'v1.1', 'v1.0'])
      )
      mockPackageRepo.getDigestByTag.mockImplementation(tag => {
        if (['v1.2', 'latest', 'stable'].includes(tag)) return 'image3'
        if (tag === 'v1.1') return 'image2'
        if (tag === 'v1.0') return 'image1'
        return undefined
      })
      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at:
          digest === 'image3'
            ? '2024-03-01T00:00:00Z'
            : digest === 'image2'
              ? '2024-02-01T00:00:00Z'
              : '2024-01-01T00:00:00Z',
        metadata: {
          container: {
            tags:
              digest === 'image3'
                ? ['v1.2', 'latest', 'stable']
                : digest === 'image2'
                  ? ['v1.1']
                  : ['v1.0']
          }
        }
      }))

      const result = strategy.keepNTagged(filterSet)

      // Keep set should be {Image_3, Image_2}; only Image_1 deleted.
      expect(result.size).toBe(1)
      expect(result).toContain('image1')
      expect(result).not.toContain('image2')
      expect(result).not.toContain('image3')
    })
  })

  describe('computeKeepNTaggedDigests', () => {
    it('returns empty set when keepNtagged is not configured', () => {
      context.config.keepNtagged = null

      const keepSet = strategy.computeKeepNTaggedDigests(new Set())

      expect(keepSet.size).toBe(0)
    })

    it('returns top-N most recent images when deleteTags is not set', () => {
      context.config.keepNtagged = 2
      context.config.deleteTags = null
      const filterSet = new Set(['digest1', 'digest2', 'digest3', 'digest4'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: `2024-01-0${digest.slice(-1)}T00:00:00Z`,
        metadata: { container: { tags: [`v${digest.slice(-1)}`] } }
      }))

      const keepSet = strategy.computeKeepNTaggedDigests(filterSet)

      expect(keepSet.size).toBe(2)
      expect(keepSet.has('digest4')).toBe(true)
      expect(keepSet.has('digest3')).toBe(true)
    })

    it('dedupes by digest when deleteTags is set and one image has multiple matched tags', () => {
      // Same scenario as the keepNTagged dedup test. The keep set must be
      // {Image_3, Image_2} — not {Image_3} from triple-counting Image_3's
      // three matched tags.
      context.config.keepNtagged = 2
      context.config.deleteTags = '^(v.+|latest|stable)$'
      context.config.useRegex = true
      const filterSet = new Set(['image3', 'image2', 'image1'])

      mockImageFilter.expandTags.mockReturnValue(
        new Set(['v1.2', 'latest', 'stable', 'v1.1', 'v1.0'])
      )
      mockPackageRepo.getDigestByTag.mockImplementation(tag => {
        if (['v1.2', 'latest', 'stable'].includes(tag)) return 'image3'
        if (tag === 'v1.1') return 'image2'
        if (tag === 'v1.0') return 'image1'
        return undefined
      })
      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at:
          digest === 'image3'
            ? '2024-03-01T00:00:00Z'
            : digest === 'image2'
              ? '2024-02-01T00:00:00Z'
              : '2024-01-01T00:00:00Z',
        metadata: {
          container: {
            tags:
              digest === 'image3'
                ? ['v1.2', 'latest', 'stable']
                : digest === 'image2'
                  ? ['v1.1']
                  : ['v1.0']
          }
        }
      }))

      const keepSet = strategy.computeKeepNTaggedDigests(filterSet)

      expect(keepSet.size).toBe(2)
      expect(keepSet.has('image3')).toBe(true)
      expect(keepSet.has('image2')).toBe(true)
      expect(keepSet.has('image1')).toBe(false)
    })

    it('returns all candidates when count is less than or equal to keepNtagged', () => {
      context.config.keepNtagged = 5
      context.config.deleteTags = null
      const filterSet = new Set(['digest1', 'digest2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        updated_at: '2024-01-01T00:00:00Z',
        metadata: { container: { tags: ['v1.0'] } }
      }))

      const keepSet = strategy.computeKeepNTaggedDigests(filterSet)

      expect(keepSet.size).toBe(2)
      expect(keepSet.has('digest1')).toBe(true)
      expect(keepSet.has('digest2')).toBe(true)
    })
  })

  describe('deleteAllUntagged', () => {
    it('should delete all untagged images', () => {
      const filterSet = new Set([
        'tagged1',
        'untagged1',
        'untagged2',
        'tagged2'
      ])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        metadata: {
          container: {
            tags: digest.startsWith('tagged') ? ['v1.0'] : []
          }
        }
      }))

      const result = strategy.deleteAllUntagged(filterSet)

      expect(result.size).toBe(2)
      expect(result).toContain('untagged1')
      expect(result).toContain('untagged2')
      expect(result).not.toContain('tagged1')
      expect(result).not.toContain('tagged2')
      expect(filterSet.has('untagged1')).toBe(false)
      expect(filterSet.has('untagged2')).toBe(false)
      expect(filterSet.has('tagged1')).toBe(true)
      expect(filterSet.has('tagged2')).toBe(true)
    })

    it('should handle empty filterSet', () => {
      const filterSet = new Set<string>()

      const result = strategy.deleteAllUntagged(filterSet)

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no untagged images found')
    })

    it('should handle all tagged images', () => {
      const filterSet = new Set(['tagged1', 'tagged2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(digest => ({
        name: digest,
        metadata: { container: { tags: ['v1.0'] } }
      }))

      const result = strategy.deleteAllUntagged(filterSet)

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no untagged images found')
    })
  })
})
