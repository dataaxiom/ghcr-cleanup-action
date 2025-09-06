import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import { ImageValidator } from '../image-validator'
import { CleanupContext } from '../cleanup-types'
import { Config } from '../config'

vi.mock('@actions/core')

describe('ImageValidator', () => {
  let validator: ImageValidator
  let context: CleanupContext
  let mockPackageRepo: any
  let mockRegistry: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Create mock package repository
    mockPackageRepo = {
      getDigests: vi.fn().mockReturnValue(new Set()),
      getPackageByDigest: vi.fn(),
      getIdByDigest: vi.fn(),
      getTags: vi.fn().mockReturnValue([]),
      getDigestByTag: vi.fn()
    }

    // Create mock registry
    mockRegistry = {
      getManifestByDigest: vi.fn()
    }

    // Create context
    context = {
      config: {} as Config,
      registry: mockRegistry,
      packageRepo: mockPackageRepo,
      targetPackage: 'test-package'
    }

    validator = new ImageValidator(context)
  })

  describe('validate', () => {
    it('should report no errors for valid repository', async () => {
      mockPackageRepo.getDigests.mockReturnValue(new Set(['digest1']))
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: ['v1.0'] } }
      })
      mockRegistry.getManifestByDigest.mockResolvedValue({
        layers: [{ digest: 'sha256:layer1' }]
      })

      const result = await validator.validate()

      expect(result.hasErrors).toBe(false)
      expect(core.info).toHaveBeenCalledWith('no errors found')
    })

    it('should detect missing child manifests', async () => {
      mockPackageRepo.getDigests.mockReturnValue(new Set(['parent-digest']))
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: ['latest'] } }
      })
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'parent-digest' ? 'parent-id' : undefined
      )
      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child1' }, { digest: 'sha256:child2' }]
      })

      const result = await validator.validate()

      expect(result.hasErrors).toBe(true)
      expect(core.warning).toHaveBeenCalledWith(
        'digest sha256:child1 not found on image latest'
      )
      expect(core.warning).toHaveBeenCalledWith(
        'digest sha256:child2 not found on image latest'
      )
    })

    it('should detect missing child manifests for untagged images', async () => {
      mockPackageRepo.getDigests.mockReturnValue(new Set(['parent-digest']))
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: [] } }
      })
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'parent-digest' ? 'parent-id' : undefined
      )
      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child1' }]
      })

      const result = await validator.validate()

      expect(result.hasErrors).toBe(true)
      expect(core.warning).toHaveBeenCalledWith(
        'digest sha256:child1 not found on untagged image parent-digest'
      )
    })

    it('should detect orphaned referrer tags', async () => {
      const fullDigest =
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      mockPackageRepo.getDigests.mockReturnValue(new Set())
      mockPackageRepo.getTags.mockReturnValue([
        `sha256-${fullDigest}.sig`,
        'sha256-def456.att'
      ])
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === `sha256:${fullDigest}` ? undefined : 'some-id'
      )
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: [] } }
      })
      mockRegistry.getManifestByDigest.mockResolvedValue({})

      const result = await validator.validate()

      expect(result.hasErrors).toBe(true)
      expect(core.warning).toHaveBeenCalledWith(
        `parent image for referrer tag sha256-${fullDigest}.sig not found in repository`
      )
    })

    it('should handle long referrer tags correctly', async () => {
      const longTag = `sha256-${'a'.repeat(100)}.sig`
      const expectedDigest = `sha256:${'a'.repeat(64)}`

      mockPackageRepo.getDigests.mockReturnValue(new Set())
      mockPackageRepo.getTags.mockReturnValue([longTag])
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === expectedDigest ? undefined : 'some-id'
      )

      const result = await validator.validate()

      expect(result.hasErrors).toBe(true)
      expect(mockPackageRepo.getIdByDigest).toHaveBeenCalledWith(expectedDigest)
    })

    it('should skip already processed manifests', async () => {
      mockPackageRepo.getDigests.mockReturnValue(
        new Set(['parent1', 'parent2', 'child1'])
      )
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: [] } }
      })
      mockPackageRepo.getIdByDigest.mockReturnValue('some-id')
      mockRegistry.getManifestByDigest.mockImplementation(
        async (digest: string) => {
          if (digest === 'parent1' || digest === 'parent2') {
            return { manifests: [{ digest: 'child1' }] }
          }
          return {}
        }
      )

      await validator.validate()

      // Should only fetch manifest for child1 once (through parent1)
      expect(mockRegistry.getManifestByDigest).toHaveBeenCalledTimes(2)
      expect(mockRegistry.getManifestByDigest).toHaveBeenCalledWith('parent1')
      expect(mockRegistry.getManifestByDigest).toHaveBeenCalledWith('parent2')
    })
  })

  describe('findGhostImages', () => {
    it('should find images where all child manifests are missing', async () => {
      const filterSet = new Set(['ghost1', 'ghost2', 'normal'])

      mockRegistry.getManifestByDigest.mockImplementation(
        async (digest: string) => {
          if (digest === 'ghost1' || digest === 'ghost2') {
            return {
              manifests: [
                { digest: 'sha256:missing1' },
                { digest: 'sha256:missing2' }
              ]
            }
          }
          return { manifests: [{ digest: 'sha256:exists' }] }
        }
      )

      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'sha256:exists' ? 'exists-id' : undefined
      )

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          metadata: { container: { tags: digest === 'ghost1' ? ['v1.0'] : [] } }
        })
      )

      const result = await validator.findGhostImages(filterSet)

      expect(result).toContain('ghost1')
      expect(result).toContain('ghost2')
      expect(result).not.toContain('normal')
      expect(core.info).toHaveBeenCalledWith('ghost1 v1.0')
      expect(core.info).toHaveBeenCalledWith('ghost2')
    })

    it('should not include images with some existing children', async () => {
      const filterSet = new Set(['partial'])

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:missing' }, { digest: 'sha256:exists' }]
      })

      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'sha256:exists' ? 'exists-id' : undefined
      )

      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: [] } }
      })

      const result = await validator.findGhostImages(filterSet)

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no ghost images found')
    })

    it('should skip non-manifest images', async () => {
      const filterSet = new Set(['single-layer'])

      mockRegistry.getManifestByDigest.mockResolvedValue({
        layers: [{ digest: 'sha256:layer1' }]
      })

      const result = await validator.findGhostImages(filterSet)

      expect(result.size).toBe(0)
    })
  })

  describe('findPartialImages', () => {
    it('should find images with at least one missing child', async () => {
      const filterSet = new Set(['partial1', 'partial2', 'complete'])

      mockRegistry.getManifestByDigest.mockImplementation(
        async (digest: string) => {
          if (digest === 'partial1' || digest === 'partial2') {
            return {
              manifests: [
                { digest: 'sha256:exists' },
                { digest: 'sha256:missing' }
              ]
            }
          }
          return {
            manifests: [{ digest: 'sha256:exists' }]
          }
        }
      )

      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'sha256:exists' ? 'exists-id' : undefined
      )

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          metadata: {
            container: { tags: digest === 'partial1' ? ['latest'] : [] }
          }
        })
      )

      const result = await validator.findPartialImages(filterSet)

      expect(result).toContain('partial1')
      expect(result).toContain('partial2')
      expect(result).not.toContain('complete')
      expect(core.info).toHaveBeenCalledWith('partial1 latest')
      expect(core.info).toHaveBeenCalledWith('partial2')
    })

    it('should not include ghost images', async () => {
      const filterSet = new Set(['ghost'])

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [
          { digest: 'sha256:missing1' },
          { digest: 'sha256:missing2' }
        ]
      })

      mockPackageRepo.getIdByDigest.mockReturnValue(undefined)
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        metadata: { container: { tags: [] } }
      })

      const result = await validator.findPartialImages(filterSet)

      expect(result).toContain('ghost')
    })

    it('should handle empty filterSet', async () => {
      const result = await validator.findPartialImages(new Set())

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no partial images found')
    })
  })

  describe('findOrphanedImages', () => {
    it('should find images with orphaned referrer tags', () => {
      const digest1 =
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      const digest2 =
        'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321'
      mockPackageRepo.getTags.mockReturnValue([
        `sha256-${digest1}.sig`,
        `sha256-${digest2}.att`,
        'regular-tag'
      ])

      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) => {
        // Only digest1 parent is missing
        if (digest === `sha256:${digest1}`) return undefined
        return 'some-id'
      })

      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) => {
        if (tag === `sha256-${digest1}.sig`) return 'orphan-digest1'
        if (tag === `sha256-${digest2}.att`) return 'orphan-digest2'
        return null
      })

      const result = validator.findOrphanedImages()

      expect(result.size).toBe(1)
      expect(result).toContain('orphan-digest1')
      expect(result).not.toContain('orphan-digest2')
      expect(core.info).toHaveBeenCalledWith(`sha256-${digest1}.sig`)
    })

    it('should handle long sha256 tags', () => {
      const longTag = `sha256-${'a'.repeat(100)}.sig`
      const expectedDigest = `sha256:${'a'.repeat(64)}`

      mockPackageRepo.getTags.mockReturnValue([longTag])
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === expectedDigest ? undefined : 'some-id'
      )
      mockPackageRepo.getDigestByTag.mockReturnValue('orphan-digest')

      const result = validator.findOrphanedImages()

      expect(result).toContain('orphan-digest')
      expect(mockPackageRepo.getIdByDigest).toHaveBeenCalledWith(expectedDigest)
    })

    it('should skip non-sha256 tags', () => {
      mockPackageRepo.getTags.mockReturnValue(['v1.0', 'latest', 'dev'])

      const result = validator.findOrphanedImages()

      expect(result.size).toBe(0)
      expect(mockPackageRepo.getIdByDigest).not.toHaveBeenCalled()
    })

    it('should skip tags where parent exists', () => {
      mockPackageRepo.getTags.mockReturnValue(['sha256-abc123.sig'])
      mockPackageRepo.getIdByDigest.mockReturnValue('parent-id')

      const result = validator.findOrphanedImages()

      expect(result.size).toBe(0)
      expect(core.info).toHaveBeenCalledWith('no orphaned images found')
    })

    it('should handle missing digest for tag', () => {
      mockPackageRepo.getTags.mockReturnValue(['sha256-abc123.sig'])
      mockPackageRepo.getIdByDigest.mockReturnValue(undefined)
      mockPackageRepo.getDigestByTag.mockReturnValue(null)

      const result = validator.findOrphanedImages()

      expect(result.size).toBe(0)
    })
  })
})
