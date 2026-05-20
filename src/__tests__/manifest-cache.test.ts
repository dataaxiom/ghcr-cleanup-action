import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import {
  ManifestCache,
  distillManifest,
  reconstituteManifest
} from '../manifest-cache'
import { Manifest } from '../utils'

vi.mock('@actions/cache', () => ({
  isFeatureAvailable: vi.fn(() => false),
  restoreCache: vi.fn(),
  saveCache: vi.fn()
}))

vi.mock('@actions/core')

describe('manifest-cache', () => {
  describe('distillManifest', () => {
    it('captures multi-arch child descriptors', () => {
      const manifest: Manifest = {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          {
            digest: 'sha256:child1',
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            size: 1234,
            platform: { architecture: 'amd64', os: 'linux' }
          },
          {
            digest: 'sha256:child2',
            platform: { architecture: 'arm64', os: 'linux', variant: 'v8' }
          }
        ]
      }

      const distilled = distillManifest(manifest)

      expect(distilled.mediaType).toBe(
        'application/vnd.oci.image.index.v1+json'
      )
      expect(distilled.manifestEntries).toHaveLength(2)
      expect(distilled.manifestEntries?.[0].digest).toBe('sha256:child1')
      expect(distilled.manifestEntries?.[1].platform?.variant).toBe('v8')
    })

    it('captures OCI 1.1 subject descriptor', () => {
      const manifest: Manifest = {
        subject: {
          digest: 'sha256:subject-target',
          size: 0
        }
      }

      const distilled = distillManifest(manifest)
      expect(distilled.subjectDigest).toBe('sha256:subject-target')
    })

    it('captures first layer media type for in-toto detection', () => {
      const manifest: Manifest = {
        layers: [
          {
            mediaType: 'application/vnd.in-toto+json',
            digest: 'sha256:l',
            size: 1
          }
        ]
      }

      const distilled = distillManifest(manifest)
      expect(distilled.firstLayerMediaType).toBe('application/vnd.in-toto+json')
    })

    it('does not capture layer descriptor digest or size', () => {
      const manifest: Manifest = {
        layers: [{ mediaType: 'foo', digest: 'sha256:secret', size: 99 }]
      }
      const distilled = distillManifest(manifest)
      // We deliberately only persist the media type — layer digests are
      // never read by the cleanup pipeline.
      expect(JSON.stringify(distilled)).not.toContain('sha256:secret')
    })

    it('returns empty object for minimal manifest', () => {
      expect(distillManifest({})).toEqual({})
    })
  })

  describe('reconstituteManifest', () => {
    it('round-trips manifests array and subject', () => {
      const original: Manifest = {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          {
            digest: 'sha256:c1',
            platform: { architecture: 'amd64', os: 'linux' }
          }
        ],
        subject: { digest: 'sha256:s1' }
      }

      const round = reconstituteManifest(distillManifest(original))
      expect(round.mediaType).toBe(original.mediaType)
      expect(round.manifests?.[0].digest).toBe('sha256:c1')
      expect(round.subject?.digest).toBe('sha256:s1')
    })

    it('reconstitutes layers[0].mediaType for in-toto check', () => {
      const distilled = distillManifest({
        layers: [
          { mediaType: 'application/vnd.in-toto+json', digest: 'd', size: 0 }
        ]
      })
      const round = reconstituteManifest(distilled)
      expect(round.layers?.[0].mediaType).toBe('application/vnd.in-toto+json')
    })

    it('returns empty manifest when distilled is empty', () => {
      expect(reconstituteManifest({})).toEqual({})
    })
  })

  describe('ManifestCache.prune', () => {
    it('drops entries whose digest is not in the live set', () => {
      const mc = new ManifestCache('owner', 'pkg')
      mc.set('sha256:keep1', { mediaType: 'a' })
      mc.set('sha256:keep2', { mediaType: 'b' })
      mc.set('sha256:stale', { mediaType: 'c' })

      const dropped = mc.prune(new Set(['sha256:keep1', 'sha256:keep2']))

      expect(dropped).toBe(1)
      expect(mc.get('sha256:keep1')).toBeDefined()
      expect(mc.get('sha256:keep2')).toBeDefined()
      expect(mc.get('sha256:stale')).toBeUndefined()
      expect(mc.size()).toBe(2)
    })

    it('is a no-op when every cached digest is live', () => {
      const mc = new ManifestCache('owner', 'pkg')
      mc.set('sha256:a', { mediaType: 'a' })
      mc.set('sha256:b', { mediaType: 'b' })

      const dropped = mc.prune(
        new Set(['sha256:a', 'sha256:b', 'sha256:extra'])
      )

      expect(dropped).toBe(0)
      expect(mc.size()).toBe(2)
    })
  })

  describe('save', () => {
    beforeEach(() => {
      vi.mocked(cache.isFeatureAvailable).mockReturnValue(true)
      vi.mocked(cache.saveCache).mockReset()
      vi.mocked(cache.saveCache).mockResolvedValue(0)
      vi.mocked(core.info).mockReset()
    })

    it('uploads once with the run-scoped key', async () => {
      const c = new ManifestCache('owner', 'pkg')
      c.set('sha256:a', { mediaType: 'a' })
      await c.save()

      expect(cache.saveCache).toHaveBeenCalledTimes(1)
      const [, key] = vi.mocked(cache.saveCache).mock.calls[0]
      // Key format: ghcr-manifest-v1-<owner>-<pkg>-<runId>
      expect(key).toMatch(/^ghcr-manifest-v1-owner-pkg-.+$/)
    })

    it('is a no-op when nothing was fetched (empty map)', async () => {
      const c = new ManifestCache('owner', 'pkg')
      // No set() calls — map is empty.
      await c.save()
      expect(cache.saveCache).not.toHaveBeenCalled()
    })

    it('logs a friendly info (not warning) when saveCache returns -1', async () => {
      // -1 happens when an earlier job in the same workflow already
      // wrote this key. Expected; not an error.
      vi.mocked(cache.saveCache).mockResolvedValueOnce(-1)

      const c = new ManifestCache('owner', 'pkg')
      c.set('sha256:a', { mediaType: 'a' })
      await c.save()

      const infoCalls = vi.mocked(core.info).mock.calls.map(a => a[0])
      expect(
        infoCalls.find(m => m.includes('already saved by an earlier job'))
      ).toBeDefined()
      // No "saved N entries" success log on the conflict path.
      expect(infoCalls.find(m => /saved \d+ entries/.test(m))).toBeUndefined()
    })
  })

  describe('effectiveness reporting', () => {
    beforeEach(() => {
      vi.mocked(cache.isFeatureAvailable).mockReturnValue(true)
      vi.mocked(cache.saveCache).mockReset()
      vi.mocked(cache.saveCache).mockResolvedValue(0)
      vi.mocked(core.info).mockReset()
    })

    it('get() tracks hits and misses for cross-run reads', () => {
      const c = new ManifestCache('owner', 'pkg')
      c.set('sha256:a', { mediaType: 'a' })

      // 2 hits + 1 miss
      c.get('sha256:a')
      c.get('sha256:a')
      c.get('sha256:missing')

      expect(c.getStats()).toEqual({ hits: 2, misses: 1 })
    })

    it('save() logs a hit-rate summary', async () => {
      const c = new ManifestCache('owner', 'pkg')
      c.set('sha256:a', { mediaType: 'a' })
      c.get('sha256:a')
      c.get('sha256:missing')

      await c.save()

      const calls = vi.mocked(core.info).mock.calls.map(args => args[0])
      const summary = calls.find(msg =>
        msg.includes('digests served from cache')
      )
      expect(summary).toBeDefined()
      expect(summary).toMatch(/1\/2 digests served from cache \(50%\)/)
      expect(summary).toMatch(/1 fetched from registry/)
    })

    it('emits no summary when there were no reads', async () => {
      const c = new ManifestCache('owner', 'pkg')
      c.set('sha256:a', { mediaType: 'a' })
      // No gets — total reads = 0, summary is suppressed.

      await c.save()

      const calls = vi.mocked(core.info).mock.calls.map(args => args[0])
      const summary = calls.find(msg => msg.includes('served from cache'))
      expect(summary).toBeUndefined()
    })
  })
})
