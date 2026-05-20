import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest'
import * as core from '@actions/core'
import { ImageDeleter } from '../image-deleter'
import { CleanupContext } from '../cleanup-types'
import { ManifestAnalyzer } from '../manifest-analyzer'
import { Config } from '../config'
import type { Manifest } from '../utils.js'

vi.mock('@actions/core')
vi.mock('../manifest-analyzer')

describe('ImageDeleter', () => {
  let deleter: ImageDeleter
  let context: CleanupContext
  let mockPackageRepo: any
  let mockRegistry: any
  let mockManifestAnalyzer: Mocked<ManifestAnalyzer>
  let digestUsedBy: Map<string, Set<string>>

  beforeEach(() => {
    vi.clearAllMocks()

    // Create mock package repository
    mockPackageRepo = {
      getPackageByDigest: vi.fn(),
      getDigestByTag: vi.fn(),
      getIdByDigest: vi.fn(),
      getTags: vi.fn().mockReturnValue([]),
      getReferrerTagsForDigest: vi.fn().mockReturnValue([]),
      loadPackages: vi.fn().mockResolvedValue(undefined),
      deletePackageVersion: vi.fn().mockResolvedValue(undefined)
    }

    // Create mock registry
    mockRegistry = {
      getManifestByDigest: vi.fn<(digest: string) => Promise<Manifest>>(),
      getRawManifestByDigest: vi.fn<(digest: string) => Promise<Manifest>>(),
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
    vi.mocked(ManifestAnalyzer).mockImplementation(function () {
      return mockManifestAnalyzer
    } as any)

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

      mockRegistry.getRawManifestByDigest.mockResolvedValue({
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

      mockRegistry.getRawManifestByDigest.mockResolvedValue({
        layers: [{ digest: 'sha256:layer1' }]
      })

      mockPackageRepo.getDigestByTag.mockReturnValue('sha256:empty')
      mockPackageRepo.getIdByDigest.mockReturnValue(42)

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

      mockRegistry.getRawManifestByDigest.mockResolvedValue({
        manifests: []
      })

      mockPackageRepo.getDigestByTag.mockReturnValue('sha256:empty')
      mockPackageRepo.getIdByDigest.mockReturnValue(undefined)

      await deleter.performUntagging(untagOps)

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("couldn't find newly created package")
      )
    })

    it('reloads only once for a multi-tag batch', async () => {
      // Three untags on one image (4 tags total → 3 strippable).
      // Previous implementation did 3 reloads (one per tag); the
      // batched implementation does 1.
      const untagOps = new Map([['digest1', ['v1.0', 'old', 'beta']]])
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: {
          container: { tags: ['v1.0', 'old', 'beta', 'latest'] }
        }
      })
      mockRegistry.getRawManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockImplementation(
        (tag: string) => `sha256:empty-${tag}`
      )
      mockPackageRepo.getIdByDigest.mockImplementation(
        (digest: string) => `id-${digest}`
      )

      await deleter.performUntagging(untagOps)

      expect(mockRegistry.putManifest).toHaveBeenCalledTimes(3)
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(3)
    })

    it('annotates each PUT uniquely so digests differ', async () => {
      // The whole reason we can batch: byte-distinct manifests produce
      // distinct digests, so the new versions don't conflate.
      const untagOps = new Map([['digest1', ['a', 'b']]])
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['a', 'b', 'keep'] } }
      })
      mockRegistry.getRawManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockImplementation(
        (tag: string) => `sha256:empty-${tag}`
      )
      mockPackageRepo.getIdByDigest.mockReturnValue(1)

      await deleter.performUntagging(untagOps)

      const putCalls = mockRegistry.putManifest.mock.calls
      const annoA = putCalls.find(c => c[0] === 'a')?.[1]?.annotations
      const annoB = putCalls.find(c => c[0] === 'b')?.[1]?.annotations
      expect(annoA).toBeDefined()
      expect(annoB).toBeDefined()
      // The annotation must differ between tags so the PUT bodies are
      // byte-distinct (i.e. yield distinct digests on the registry).
      expect(JSON.stringify(annoA)).not.toEqual(JSON.stringify(annoB))
    })

    it('fetches each unique source manifest only once per batch', async () => {
      // Three tags on the same image — pre-fetch pass should issue
      // exactly ONE getRawManifestByDigest call for the source digest,
      // not one per tag.
      const untagOps = new Map([['digest1', ['v1.0', 'old', 'beta']]])
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['v1.0', 'old', 'beta', 'latest'] } }
      })
      mockRegistry.getRawManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockImplementation(
        (tag: string) => `sha256:empty-${tag}`
      )
      mockPackageRepo.getIdByDigest.mockImplementation(
        (digest: string) => `id-${digest}`
      )

      await deleter.performUntagging(untagOps)

      // One source manifest fetch despite three target tags.
      expect(mockRegistry.getRawManifestByDigest).toHaveBeenCalledTimes(1)
      expect(mockRegistry.getRawManifestByDigest).toHaveBeenCalledWith(
        'digest1'
      )
    })

    it('honors "at least one tag survives" when batch exceeds available tags', async () => {
      // Original image has 3 tags total; batch asks to untag all 3.
      // Only 2 should actually be stripped — leave one behind.
      const untagOps = new Map([['digest1', ['a', 'b', 'c']]])
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags: ['a', 'b', 'c'] } }
      })
      mockRegistry.getRawManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockImplementation(
        (tag: string) => `sha256:empty-${tag}`
      )
      mockPackageRepo.getIdByDigest.mockReturnValue(1)

      await deleter.performUntagging(untagOps)

      expect(mockRegistry.putManifest).toHaveBeenCalledTimes(2)
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
      mockPackageRepo.getReferrerTagsForDigest.mockImplementation(
        (digest: string) =>
          digest === 'sha256:abc123' ? ['sha256-abc123.sig'] : []
      )
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

    it('cascades subject-bearing OCI 1.1 referrers when their subject is deleted', async () => {
      // Regression: a bare OCI 1.1 referrer (no tag, no sha256-* fallback)
      // was previously dropped by delete-untagged because nothing linked
      // it back to its subject. The subjectReferrers reverse index now
      // lets the deleter take it down alongside its subject.
      const subjectPackage = {
        id: 'subject-id',
        name: 'sha256:subject',
        metadata: { container: { tags: ['v1.0'] } }
      }
      const referrerPackage = {
        id: 'referrer-id',
        name: 'sha256:referrer',
        metadata: { container: { tags: [] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({})
      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:referrer') return referrerPackage
          return subjectPackage
        }
      )

      const subjectReferrers = new Map([
        ['sha256:subject', new Set(['sha256:referrer'])]
      ])
      deleter = new ImageDeleter(context, digestUsedBy, subjectReferrers)

      const result = await deleter.deleteImage(subjectPackage)

      expect(result.deleted).toBe(2)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        'subject-id',
        'sha256:subject',
        ['v1.0']
      )
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        'referrer-id',
        'sha256:referrer',
        []
      )
    })

    it('does not double-delete a referrer reachable via both sha256-* tag and subject', async () => {
      // Hybrid output (cosign --registry-referrers-mode oci-1-1 on ghcr)
      // creates BOTH a sha256-* fallback tag AND a subject descriptor
      // pointing at the same target. Make sure we only delete the
      // referrer package once.
      const subjectDigest = `sha256:${'a'.repeat(64)}`
      const referrerDigest = 'sha256:referrer'
      const fallbackTag = `sha256-${'a'.repeat(64)}.sig`

      const subjectPackage = {
        id: 'subject-id',
        name: subjectDigest,
        metadata: { container: { tags: ['v1.0'] } }
      }
      const referrerPackage = {
        id: 'referrer-id',
        name: referrerDigest,
        metadata: { container: { tags: [fallbackTag] } }
      }

      mockRegistry.getManifestByDigest.mockResolvedValue({})
      mockPackageRepo.getTags.mockReturnValue([fallbackTag])
      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) =>
        tag === fallbackTag ? referrerDigest : undefined
      )
      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === referrerDigest) return referrerPackage
          return subjectPackage
        }
      )

      const subjectReferrers = new Map([
        [subjectDigest, new Set([referrerDigest])]
      ])
      deleter = new ImageDeleter(context, digestUsedBy, subjectReferrers)

      const result = await deleter.deleteImage(subjectPackage)

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

      // The reverse index now maps each parent digest to its specific
      // sha256-<digest>.* referrers, so the deleter doesn't scan all
      // tags for every digest it processes.
      mockPackageRepo.getReferrerTagsForDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:abcd1234') return ['sha256-abcd1234.sig']
          if (digest === 'sha256:efgh5678') return ['sha256-efgh5678.att']
          return []
        }
      )

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
})
