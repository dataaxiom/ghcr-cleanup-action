import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { ManifestCache } from '../manifest-cache'

vi.mock('@actions/cache', () => ({
  isFeatureAvailable: vi.fn(() => false),
  restoreCache: vi.fn(),
  saveCache: vi.fn()
}))

vi.mock('@actions/core')

// A content-addressed fixture: the manifest's exact text and its real
// sha256 digest, as the registry would serve them.
interface Fixture {
  digest: string
  text: string
}
const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const fixture = (manifest: object): Fixture => {
  const text = JSON.stringify(manifest)
  return { digest: sha256(text), text }
}
const record = (f: Fixture): string =>
  JSON.stringify({ digest: f.digest, manifest: f.text })

const A = fixture({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: 'sha256:cfg-a' },
  layers: [
    { mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: 'sha256:l' }
  ]
})
const B = fixture({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [{ digest: 'sha256:child', mediaType: 'x', size: 1 }]
})
const C = fixture({ schemaVersion: 2, subject: { digest: 'sha256:subj' } })

describe('manifest-cache', () => {
  describe('ManifestCache.prune', () => {
    it('drops entries whose digest is not in the live set', () => {
      const mc = new ManifestCache('owner', 'pkg')
      mc.set(A.digest, A.text)
      mc.set(B.digest, B.text)
      mc.set(C.digest, C.text)

      const dropped = mc.prune(new Set([A.digest, B.digest]))

      expect(dropped).toBe(1)
      expect(mc.get(A.digest)).toBeDefined()
      expect(mc.get(B.digest)).toBeDefined()
      expect(mc.get(C.digest)).toBeUndefined()
      expect(mc.size()).toBe(2)
    })

    it('is a no-op when every cached digest is live', () => {
      const mc = new ManifestCache('owner', 'pkg')
      mc.set(A.digest, A.text)
      mc.set(B.digest, B.text)

      const dropped = mc.prune(new Set([A.digest, B.digest, 'sha256:extra']))

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
      c.set(A.digest, A.text)
      await c.save()

      expect(cache.saveCache).toHaveBeenCalledTimes(1)
      const [, key] = vi.mocked(cache.saveCache).mock.calls[0]
      // Key format: ghcr-manifest-v2-<owner>-<pkg>-<runId>
      expect(key).toMatch(/^ghcr-manifest-v2-owner-pkg-.+$/)
    })

    it('sanitizes owner too, so it cannot escape the cache root', async () => {
      const c = new ManifestCache('../../evil', 'pkg')
      c.set(A.digest, A.text)
      await c.save()

      const [paths, key] = vi.mocked(cache.saveCache).mock.calls[0]
      const root = path.join(
        process.env.RUNNER_TEMP || os.tmpdir(),
        'ghcr-cleanup-manifest-cache'
      )
      // One directory directly under the cache root: the `/`s are gone, so
      // `..` survives only as plain characters in that directory's name.
      expect(path.dirname(path.resolve(paths[0]))).toBe(path.resolve(root))
      expect(key).not.toContain('/')
    })

    it('is a no-op when nothing was fetched (empty map)', async () => {
      const c = new ManifestCache('owner', 'pkg')
      // No set() calls — map is empty.
      await c.save()
      expect(cache.saveCache).not.toHaveBeenCalled()
    })

    it('logs a friendly info (not warning) when saveCache returns -1', async () => {
      // -1 happens when the run's cache is read-only, when an earlier
      // job in the same workflow already wrote this key, or when the
      // upload failed; the library logs which. Expected; not an error,
      // and the message must not guess the reason.
      vi.mocked(cache.saveCache).mockResolvedValueOnce(-1)
      vi.mocked(core.warning).mockClear()

      const c = new ManifestCache('owner', 'pkg')
      c.set(A.digest, A.text)
      await c.save()

      const infoCalls = vi.mocked(core.info).mock.calls.map(a => a[0])
      expect(infoCalls).toContainEqual(
        expect.stringMatching(
          /^manifest cache: not saved as ghcr-manifest-v2-owner-pkg-.+ \(reason logged above\); the next run restores the newest saved cache$/
        )
      )
      expect(core.warning).not.toHaveBeenCalled()
      // No "saved N entries" success log on the conflict path.
      expect(infoCalls.find(m => /saved \d+ entries/.test(m))).toBeUndefined()
    })
  })

  describe('restore + dirty tracking', () => {
    // Seed a real on-disk NDJSON file so the production `loadFromDisk`
    // path runs unmodified. Each test gets a fresh RUNNER_TEMP so cache
    // dirs don't collide across cases.
    let tmpRoot: string
    const originalRunnerTemp = process.env.RUNNER_TEMP

    function seedCacheFile(owner: string, pkg: string, contents: string): void {
      const safePackage = pkg.replace(/[^a-zA-Z0-9._-]/g, '_')
      const dir = path.join(
        tmpRoot,
        'ghcr-cleanup-manifest-cache',
        `${owner}-${safePackage}`
      )
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'manifests.ndjson'), contents)
    }

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-cache-test-'))
      process.env.RUNNER_TEMP = tmpRoot
      vi.mocked(cache.isFeatureAvailable).mockReturnValue(true)
      vi.mocked(cache.restoreCache).mockReset()
      vi.mocked(cache.saveCache).mockReset().mockResolvedValue(0)
      vi.mocked(core.info).mockReset()
      vi.mocked(core.warning).mockReset()
    })

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      if (originalRunnerTemp === undefined) {
        delete process.env.RUNNER_TEMP
      } else {
        process.env.RUNNER_TEMP = originalRunnerTemp
      }
    })

    it('save() skips upload when restore loaded entries and nothing changed', async () => {
      seedCacheFile('owner', 'pkg', `${record(A)}\n`)
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key')

      const c = new ManifestCache('owner', 'pkg')
      await c.restore()
      expect(c.size()).toBe(1)

      await c.save()

      expect(cache.saveCache).not.toHaveBeenCalled()
      const infoCalls = vi.mocked(core.info).mock.calls.map(args => args[0])
      expect(
        infoCalls.find(m => m.includes('unchanged since restore'))
      ).toBeDefined()
    })

    it('save() uploads when set() was called after restore', async () => {
      seedCacheFile('owner', 'pkg', `${record(A)}\n`)
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key')

      const c = new ManifestCache('owner', 'pkg')
      await c.restore()
      c.set(C.digest, C.text)

      await c.save()

      expect(cache.saveCache).toHaveBeenCalledTimes(1)
    })

    it('save() uploads when prune() removed entries', async () => {
      seedCacheFile('owner', 'pkg', [record(A), record(B)].join('\n'))
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key')

      const c = new ManifestCache('owner', 'pkg')
      await c.restore()
      c.prune(new Set([A.digest])) // drops b

      await c.save()

      expect(cache.saveCache).toHaveBeenCalledTimes(1)
    })

    it('save() skips upload when prune() found nothing to drop', async () => {
      seedCacheFile('owner', 'pkg', `${record(A)}\n`)
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key')

      const c = new ManifestCache('owner', 'pkg')
      await c.restore()
      c.prune(new Set([A.digest])) // no-op

      await c.save()

      expect(cache.saveCache).not.toHaveBeenCalled()
    })

    // Restore a seeded file; returns the cache and the warnings logged.
    async function restoreFrom(
      lines: string[]
    ): Promise<{ c: ManifestCache; warnings: string[] }> {
      seedCacheFile('owner', 'pkg', `${lines.join('\n')}\n`)
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key')
      const c = new ManifestCache('owner', 'pkg')
      await c.restore()
      const warnings = vi.mocked(core.warning).mock.calls.map(a => a[0])
      return { c, warnings }
    }

    // A forged record: B's digest, but the children list rewritten to
    // point the delete cascade at another image.
    const forgedB = (): string => {
      const forged = JSON.parse(B.text)
      forged.manifests = [
        { digest: 'sha256:live-image', mediaType: 'x', size: 1 }
      ]
      return JSON.stringify({
        digest: B.digest,
        manifest: JSON.stringify(forged)
      })
    }

    it('restores every entry when all of them verify', async () => {
      const { c, warnings } = await restoreFrom([
        record(A),
        record(B),
        record(C)
      ])

      expect(c.size()).toBe(3)
      expect(c.get(A.digest)).toEqual(JSON.parse(A.text))
      expect(warnings).toEqual([])
    })

    it('discards the whole cache when one entry does not hash to its digest', async () => {
      // The valid entries are dropped too: nothing in a tampered file is
      // trusted.
      const { c, warnings } = await restoreFrom([
        record(A),
        forgedB(),
        record(C)
      ])

      expect(c.size()).toBe(0)
      expect(c.get(A.digest)).toBeUndefined()
      expect(c.get(B.digest)).toBeUndefined()
      expect(warnings).toEqual([
        'manifest cache: 1 of 3 entries in hit-key failed verification (1 not matching their digest, 0 malformed); the cache may have been corrupted or tampered with, so the whole cache is discarded and every manifest will be fetched from the registry'
      ])
    })

    it('discards the whole cache when one entry is malformed', async () => {
      const { c, warnings } = await restoreFrom([
        record(A),
        '{not-json',
        record(B),
        '{"mediaType":"no-digest"}',
        ''
      ])

      expect(c.size()).toBe(0)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(
        '2 of 4 entries in hit-key failed verification (0 not matching their digest, 2 malformed)'
      )
    })

    it('discards a file of garbage', async () => {
      const { c, warnings } = await restoreFrom([
        'binary\x00garbage',
        '{also bad'
      ])

      expect(c.size()).toBe(0)
      expect(warnings[0]).toContain('whole cache is discarded')
    })

    it('discards on a record whose text is changed by even one byte', async () => {
      const { c } = await restoreFrom([
        record(A),
        JSON.stringify({ digest: B.digest, manifest: `${B.text} ` })
      ])

      expect(c.size()).toBe(0)
    })

    it('discards on digests it cannot verify: unknown algorithm, upper case, wrong length', async () => {
      const hex = A.digest.slice('sha256:'.length)
      for (const digest of [
        `md5:${hex}`,
        `sha256:${hex.toUpperCase()}`,
        `sha256:${hex.slice(1)}`,
        hex,
        'sha256:'
      ]) {
        vi.mocked(core.warning).mockClear()
        const { c } = await restoreFrom([
          record(B),
          JSON.stringify({ digest, manifest: A.text })
        ])
        expect(c.size()).toBe(0)
      }
    })

    it('discards on a lone surrogate that encodes to the verified bytes', async () => {
      // U+FFFD in the real manifest; a lone surrogate in the forged text
      // encodes to the same UTF-8 bytes, so only a well-formedness check
      // tells them apart.
      const real = fixture({ schemaVersion: 2, annotations: { a: '\ufffd' } })
      const forgedText = real.text.replace('\ufffd', '\ud800')
      expect(Buffer.from(forgedText, 'utf8')).toEqual(
        Buffer.from(real.text, 'utf8')
      )

      const { c } = await restoreFrom([
        record(A),
        JSON.stringify({ digest: real.digest, manifest: forgedText })
      ])

      expect(c.size()).toBe(0)
    })

    it('treats a v1 (distilled) record as malformed, never as a manifest', async () => {
      const { c, warnings } = await restoreFrom([
        JSON.stringify({
          digest: A.digest,
          mediaType: 'x',
          manifestEntries: []
        })
      ])

      expect(c.size()).toBe(0)
      expect(warnings[0]).toContain(
        '(0 not matching their digest, 1 malformed)'
      )
    })

    it('accepts sha512 digests', async () => {
      const digest = `sha512:${createHash('sha512').update(A.text).digest('hex')}`
      const { c } = await restoreFrom([
        JSON.stringify({ digest, manifest: A.text })
      ])

      expect(c.get(digest)).toEqual(JSON.parse(A.text))
    })

    it('replaces a discarded cache on save, even when nothing was fetched', async () => {
      // Otherwise the bad file stays the newest entry every later run
      // restores (and warns about).
      const { c } = await restoreFrom([forgedB()])
      expect(c.size()).toBe(0)

      await c.save()

      expect(cache.saveCache).toHaveBeenCalledTimes(1)
      const [dir] = vi.mocked(cache.saveCache).mock.calls[0][0]
      const saved = fs.readFileSync(path.join(dir, 'manifests.ndjson'), 'utf8')
      expect(saved.trim()).toBe('')

      // And the replacement restores cleanly, without warnings.
      vi.mocked(core.warning).mockClear()
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key-2')
      const next = new ManifestCache('owner', 'pkg')
      await next.restore()
      expect(core.warning).not.toHaveBeenCalled()
    })

    it('saves the refetched manifests after a discard', async () => {
      const { c } = await restoreFrom([forgedB()])
      c.set(B.digest, B.text)

      await c.save()

      const [dir] = vi.mocked(cache.saveCache).mock.calls[0][0]
      const saved = fs.readFileSync(path.join(dir, 'manifests.ndjson'), 'utf8')
      expect(saved).toBe(`${record(B)}\n`)
    })

    it('saves records that restore exactly (text byte for byte)', async () => {
      const writer = new ManifestCache('owner', 'pkg')
      writer.set(A.digest, A.text)
      writer.set(B.digest, B.text)
      await writer.save()
      expect(cache.saveCache).toHaveBeenCalledTimes(1)

      // The archive the next run restores is this same directory.
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key')
      const reader = new ManifestCache('owner', 'pkg')
      await reader.restore()

      expect(reader.size()).toBe(2)
      expect(reader.get(A.digest)).toEqual(JSON.parse(A.text))
      expect(reader.get(B.digest)).toEqual(JSON.parse(B.text))
      const [dir] = vi.mocked(cache.saveCache).mock.calls[0][0]
      const lines = fs
        .readFileSync(path.join(dir, 'manifests.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(lines).toEqual([
        { digest: A.digest, manifest: A.text },
        { digest: B.digest, manifest: B.text }
      ])
    })

    it('keeps restored text byte for byte through a later save and restore', async () => {
      // Pretty-printed text with a trailing newline, as registries serve.
      const text = `${JSON.stringify(JSON.parse(A.text), null, 3)}\n`
      const digest = sha256(text)
      const { c } = await restoreFrom([
        JSON.stringify({ digest, manifest: text })
      ])
      expect(c.size()).toBe(1)
      c.set(B.digest, B.text) // make it dirty so it saves

      await c.save()

      const [dir] = vi.mocked(cache.saveCache).mock.calls[0][0]
      const lines = fs
        .readFileSync(path.join(dir, 'manifests.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(lines[0]).toEqual({ digest, manifest: text })
      vi.mocked(cache.restoreCache).mockResolvedValueOnce('hit-key-2')
      const next = new ManifestCache('owner', 'pkg')
      await next.restore()
      expect(next.size()).toBe(2)
    })

    it('wipes partial state when restoreCache throws mid-restore', async () => {
      vi.mocked(cache.restoreCache).mockRejectedValueOnce(
        new Error('boom: network failed mid-restore')
      )

      const c = new ManifestCache('owner', 'pkg')
      // Pre-seed in-memory state so we can prove restore() wipes on error.
      c.set(C.digest, C.text)
      await c.restore()

      expect(c.size()).toBe(0)
      const warnings = vi.mocked(core.warning).mock.calls.map(args => args[0])
      expect(warnings.find(m => m.includes('restore failed'))).toBeDefined()
    })
  })

  describe('set() and get() verification', () => {
    it('set() refuses text that does not hash to the digest', () => {
      const c = new ManifestCache('owner', 'pkg')
      expect(c.set(A.digest, B.text)).toBe(false)
      expect(c.size()).toBe(0)
      expect(c.get(A.digest)).toBeUndefined()
    })

    it('set() refuses text with a lone surrogate, even if its bytes verify', () => {
      const real = fixture({ schemaVersion: 2, annotations: { a: '\ufffd' } })
      const c = new ManifestCache('owner', 'pkg')
      expect(c.set(real.digest, real.text.replace('\ufffd', '\ud800'))).toBe(
        false
      )
      expect(c.set(real.digest, real.text)).toBe(true)
    })

    it('set() accepts matching text and get() returns the whole manifest', () => {
      const c = new ManifestCache('owner', 'pkg')
      expect(c.set(A.digest, A.text)).toBe(true)
      // The full manifest, not a summary: layer digests included.
      expect(c.get(A.digest)).toEqual(JSON.parse(A.text))
      expect(c.get(A.digest)?.layers?.[0].digest).toBe('sha256:l')
    })

    it('a refused set() does not mark the cache dirty', async () => {
      vi.mocked(cache.isFeatureAvailable).mockReturnValue(true)
      vi.mocked(cache.saveCache).mockReset().mockResolvedValue(0)
      const c = new ManifestCache('owner', 'pkg')
      c.set(A.digest, B.text)
      await c.save()
      expect(cache.saveCache).not.toHaveBeenCalled()
    })

    it('handles a byte-order mark the digest covers', () => {
      const text = `\ufeff${A.text}`
      const digest = sha256(Buffer.from(text, 'utf8'))
      const c = new ManifestCache('owner', 'pkg')
      expect(c.set(digest, text)).toBe(true)
      expect(c.get(digest)).toEqual(JSON.parse(A.text))
    })

    it('get() drops a verified entry that is not a JSON object and reports a miss', () => {
      const c = new ManifestCache('owner', 'pkg')
      const notJson = 'not json'
      const array = '[1]'
      c.set(sha256(notJson), notJson)
      c.set(sha256(array), array)

      expect(c.get(sha256(notJson))).toBeUndefined()
      expect(c.get(sha256(array))).toBeUndefined()
      expect(c.size()).toBe(0)
      expect(c.getStats()).toEqual({ hits: 0, misses: 2 })
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
      c.set(A.digest, A.text)

      // 2 hits + 1 miss
      c.get(A.digest)
      c.get(A.digest)
      c.get('sha256:missing')

      expect(c.getStats()).toEqual({ hits: 2, misses: 1 })
    })

    it('save() logs a hit-rate summary', async () => {
      const c = new ManifestCache('owner', 'pkg')
      c.set(A.digest, A.text)
      c.get(A.digest)
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
      c.set(A.digest, A.text)
      // No gets — total reads = 0, summary is suppressed.

      await c.save()

      const calls = vi.mocked(core.info).mock.calls.map(args => args[0])
      const summary = calls.find(msg => msg.includes('served from cache'))
      expect(summary).toBeUndefined()
    })
  })
})
