import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import { ImageFilter } from '../image-filter'
import { CleanupContext } from '../cleanup-types'

vi.mock('@actions/core')
vi.mock('wildcard-match', () => ({
  default: (patterns: string[]) => (str: string) => {
    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'))
        if (regex.test(str)) return true
      } else if (str === pattern) {
        return true
      }
    }
    return false
  }
}))

describe('ImageFilter', () => {
  let filter: ImageFilter
  let context: CleanupContext
  let mockPackageRepo: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Create mock package repository
    mockPackageRepo = {
      getTags: vi.fn().mockReturnValue([]),
      getDigestByTag: vi.fn(),
      getDigests: vi.fn().mockReturnValue([]),
      getPackageByDigest: vi.fn()
    }

    // Create context
    context = {
      config: {
        excludeTags: null,
        deleteTags: null,
        useRegex: false,
        olderThan: null,
        olderThanReadable: null
      } as any,
      registry: {} as any,
      packageRepo: mockPackageRepo,
      targetPackage: 'test-package'
    }

    filter = new ImageFilter(context)
  })

  describe('applyExclusionFilters', () => {
    it('should return empty array when excludeTags is not configured', () => {
      const filterSet = new Set(['digest1'])
      const result = filter.applyExclusionFilters(filterSet)

      expect(result).toEqual([])
      expect(filterSet.size).toBe(1)
    })

    it('should exclude tags using wildcard patterns', () => {
      context.config.excludeTags = 'v1.*,latest'
      const filterSet = new Set(['digest1', 'digest2', 'digest3'])

      mockPackageRepo.getTags.mockReturnValue([
        'v1.0',
        'v1.1',
        'latest',
        'v2.0'
      ])
      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) => {
        const mapping: any = {
          'v1.0': 'digest1',
          'v1.1': 'digest2',
          latest: 'digest3',
          'v2.0': 'digest4'
        }
        return mapping[tag]
      })
      mockPackageRepo.getDigests.mockReturnValue([
        'digest1',
        'digest2',
        'digest3'
      ])

      const result = filter.applyExclusionFilters(filterSet)

      expect(result).toContain('v1.0')
      expect(result).toContain('v1.1')
      expect(result).toContain('latest')
      expect(result).not.toContain('v2.0')
      expect(filterSet.has('digest1')).toBe(false)
      expect(filterSet.has('digest2')).toBe(false)
      expect(filterSet.has('digest3')).toBe(false)
    })

    it('should exclude tags using regex patterns', () => {
      context.config.excludeTags = '^v1\\.\\d+$'
      context.config.useRegex = true
      const filterSet = new Set(['digest1', 'digest2', 'digest3'])

      mockPackageRepo.getTags.mockReturnValue([
        'v1.0',
        'v1.1',
        'v1.alpha',
        'v2.0'
      ])
      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) => {
        const mapping: any = {
          'v1.0': 'digest1',
          'v1.1': 'digest2',
          'v1.alpha': 'digest3',
          'v2.0': 'digest4'
        }
        return mapping[tag]
      })
      mockPackageRepo.getDigests.mockReturnValue([
        'digest1',
        'digest2',
        'digest3'
      ])

      const result = filter.applyExclusionFilters(filterSet)

      expect(result).toContain('v1.0')
      expect(result).toContain('v1.1')
      expect(result).not.toContain('v1.alpha')
      expect(result).not.toContain('v2.0')
      expect(filterSet.has('digest1')).toBe(false)
      expect(filterSet.has('digest2')).toBe(false)
      expect(filterSet.has('digest3')).toBe(true)
    })

    it('should exclude digest-based format matches', () => {
      context.config.excludeTags = 'sha256:abc*'
      const filterSet = new Set([
        'sha256:abc123',
        'sha256:def456',
        'sha256:abc789'
      ])

      mockPackageRepo.getTags.mockReturnValue([])
      mockPackageRepo.getDigests.mockReturnValue([
        'sha256:abc123',
        'sha256:def456',
        'sha256:abc789'
      ])

      const result = filter.applyExclusionFilters(filterSet)

      expect(result).toContain('sha256:abc123')
      expect(result).toContain('sha256:abc789')
      expect(result).not.toContain('sha256:def456')
      expect(filterSet.has('sha256:abc123')).toBe(false)
      expect(filterSet.has('sha256:abc789')).toBe(false)
      expect(filterSet.has('sha256:def456')).toBe(true)
    })

    it('should log excluded tags', () => {
      context.config.excludeTags = 'latest'
      const filterSet = new Set(['digest1'])

      mockPackageRepo.getTags.mockReturnValue(['latest'])
      mockPackageRepo.getDigestByTag.mockReturnValue('digest1')
      mockPackageRepo.getDigests.mockReturnValue(['digest1'])

      filter.applyExclusionFilters(filterSet)

      expect(core.startGroup).toHaveBeenCalledWith(
        expect.stringContaining('Excluding tags from deletion')
      )
      expect(core.info).toHaveBeenCalledWith('latest')
      expect(core.endGroup).toHaveBeenCalled()
    })
  })

  describe('applyAgeFilter', () => {
    it('should not filter when olderThan is not configured', () => {
      const filterSet = new Set(['digest1'])
      filter.applyAgeFilter(filterSet)

      expect(filterSet.size).toBe(1)
      expect(core.startGroup).not.toHaveBeenCalled()
    })

    it('should filter images newer than cutoff date', () => {
      context.config.olderThan = 7 * 24 * 60 * 60 * 1000 // 7 days in ms
      context.config.olderThanReadable = '7 days'
      const filterSet = new Set(['old-digest', 'new-digest'])

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
      const newDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          name: digest,
          updated_at:
            digest === 'old-digest'
              ? oldDate.toISOString()
              : newDate.toISOString(),
          metadata: { container: { tags: [] } }
        })
      )

      filter.applyAgeFilter(filterSet)

      expect(filterSet.has('old-digest')).toBe(true)
      expect(filterSet.has('new-digest')).toBe(false)
    })

    it('should log tagged images being filtered', () => {
      context.config.olderThan = 7 * 24 * 60 * 60 * 1000
      context.config.olderThanReadable = '7 days'
      const filterSet = new Set(['digest1'])

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        updated_at: oldDate.toISOString(),
        metadata: { container: { tags: ['v1.0', 'old'] } }
      })

      filter.applyAgeFilter(filterSet)

      expect(core.info).toHaveBeenCalledWith('digest1 v1.0,old')
    })

    it('should log untagged images being filtered', () => {
      context.config.olderThan = 7 * 24 * 60 * 60 * 1000
      context.config.olderThanReadable = '7 days'
      const filterSet = new Set(['digest1'])

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        updated_at: oldDate.toISOString(),
        metadata: { container: { tags: [] } }
      })

      filter.applyAgeFilter(filterSet)

      expect(core.info).toHaveBeenCalledWith('digest1')
    })

    it('should log when no images found after filtering', () => {
      context.config.olderThan = 7 * 24 * 60 * 60 * 1000
      context.config.olderThanReadable = '7 days'
      const filterSet = new Set(['new-digest'])

      const newDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'new-digest',
        updated_at: newDate.toISOString(),
        metadata: { container: { tags: [] } }
      })

      filter.applyAgeFilter(filterSet)

      expect(core.info).toHaveBeenCalledWith('no images found')
    })
  })

  describe('expandTags', () => {
    it('should return empty set when deleteTags is not configured', () => {
      const filterSet = new Set(['digest1'])
      const result = filter.expandTags(filterSet)

      expect(result.size).toBe(0)
    })

    it('should expand tags using wildcard patterns', () => {
      context.config.deleteTags = 'v1.*,old-*'
      const filterSet = new Set(['digest1', 'digest2', 'digest3'])

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          name: digest,
          metadata: {
            container: {
              tags:
                digest === 'digest1'
                  ? ['v1.0', 'latest']
                  : digest === 'digest2'
                    ? ['v1.1', 'old-release']
                    : ['v2.0']
            }
          }
        })
      )

      const result = filter.expandTags(filterSet)

      expect(result).toContain('v1.0')
      expect(result).toContain('v1.1')
      expect(result).toContain('old-release')
      expect(result).not.toContain('latest')
      expect(result).not.toContain('v2.0')
    })

    it('should expand tags using regex patterns', () => {
      context.config.deleteTags = '^v\\d+\\.\\d+$'
      context.config.useRegex = true
      const filterSet = new Set(['digest1', 'digest2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          name: digest,
          metadata: {
            container: {
              tags:
                digest === 'digest1' ? ['v1.0', 'v1.beta'] : ['v2.1', 'latest']
            }
          }
        })
      )

      const result = filter.expandTags(filterSet)

      expect(result).toContain('v1.0')
      expect(result).toContain('v2.1')
      expect(result).not.toContain('v1.beta')
      expect(result).not.toContain('latest')
    })

    it('should match digest-based formats', () => {
      context.config.deleteTags = 'sha256:abc*'
      const filterSet = new Set(['sha256:abc123', 'sha256:def456'])

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          name: digest,
          metadata: { container: { tags: [] } }
        })
      )

      const result = filter.expandTags(filterSet)

      expect(result).toContain('sha256:abc123')
      expect(result).not.toContain('sha256:def456')
    })

    it('should match both tags and digests', () => {
      context.config.deleteTags = 'test*'
      const filterSet = new Set(['test-digest', 'other-digest'])

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          name: digest,
          metadata: {
            container: {
              tags: digest === 'other-digest' ? ['test-tag'] : []
            }
          }
        })
      )

      const result = filter.expandTags(filterSet)

      expect(result).toContain('test-digest')
      expect(result).toContain('test-tag')
    })

    it('should handle empty tags array', () => {
      context.config.deleteTags = 'v1.*'
      const filterSet = new Set(['digest1'])

      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: [] } }
      })

      const result = filter.expandTags(filterSet)

      expect(result.size).toBe(0)
    })
  })
})
