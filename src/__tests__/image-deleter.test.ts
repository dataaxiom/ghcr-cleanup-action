import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import { ImageDeleter } from '../image-deleter'
import { CleanupContext } from '../cleanup-types'
import { ManifestAnalyzer } from '../manifest-analyzer'
import { Config } from '../config'

vi.mock('@actions/core')
vi.mock('../manifest-analyzer')

describe('ImageDeleter', () => {
  let deleter: ImageDeleter
  let context: CleanupContext
  let mockPackageRepo: any
  let mockRegistry: any
  let mockManifestAnalyzer: vi.Mocked<ManifestAnalyzer>
  let digestUsedBy: Map<string, Set<string>>

  beforeEach(() => {
    vi.clearAllMocks()

    // Create mock package repository
    mockPackageRepo = {
      getPackageByDigest: vi.fn(),
      getDigestByTag: vi.fn(),
      getIdByDigest: vi.fn(),
      getTags: vi.fn().mockReturnValue([]),
      loadPackages: vi.fn().mockResolvedValue(undefined),
      deletePackageVersion: vi.fn().mockResolvedValue(undefined)
    }

    // Create mock registry
    mockRegistry = {
      getManifestByDigest: vi.fn(),
      putManifest: vi.fn().mockResolvedValue(undefined)
    }

    // Create context
    context = {
      config: {} as Config,
      registry: mockRegistry,
      packageRepo: mockPackageRepo,
      targetPackage: 'test-package'
    }

    // Create digest used by map
    digestUsedBy = new Map()

    // Create mock ManifestAnalyzer
    mockManifestAnalyzer = {
      primeManifests: vi.fn().mockResolvedValue(undefined),
      buildLabel: vi.fn().mockResolvedValue('label')
    } as any
    vi.mocked(ManifestAnalyzer).mockImplementation(() => mockManifestAnalyzer)

    deleter = new ImageDeleter(context, digestUsedBy)
  })

  describe('performUntagging', () => {
    it('should return false when no untag operations', async () => {
      const result = await deleter.performUntagging(new Map())
      expect(result).toBe(false)
    })

    it('should untag multi-tagged images', async () => {
      const untagOps = new Map([['digest1', ['v1.0', 'old']]])

      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0', 'old', 'latest'] } }
      })

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child1' }]
      })

      mockPackageRepo.getDigestByTag.mockImplementation(
        (tag: string) => `sha256:empty-${tag}`
      )
      mockPackageRepo.getIdByDigest.mockImplementation(
        (digest: string) => `id-${digest}`
      )

      const result = await deleter.performUntagging(untagOps)

      expect(result).toBe(true)
      expect(mockRegistry.putManifest).toHaveBeenCalledTimes(2)
      expect(mockRegistry.putManifest).toHaveBeenCalledWith(
        'v1.0',
        expect.objectContaining({ manifests: [] }),
        true
      )
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(2)
    })

    it('should handle single layer manifests', async () => {
      const untagOps = new Map([['digest1', ['v1.0']]])

      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0', 'latest'] } }
      })

      mockRegistry.getManifestByDigest.mockResolvedValue({
        layers: [{ digest: 'sha256:layer1' }]
      })

      mockPackageRepo.getDigestByTag.mockReturnValue('sha256:empty')
      mockPackageRepo.getIdByDigest.mockReturnValue('empty-id')

      await deleter.performUntagging(untagOps)

      expect(mockRegistry.putManifest).toHaveBeenCalledWith(
        'v1.0',
        expect.objectContaining({ layers: [] }),
        false
      )
    })

    it('should skip untagging if only one tag remains', async () => {
      const untagOps = new Map([['digest1', ['v1.0']]])

      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0'] } }
      })

      await deleter.performUntagging(untagOps)

      expect(mockRegistry.putManifest).not.toHaveBeenCalled()
      expect(mockPackageRepo.deletePackageVersion).not.toHaveBeenCalled()
    })

    it('should handle missing package id after untagging', async () => {
      const untagOps = new Map([['digest1', ['v1.0']]])

      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0', 'latest'] } }
      })

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: []
      })

      mockPackageRepo.getDigestByTag.mockReturnValue('sha256:empty')
      mockPackageRepo.getIdByDigest.mockReturnValue(null)

      await deleter.performUntagging(untagOps)

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("couldn't find newly created package")
      )
    })
  })

  describe('deleteImage', () => {
    const mockPackage = {
      id: 'pkg-id',
      name: 'sha256:abc123',
      metadata: { container: { tags: ['v1.0'] } }
    }

    it('should delete a simple image', async () => {
      mockRegistry.getManifestByDigest.mockResolvedValue({
        layers: [{ digest: 'sha256:layer1' }]
      })

      const result = await deleter.deleteImage(mockPackage)

      expect(result.deleted).toBe(1)
      expect(result.multiDeleted).toBe(0)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        'pkg-id',
        'sha256:abc123',
        ['v1.0']
      )
    })

    it('should skip already deleted images', async () => {
      mockRegistry.getManifestByDigest.mockResolvedValue({})

      // First deletion
      await deleter.deleteImage(mockPackage)

      // Second attempt
      const result = await deleter.deleteImage(mockPackage)

      expect(result.deleted).toBe(0)
      expect(result.multiDeleted).toBe(0)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(1)
    })

    it('should delete multi-arch image and its children', async () => {
      const childPackage = {
        id: 'child-id',
        name: 'sha256:child1',
        metadata: { container: { tags: [] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [
          {
            digest: 'sha256:child1',
            platform: { os: 'linux', architecture: 'amd64' }
          }
        ]
      })

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:child1') return childPackage
          return mockPackage
        }
      )

      digestUsedBy.set('sha256:child1', new Set(['sha256:abc123']))

      const result = await deleter.deleteImage(mockPackage)

      expect(result.deleted).toBe(2)
      expect(result.multiDeleted).toBe(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(2)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        'child-id',
        'sha256:child1',
        [],
        'label'
      )
    })

    it('should skip child images used by other parents', async () => {
      const childPackage = {
        id: 'child-id',
        name: 'sha256:child1',
        metadata: { container: { tags: [] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child1' }]
      })

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:child1') return childPackage
          return mockPackage
        }
      )

      digestUsedBy.set(
        'sha256:child1',
        new Set(['sha256:abc123', 'sha256:other'])
      )

      const result = await deleter.deleteImage(mockPackage)

      expect(result.deleted).toBe(1)
      expect(result.multiDeleted).toBe(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(1)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("it's in use by another image")
      )
      expect(digestUsedBy.get('sha256:child1')).toEqual(
        new Set(['sha256:other'])
      )
    })

    it('should delete attestation/referrer images', async () => {
      const attestationPackage = {
        id: 'att-id',
        name: 'sha256:att123',
        metadata: { container: { tags: ['sha256-abc123.sig'] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({})
      mockPackageRepo.getTags.mockReturnValue(['sha256-abc123.sig'])
      mockPackageRepo.getDigestByTag.mockReturnValue('sha256:att123')
      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:att123') return attestationPackage
          return mockPackage
        }
      )

      const result = await deleter.deleteImage(mockPackage)

      expect(result.deleted).toBe(2)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(2)
    })

    it('should handle recursive attestation deletion', async () => {
      const parentPackage = {
        id: 'parent-id',
        name: 'sha256:abcd1234',
        metadata: { container: { tags: ['latest'] } }
      }

      const attestationPackage = {
        id: 'att-id',
        name: 'sha256:efgh5678',
        metadata: { container: { tags: ['sha256-abcd1234.sig'] } }
      }

      const nestedAttestationPackage = {
        id: 'nested-att-id',
        name: 'sha256:ijkl9012',
        metadata: { container: { tags: ['sha256-efgh5678.att'] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({})

      // Return all attestation tags - the deleter will filter them
      mockPackageRepo.getTags.mockReturnValue([
        'sha256-abcd1234.sig',
        'sha256-efgh5678.att'
      ])

      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) => {
        if (tag === 'sha256-abcd1234.sig') return 'sha256:efgh5678'
        if (tag === 'sha256-efgh5678.att') return 'sha256:ijkl9012'
        return null
      })

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:efgh5678') return attestationPackage
          if (digest === 'sha256:ijkl9012') return nestedAttestationPackage
          return parentPackage
        }
      )

      const result = await deleter.deleteImage(parentPackage)

      expect(result.deleted).toBe(3)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(3)
    })
  })

  describe('deleteImages', () => {
    it('should delete all images in the delete set', async () => {
      const deleteSet = new Set(['sha256:img1', 'sha256:img2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          id: `id-${digest}`,
          name: digest,
          metadata: { container: { tags: [] } }
        })
      )

      mockRegistry.getManifestByDigest.mockResolvedValue({})

      const result = await deleter.deleteImages(deleteSet)

      expect(mockManifestAnalyzer.primeManifests).toHaveBeenCalledWith(
        deleteSet
      )
      expect(result.numberImagesDeleted).toBe(2)
      expect(result.numberMultiImagesDeleted).toBe(0)
      expect(result.deleted.size).toBe(2)
    })

    it('should handle empty delete set', async () => {
      const deleteSet = new Set<string>()

      const result = await deleter.deleteImages(deleteSet)

      expect(core.info).toHaveBeenCalledWith('Nothing to delete')
      expect(result.numberImagesDeleted).toBe(0)
      expect(result.deleted.size).toBe(0)
    })

    it('should accumulate stats for multi-arch images', async () => {
      const deleteSet = new Set(['sha256:multi1', 'sha256:multi2'])

      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => ({
          id: `id-${digest}`,
          name: digest,
          metadata: { container: { tags: [] } }
        })
      )

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child' }]
      })

      // Make child packages return null to avoid deletion
      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest.includes('child')) return null
          return {
            id: `id-${digest}`,
            name: digest,
            metadata: { container: { tags: [] } }
          }
        }
      )

      const result = await deleter.deleteImages(deleteSet)

      expect(result.numberImagesDeleted).toBe(2)
      expect(result.numberMultiImagesDeleted).toBe(2)
    })
  })

  describe('reset', () => {
    it('should clear the deleted set', async () => {
      const mockPackage = {
        id: 'pkg-id',
        name: 'sha256:abc123',
        metadata: { container: { tags: [] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({})

      // Delete an image
      await deleter.deleteImage(mockPackage)

      // Reset
      deleter.reset()

      // Should be able to delete the same image again
      const result = await deleter.deleteImage(mockPackage)

      expect(result.deleted).toBe(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(2)
    })
  })
})
