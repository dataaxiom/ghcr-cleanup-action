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
      deletePackageVersion: vi.fn().mockResolvedValue(undefined),
      simulateUntag: vi.fn()
    }

    // Create mock registry
    mockRegistry = {
      getManifestByDigest: vi.fn<(digest: string) => Promise<Manifest>>(),
      getRawManifestByDigest: vi.fn<(digest: string) => Promise<Manifest>>(),
      // Like the real Registry: returns the digest of the version the PUT
      // created. Distinct per tag, as the real per-tag annotation makes it.
      putManifest: vi.fn(async (tag: string) => `sha256:placeholder-${tag}`)
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
    // Run performUntagging with fake timers so the reload backoff sleeps
    // resolve instantly. Returns the promise's outcome for assertions.
    const runUntag = async (
      untagOps: Map<string, string[]>
    ): Promise<{ result?: boolean; error?: unknown }> => {
      vi.useFakeTimers()
      try {
        const p = (async () => {
          try {
            return { result: await deleter.performUntagging(untagOps) }
          } catch (error) {
            return { error }
          }
        })()
        await vi.runAllTimersAsync()
        return await p
      } finally {
        vi.useRealTimers()
      }
    }
    // Package listing where each tag's placeholder is listed under `ids`.
    const listPlaceholders = (ids: Record<string, number>): void => {
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) => {
        const tag = digest.replace('sha256:placeholder-', '')
        return digest.startsWith('sha256:placeholder-') ? ids[tag] : undefined
      })
    }
    const sourceWithTags = (tags: string[], manifest: Manifest): void => {
      mockPackageRepo.getPackageByDigest.mockReturnValue({
        name: 'digest1',
        metadata: { container: { tags } }
      })
      mockRegistry.getRawManifestByDigest.mockResolvedValue(manifest)
    }

    it('should return false when no untag operations', async () => {
      const result = await deleter.performUntagging(new Map())
      expect(result).toBe(false)
    })

    it('untags multi-tagged images by deleting exactly the placeholders it PUT', async () => {
      sourceWithTags(['v1.0', 'old', 'latest'], {
        manifests: [{ digest: 'sha256:child1' }]
      })
      listPlaceholders({ 'v1.0': 11, old: 12 })

      const { result } = await runUntag(new Map([['digest1', ['v1.0', 'old']]]))

      expect(result).toBe(true)
      expect(mockRegistry.putManifest).toHaveBeenCalledTimes(2)
      expect(mockRegistry.putManifest).toHaveBeenCalledWith(
        'v1.0',
        expect.objectContaining({ manifests: [] }),
        true
      )
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(2)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        11,
        'sha256:placeholder-v1.0',
        ['v1.0']
      )
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        12,
        'sha256:placeholder-old',
        ['old']
      )
    })

    it('should handle single layer manifests', async () => {
      sourceWithTags(['v1.0', 'latest'], {
        layers: [{ digest: 'sha256:layer1' }]
      })
      listPlaceholders({ 'v1.0': 42 })

      await runUntag(new Map([['digest1', ['v1.0']]]))

      expect(mockRegistry.putManifest).toHaveBeenCalledWith(
        'v1.0',
        expect.objectContaining({ layers: [] }),
        false
      )
    })

    it('under dry-run, skips the reload + delete and simulates the untag for the preview', async () => {
      // With dry-run on, putManifest is a no-op, so the tags still point
      // at the live images. Resolving tags after a reload would find the
      // live digests and log them as being deleted — so no reload or
      // delete here. Instead the untag is simulated in the listing, so the
      // caller's reload + second pass stages what a live run would.
      context.config.dryRun = true
      sourceWithTags(['v1.0', 'latest'], { manifests: [] })

      const { result } = await runUntag(new Map([['digest1', ['v1.0']]]))

      expect(result).toBe(true)
      expect(mockRegistry.putManifest).toHaveBeenCalledTimes(1)
      expect(mockPackageRepo.loadPackages).not.toHaveBeenCalled()
      expect(mockPackageRepo.deletePackageVersion).not.toHaveBeenCalled()
      expect(mockPackageRepo.simulateUntag).toHaveBeenCalledWith(['v1.0'])
    })

    it('should skip untagging if only one tag remains', async () => {
      sourceWithTags(['v1.0'], { manifests: [] })

      await runUntag(new Map([['digest1', ['v1.0']]]))

      expect(mockRegistry.putManifest).not.toHaveBeenCalled()
      expect(mockPackageRepo.deletePackageVersion).not.toHaveBeenCalled()
    })

    it('reloads only once for a multi-tag batch whose placeholders are all listed', async () => {
      sourceWithTags(['v1.0', 'old', 'beta', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      listPlaceholders({ 'v1.0': 1, old: 2, beta: 3 })

      await runUntag(new Map([['digest1', ['v1.0', 'old', 'beta']]]))

      expect(mockRegistry.putManifest).toHaveBeenCalledTimes(3)
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(3)
    })

    it('reloads again when a placeholder is not yet listed, then deletes it', async () => {
      // Eventual-consistency race: the first reload doesn't list the
      // placeholder yet, the second does.
      sourceWithTags(['v1.0', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getIdByDigest
        .mockReturnValueOnce(undefined)
        .mockReturnValue(99)

      const { result } = await runUntag(new Map([['digest1', ['v1.0']]]))

      expect(result).toBe(true)
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(2)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        99,
        'sha256:placeholder-v1.0',
        ['v1.0']
      )
    })

    it('never deletes what the tag resolves to — not the source, not another image pushed under the tag', async () => {
      // The tag resolves to a THIRD image (a concurrent push of the same
      // tag, or a stale listing), which is listed with a real id and
      // carries other tags. The old "anything but the source" check would
      // delete it. Only the placeholder's own digest may be deleted, and
      // it never appears — so nothing is deleted and the run fails.
      sourceWithTags(['v1.0', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockReturnValue('sha256:someone-else')
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'sha256:someone-else' || digest === 'digest1'
          ? 555
          : undefined
      )

      const { result, error } = await runUntag(new Map([['digest1', ['v1.0']]]))

      expect(result).toBeUndefined()
      expect(String(error)).toMatch(/Untag incomplete/)
      expect(mockPackageRepo.deletePackageVersion).not.toHaveBeenCalled()
    })

    it('fails the run after the retry budget when a placeholder never appears (source untouched)', async () => {
      // The listing stays stale for the whole budget. The delete must be
      // skipped (never the source image), and the incomplete untag must
      // fail the run instead of reporting success.
      sourceWithTags(['v1.0', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockReturnValue('digest1')
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'digest1' ? 999 : undefined
      )

      const { result, error } = await runUntag(new Map([['digest1', ['v1.0']]]))

      expect(result).toBeUndefined()
      expect(String(error)).toMatch(
        /Untag incomplete.*"v1\.0" \(placeholder sha256:placeholder-v1\.0\).*source image was not touched/
      )
      expect(mockPackageRepo.deletePackageVersion).not.toHaveBeenCalled()
      expect(mockPackageRepo.loadPackages).toHaveBeenCalledTimes(6)
      expect(core.endGroup).toHaveBeenCalled()
    })

    it('in a mixed batch, deletes the listed placeholder, then fails for the one that never appears', async () => {
      // v1's placeholder becomes visible, v2's never does. Only v1's
      // placeholder is deleted; the source image (real id 999) never is;
      // and the run still fails for v2.
      sourceWithTags(['v1', 'v2', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) =>
        tag === 'v1' ? 'sha256:placeholder-v1' : 'digest1'
      )
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) =>
        digest === 'sha256:placeholder-v1'
          ? 77
          : digest === 'digest1'
            ? 999
            : undefined
      )

      const { error } = await runUntag(new Map([['digest1', ['v1', 'v2']]]))

      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(1)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        77,
        'sha256:placeholder-v1',
        ['v1']
      )
      expect(String(error)).toMatch(/Untag incomplete.*"v2"/)
      expect(String(error)).not.toMatch(/"v1"/)
    })

    it('deletes by the id captured when the placeholder was listed, even if a later snapshot is stale', async () => {
      // Non-monotonic listing: v1's placeholder is listed on reload 1 but
      // missing again on reload 2 (when v2's finally appears). v1 must
      // still be deleted, by the id seen on reload 1.
      sourceWithTags(['v1', 'v2', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      let reload = 0
      mockPackageRepo.loadPackages.mockImplementation(async () => {
        reload++
      })
      mockPackageRepo.getIdByDigest.mockImplementation((digest: string) => {
        if (digest === 'sha256:placeholder-v1')
          return reload === 1 ? 71 : undefined
        if (digest === 'sha256:placeholder-v2')
          return reload >= 2 ? 72 : undefined
        return undefined
      })

      const { result } = await runUntag(new Map([['digest1', ['v1', 'v2']]]))

      expect(result).toBe(true)
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        71,
        'sha256:placeholder-v1',
        ['v1']
      )
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        72,
        'sha256:placeholder-v2',
        ['v2']
      )
    })

    it('annotates each PUT uniquely so digests differ', async () => {
      // The whole reason we can batch: byte-distinct manifests produce
      // distinct digests, so the new versions don't conflate.
      sourceWithTags(['a', 'b', 'keep'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      listPlaceholders({ a: 1, b: 2 })

      await runUntag(new Map([['digest1', ['a', 'b']]]))

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
      sourceWithTags(['v1.0', 'old', 'beta', 'latest'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      listPlaceholders({ 'v1.0': 1, old: 2, beta: 3 })

      await runUntag(new Map([['digest1', ['v1.0', 'old', 'beta']]]))

      // One source manifest fetch despite three target tags.
      expect(mockRegistry.getRawManifestByDigest).toHaveBeenCalledTimes(1)
      expect(mockRegistry.getRawManifestByDigest).toHaveBeenCalledWith(
        'digest1'
      )
    })

    it('honors "at least one tag survives" when batch exceeds available tags', async () => {
      // Original image has 3 tags total; batch asks to untag all 3.
      // Only 2 should actually be stripped — leave one behind.
      sourceWithTags(['a', 'b', 'c'], {
        manifests: [{ digest: 'sha256:child' }]
      })
      listPlaceholders({ a: 1, b: 2 })

      await runUntag(new Map([['digest1', ['a', 'b', 'c']]]))

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
        ['v1.0'],
        undefined,
        expect.anything() // logger (consoleLogger by default in unit tests)
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
        'label',
        expect.anything() // logger
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
        ['v1.0'],
        undefined,
        expect.anything() // logger
      )
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledWith(
        'test-package',
        'referrer-id',
        'sha256:referrer',
        [],
        undefined,
        expect.anything() // logger
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

    it('dedupes a referrer reached by two parallel cascade paths under real concurrency', async () => {
      // The previous "does not double-delete" test passes regardless of
      // locking because vitest mocks resolve in the next microtask —
      // there's no real await window for the race to happen. This test
      // forces a window by delaying the referrer's manifest fetch, so
      // a parallel deleteImage(referrer) from path #2 definitely enters
      // its has()-check before path #1 has had a chance to claim.
      //
      // Without the synchronous pre-claim in deleteImage, both paths
      // would fire DELETE for the referrer (one wins, the other 404s)
      // and the action would waste API quota plus produce noisy
      // tolerated-404 warnings. With the pre-claim, the second path
      // sees the claim at its has() check and returns early.
      const subjectDigest = `sha256:${'b'.repeat(64)}`
      const referrerDigest = 'sha256:locked-referrer'
      const fallbackTag = `sha256-${'b'.repeat(64)}.sig`

      const subjectPackage = {
        id: 'subj-id',
        name: subjectDigest,
        metadata: { container: { tags: ['v1.0'] } }
      }
      const referrerPackage = {
        id: 'ref-id',
        name: referrerDigest,
        metadata: { container: { tags: [fallbackTag] } }
      }

      // Force a real await window: the referrer's manifest fetch
      // takes 30ms. Path #1 yields on this fetch; path #2 then enters
      // and either races (no claim) or short-circuits (claimed).
      mockRegistry.getManifestByDigest.mockImplementation(
        async (digest: string) => {
          if (digest === referrerDigest) {
            await new Promise(resolve => setTimeout(resolve, 30))
          }
          return {}
        }
      )
      mockPackageRepo.getTags.mockReturnValue([fallbackTag])
      mockPackageRepo.getDigestByTag.mockImplementation((tag: string) =>
        tag === fallbackTag ? referrerDigest : undefined
      )
      mockPackageRepo.getReferrerTagsForDigest.mockImplementation(
        (digest: string) => (digest === subjectDigest ? [fallbackTag] : [])
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

      await deleter.deleteImage(subjectPackage)

      // Exactly two DELETE calls: subject + referrer (once). The
      // referrer's second cascade path is short-circuited by the
      // pre-claim — without locking this assertion would fail with
      // three calls (one for subject, two for referrer racing).
      expect(mockPackageRepo.deletePackageVersion).toHaveBeenCalledTimes(2)
      const referrerCalls =
        mockPackageRepo.deletePackageVersion.mock.calls.filter(
          (call: unknown[]) => call[2] === referrerDigest
        )
      expect(referrerCalls).toHaveLength(1)
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

  describe('deleteImage parallelism', () => {
    it('fans out child platform deletes in parallel under one parent', async () => {
      // Six-platform multi-arch index. With CHILD_DELETE_CONCURRENCY=5,
      // we expect to see >=2 child deletes in flight at the same time —
      // which serial code can never produce.
      const parentPackage = {
        id: 'parent-id',
        name: 'sha256:parent',
        metadata: { container: { tags: ['v1'] } }
      }
      const childDigests = [
        'sha256:c1',
        'sha256:c2',
        'sha256:c3',
        'sha256:c4',
        'sha256:c5',
        'sha256:c6'
      ]

      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: childDigests.map(d => ({ digest: d }))
      })
      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:parent') return parentPackage
          if (childDigests.includes(digest)) {
            return {
              id: `id-${digest}`,
              name: digest,
              metadata: { container: { tags: [] } }
            }
          }
          return null
        }
      )
      // Mark every child as solo-referenced so each one gets deleted.
      for (const d of childDigests) {
        digestUsedBy.set(d, new Set(['sha256:parent']))
      }

      // Make each child delete block on a manual gate so we can observe
      // concurrent in-flight counts. The parent delete (first call) runs
      // before any child fans out, so don't gate it.
      let inFlight = 0
      let maxInFlight = 0
      let resolveAll: (() => void) | undefined
      const allInFlight = new Promise<void>(r => {
        resolveAll = r
      })
      let parentDeleted = false

      mockPackageRepo.deletePackageVersion.mockImplementation(
        async (_pkg: string, _id: string, digest: string) => {
          if (digest === 'sha256:parent') {
            parentDeleted = true
            return
          }
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          // Once we've seen 2+ simultaneous child deletes, release them.
          if (maxInFlight >= 2 && resolveAll) {
            resolveAll()
            resolveAll = undefined
          }
          await allInFlight
          inFlight--
        }
      )

      const result = await deleter.deleteImage(parentPackage)

      expect(parentDeleted).toBe(true)
      expect(maxInFlight).toBeGreaterThanOrEqual(2)
      expect(result.deleted).toBe(7) // parent + 6 children
      expect(result.multiDeleted).toBe(1)
    })
  })

  describe('deleteImages log buffering', () => {
    it('defers log emission until the whole tree finishes deleting', async () => {
      // The core promise of per-tree buffering: a top-level image's
      // log lines appear only AFTER every API call in its tree
      // (parent + children) has completed. Without the buffer, the
      // parent's "deleting package" line would emit synchronously
      // right after its API call returns, then child lines would
      // arrive as each child's API call resolves — interleaving log
      // emission with ongoing API work.
      //
      // Test: record the order of API calls and core.info calls into
      // a single global timeline. Assert that the first "deleting
      // package" line for the tree appears strictly AFTER the last
      // API call resolves for that tree.
      const parent = {
        id: 'parent-id',
        name: 'sha256:parent',
        metadata: { container: { tags: ['v1'] } }
      }
      const childA = {
        id: 'child-a',
        name: 'sha256:childA',
        metadata: { container: { tags: [] } }
      }
      const childB = {
        id: 'child-b',
        name: 'sha256:childB',
        metadata: { container: { tags: [] } }
      }
      mockPackageRepo.getPackageByDigest.mockImplementation(
        (digest: string) => {
          if (digest === 'sha256:childA') return childA
          if (digest === 'sha256:childB') return childB
          return parent
        }
      )
      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:childA' }, { digest: 'sha256:childB' }]
      })
      digestUsedBy.set('sha256:childA', new Set(['sha256:parent']))
      digestUsedBy.set('sha256:childB', new Set(['sha256:parent']))

      const timeline: string[] = []
      // Stand in for the real deletePackageVersion: record the API
      // call, then route its log line through the logger the caller
      // passed in (mirrors the production impl). If the logger is the
      // BufferedLogger we expect, the line lands in the buffer; if
      // anything went wrong and the default consoleLogger was used,
      // it would emit to core.info immediately.
      mockPackageRepo.deletePackageVersion.mockImplementation(
        async (
          _pkg: string,
          _id: string,
          digest: string,
          _tags?: string[],
          _label?: string,
          logger?: { info: (msg: string) => void }
        ) => {
          timeline.push(`api:${digest}`)
          logger?.info(` deleting package digest: ${digest}`)
        }
      )
      vi.mocked(core.info).mockImplementation((message: string) => {
        timeline.push(`log:${message}`)
      })

      await deleter.deleteImages(new Set(['sha256:parent']))

      // Locate the boundary: every "api:*" event must precede every
      // "log:*deleting package*" event in the timeline (the buffer
      // defers all log emission until the tree resolves).
      // "log:*deleting package*" event in the timeline.
      const lastApiIdx = timeline.reduce(
        (acc, e, i) => (e.startsWith('api:') ? i : acc),
        -1
      )
      const firstLogIdx = timeline.findIndex(
        e => e.startsWith('log:') && e.includes('deleting package')
      )
      expect(lastApiIdx).toBeGreaterThanOrEqual(0)
      expect(firstLogIdx).toBeGreaterThanOrEqual(0)
      expect(firstLogIdx).toBeGreaterThan(lastApiIdx)
      // Sanity: three API calls (parent + 2 children) and three log lines.
      expect(timeline.filter(e => e.startsWith('api:'))).toHaveLength(3)
      expect(
        timeline.filter(
          e => e.startsWith('log:') && e.includes('deleting package')
        )
      ).toHaveLength(3)
    })

    it('flushes the partial buffer when a child throws mid-tree (preserves audit trail)', async () => {
      // Regression for the v1.2.0 atomicos report: when one child
      // delete throws, the parent's successful delete (and any other
      // log lines pushed before the throw) must still surface in the
      // workflow log. Losing the audit trail because a later sibling
      // failed makes diagnosis impossible — the user can't tell what
      // ghcr actually changed.
      const parent = {
        id: 'parent-id',
        name: 'sha256:parent',
        metadata: { container: { tags: ['v1'] } }
      }
      const child = {
        id: 'child-id',
        name: 'sha256:child',
        metadata: { container: { tags: [] } }
      }
      mockPackageRepo.getPackageByDigest.mockImplementation((digest: string) =>
        digest === 'sha256:child' ? child : parent
      )
      mockRegistry.getManifestByDigest.mockResolvedValue({
        manifests: [{ digest: 'sha256:child' }]
      })
      digestUsedBy.set('sha256:child', new Set(['sha256:parent']))

      // Stand-in for the real deletePackageVersion: log via the
      // caller's logger (so the BufferedLogger captures the line),
      // then on the child digest throw a non-404 error to exit the
      // tree mid-flight. Non-404 ensures the throw propagates rather
      // than being tolerated.
      mockPackageRepo.deletePackageVersion.mockImplementation(
        async (
          _pkg: string,
          _id: string,
          digest: string,
          _tags?: string[],
          _label?: string,
          logger?: { info: (msg: string) => void }
        ) => {
          logger?.info(` deleting package digest: ${digest}`)
          if (digest === 'sha256:child') {
            throw new Error('child delete blew up')
          }
        }
      )

      await expect(
        deleter.deleteImages(new Set(['sha256:parent']))
      ).rejects.toThrow(/child delete blew up/)

      const infoLines = vi
        .mocked(core.info)
        .mock.calls.map(args => String(args[0]))
        .filter(line => line.includes('deleting package'))
      // The parent's "deleting package" line MUST be visible — that's
      // the audit-trail invariant we're locking in. The child's line
      // is also present (the mock logs before throwing); both should
      // surface so the user can correlate against ghcr's actual state.
      expect(infoLines.some(l => l.includes('sha256:parent'))).toBe(true)
    })
  })
})
