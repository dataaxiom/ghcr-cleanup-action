import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'crypto'
import * as core from '@actions/core'
import axios from 'axios'
import { Registry } from '../registry'
import { Config, LogLevel } from '../config'

// Resolve to the rejection reason of `promise` (fails if it resolves).
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

// Single shared mock axios instance returned from every axios.create() call.
// Lets each test override .get/.put behavior per call.
const mockAxiosInstance = {
  get: vi.fn(),
  put: vi.fn(),
  defaults: { headers: { common: {} as Record<string, string> } },
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() }
  }
}

vi.mock('axios', () => {
  return {
    default: {
      create: vi.fn(() => mockAxiosInstance)
    },
    isAxiosError: vi.fn((err: any) => err && err.__isAxiosError === true)
  }
})

vi.mock('axios-logger', () => ({
  setGlobalConfig: vi.fn(),
  requestLogger: vi.fn(),
  responseLogger: vi.fn()
}))

vi.mock('@actions/core')

// Helper: build a fake AxiosError-shaped object the mocked isAxiosError will
// recognize.
interface FakeAxiosError {
  __isAxiosError: true
  response: {
    status: number
    headers: Record<string, string>
    data: string
  }
}

function fakeAxiosError(opts: {
  status?: number
  headers?: Record<string, string>
}): FakeAxiosError {
  return {
    __isAxiosError: true,
    response: {
      status: opts.status ?? 500,
      headers: opts.headers ?? {},
      data: ''
    }
  }
}

// A manifest as the registry serves it: its exact bytes (the Node adapter
// returns a Buffer for responseType 'arraybuffer') and their real digest.
const served = (
  manifest: object
): { digest: string; text: string; bytes: Buffer } => {
  const text = JSON.stringify(manifest)
  const bytes = Buffer.from(text, 'utf8')
  return {
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    text,
    bytes
  }
}

describe('Registry', () => {
  let config: Config
  let packageRepo: any
  let registry: Registry

  beforeEach(() => {
    vi.clearAllMocks()
    mockAxiosInstance.defaults.headers.common = {}

    config = new Config()
    config.owner = 'test-owner'
    config.token = 'test-token'
    config.logLevel = LogLevel.INFO

    packageRepo = {
      getDigestByTag: vi.fn()
    }

    registry = new Registry(config, packageRepo)
  })

  describe('retry configuration', () => {
    it('gives both registry clients a request timeout and the retry interceptor', () => {
      // The constructor (outer beforeEach) builds the manifest client and
      // the token-exchange client; both need the timeout (so a stalled
      // connection becomes a retryable timeout) and the retry policy from
      // http-retry.ts (exercised against real axios in http-retry.test.ts).
      const created = vi.mocked(axios).create.mock.calls.slice(-2)
      expect(created).toHaveLength(2)
      for (const [options] of created) {
        expect(options).toMatchObject({ timeout: 60_000 })
      }
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalledWith(
        undefined,
        expect.any(Function)
      )
      expect(
        vi
          .mocked(mockAxiosInstance.interceptors.response.use)
          .mock.calls.filter(([ok]) => ok === undefined).length
      ).toBeGreaterThanOrEqual(2)
    })
  })

  describe('login', () => {
    it('handles a 401 challenge, fetches a token, and sets the Authorization header', async () => {
      // 1st call: tags/list returns 401 with challenge.
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:pull"'
          }
        })
      )
      // 2nd call: token request returns { token: 'abc' }
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'abc' }
      })

      await registry.login('pkg')

      expect(mockAxiosInstance.defaults.headers.common['Authorization']).toBe(
        'Bearer abc'
      )
      // The exchanged token is masked like the input token.
      expect(core.setSecret).toHaveBeenCalledWith('abc')
    })

    it('requests the token from the challenge realm with service and scope encoded', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { token: 'abc' } })

      await registry.login('pkg')

      const [tokenUrl, options] = mockAxiosInstance.get.mock.calls[1]
      expect(tokenUrl).toBe(
        'https://ghcr.io/token?service=ghcr.io&scope=repository%3Atest-owner%2Fpkg%3Apull'
      )
      expect(options.auth.password).toBe('test-token')
    })

    it('never sends the token to a realm on another host', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://attacker.example/token",service="ghcr.io",scope="repository:test-owner/pkg:pull"'
          }
        })
      )

      await expect(registry.login('pkg')).rejects.toThrow(
        /refusing to send the token to https:\/\/attacker\.example/
      )
      // Only the challenge request went out; no token request.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
    })

    it('accepts a GitHub Enterprise Server realm on the GitHub server host', async () => {
      vi.stubEnv('GITHUB_SERVER_URL', 'https://ghes.example.com')
      try {
        config.registryUrl = 'https://containers.ghes.example.com/'
        const ghes = new Registry(config, packageRepo)
        mockAxiosInstance.get.mockRejectedValueOnce(
          fakeAxiosError({
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://ghes.example.com/token",service="containers.ghes.example.com",scope="repository:test-owner/pkg:pull"'
            }
          })
        )
        mockAxiosInstance.get.mockResolvedValueOnce({ data: { token: 'abc' } })

        await ghes.login('pkg')

        expect(mockAxiosInstance.get.mock.calls[1][0]).toMatch(
          /^https:\/\/ghes\.example\.com\/token\?/
        )
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('throws when the 401 response lacks a valid challenge', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="x"' }
        })
      )

      await expect(registry.login('pkg')).rejects.toThrow(
        /invalid www-authenticate challenge/
      )
    })

    it('throws a generic error without leaking the token-service response body', async () => {
      // 401 challenge, then a token exchange whose body carries a
      // credential under a key we do not read (access_token). The thrown
      // message must NOT echo that body into the (possibly public) log.
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { access_token: 'super-secret-credential' }
      })

      let message: string
      try {
        await registry.login('pkg')
        throw new Error('expected login to reject')
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(/login failed: token service returned no token/)
      expect(message).not.toContain('super-secret-credential')
    })

    it('rethrows non-401 axios errors instead of swallowing them', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({ status: 500 })
      )

      await expect(registry.login('pkg')).rejects.toBeDefined()
    })

    it('reports a non-401 login failure once, through the thrown error', async () => {
      // main's catch calls setFailed with the message; a setFailed here
      // too would report the failure twice.
      const the500 = fakeAxiosError({ status: 500 })
      mockAxiosInstance.get.mockRejectedValueOnce(the500)

      const err = (await rejectionOf(registry.login('pkg'))) as Error

      expect(err.message).toBe(
        'Error logging into registry API with package: pkg (HTTP 500)'
      )
      expect(err.cause).toBe(the500)
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    it('throws a clear error when a 401 has no www-authenticate header', async () => {
      // Proxy / misconfigured registry-url can 401 without a challenge;
      // must not crash with an opaque "Cannot read properties of undefined".
      const the401 = fakeAxiosError({ status: 401, headers: {} })
      mockAxiosInstance.get.mockRejectedValueOnce(the401)

      const err = await rejectionOf(registry.login('pkg'))
      expect((err as Error).message).toMatch(
        /401 without a www-authenticate challenge/
      )
      expect((err as Error).cause).toBe(the401)
    })

    it('rethrows non-axios errors', async () => {
      // Regression: an earlier catch only handled isAxiosError &&
      // error.response, so anything outside that shape silently resolved.
      const dnsError = new Error('ENOTFOUND ghcr.io')
      mockAxiosInstance.get.mockRejectedValueOnce(dnsError)

      await expect(registry.login('pkg')).rejects.toThrow('ENOTFOUND ghcr.io')
    })

    it('clears the manifest cache on each login call', async () => {
      // Seed the cache via a successful login + fetch, then login again and
      // confirm we re-fetch instead of returning cached data.
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} }) // initial tags/list
      await registry.login('pkg')

      // Prime the cache
      const m = served({ layers: [] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })
      await registry.getManifestByDigest(m.digest)

      // Re-login should clear the cache
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('pkg')

      // Next fetch should hit the wire again, not the cache
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })
      await registry.getManifestByDigest(m.digest)

      // tags/list (x2 logins) + manifest (x2 fetches) = 4 calls
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(4)
    })
  })

  describe('getManifestByDigest', () => {
    beforeEach(async () => {
      // Pre-login so subsequent calls use the instance directly
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('pkg')
      mockAxiosInstance.get.mockClear()
    })

    // A Registry wired to a real ManifestCache-shaped stub.
    const withCache = async (crossRunCache: {
      get: ReturnType<typeof vi.fn>
      set: ReturnType<typeof vi.fn>
    }): Promise<Registry> => {
      const r = new Registry(config, packageRepo, crossRunCache as any)
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await r.login('pkg')
      mockAxiosInstance.get.mockClear()
      return r
    }

    it('fetches the exact bytes, verifies them and parses the manifest', async () => {
      const m = served({ layers: [{ digest: 'sha256:layer' }] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })

      const result = await registry.getManifestByDigest(m.digest)

      expect(result).toEqual(JSON.parse(m.text))
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
      const [url, options] = mockAxiosInstance.get.mock.calls[0]
      expect(url).toBe(`/v2/test-owner/pkg/manifests/${m.digest}`)
      // Undecoded bytes: a string response would lose a leading BOM.
      expect(options.responseType).toBe('arraybuffer')
    })

    it('fails instead of using content that does not match the digest', async () => {
      const real = served({ layers: [] })
      const forged = served({
        manifests: [{ digest: 'sha256:live-image', size: 1 }]
      })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: forged.bytes })

      await expect(registry.getManifestByDigest(real.digest)).rejects.toThrow(
        `the registry returned content for ${real.digest} that does not match that digest`
      )
      // Nothing was cached: the next call fetches again.
      mockAxiosInstance.get.mockResolvedValueOnce({ data: real.bytes })
      await expect(registry.getManifestByDigest(real.digest)).resolves.toEqual(
        JSON.parse(real.text)
      )
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2)
    })

    it('fails on a digest it cannot verify', async () => {
      const m = served({ layers: [] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })

      await expect(registry.getManifestByDigest('sha256:abc')).rejects.toThrow(
        /does not match that digest/
      )
    })

    it('fails on an empty body', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: undefined })

      await expect(registry.getManifestByDigest('sha256:abc')).rejects.toThrow(
        'the registry returned a manifest with no body'
      )
    })

    it('hashes a byte-order mark as served and still parses the manifest', async () => {
      const text = `\ufeff${JSON.stringify({ layers: [] })}`
      const bytes = Buffer.from(text, 'utf8')
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      mockAxiosInstance.get.mockResolvedValueOnce({ data: bytes })

      await expect(registry.getManifestByDigest(digest)).resolves.toEqual({
        layers: []
      })
    })

    it('accepts an ArrayBuffer or typed-array body as the same bytes', async () => {
      const m = served({ layers: [] })
      const ab = m.bytes.buffer.slice(
        m.bytes.byteOffset,
        m.bytes.byteOffset + m.bytes.byteLength
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: ab })
      await expect(registry.getManifestByDigest(m.digest)).resolves.toEqual({
        layers: []
      })

      const n = served({ layers: [], n: 1 })
      // A view into a larger buffer: only its own bytes are hashed.
      const padded = Buffer.concat([
        Buffer.from('xx'),
        n.bytes,
        Buffer.from('yy')
      ])
      const view = new Uint8Array(
        padded.buffer,
        padded.byteOffset + 2,
        n.bytes.length
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: view })
      await expect(registry.getManifestByDigest(n.digest)).resolves.toEqual({
        layers: [],
        n: 1
      })
    })

    it('verifies a string body as its UTF-8 bytes', async () => {
      const m = served({ layers: [] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.text })
      await expect(registry.getManifestByDigest(m.digest)).resolves.toEqual({
        layers: []
      })

      // Another manifest's text served for a digest it does not match.
      const other = served({ layers: [3] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.text })
      await expect(registry.getManifestByDigest(other.digest)).rejects.toThrow(
        /does not match that digest/
      )
    })

    it('returns the cached manifest on the second call without refetching', async () => {
      const m = served({ layers: [] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })

      await registry.getManifestByDigest(m.digest)
      await registry.getManifestByDigest(m.digest)

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
    })

    it('serves from the cross-run cache on hit', async () => {
      const full = {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ digest: 'sha256:child', size: 0 }],
        subject: { digest: 'sha256:subject' }
      }
      const crossRunCache = { get: vi.fn().mockReturnValue(full), set: vi.fn() }
      const cachedRegistry = await withCache(crossRunCache)

      const result = await cachedRegistry.getManifestByDigest('sha256:abc')

      expect(crossRunCache.get).toHaveBeenCalledWith('sha256:abc')
      expect(mockAxiosInstance.get).not.toHaveBeenCalled()
      expect(result).toEqual(full)
      // Held in memory for the rest of the run.
      await cachedRegistry.getManifestByDigest('sha256:abc')
      expect(crossRunCache.get).toHaveBeenCalledTimes(1)
    })

    it('stores the exact verified text in the cross-run cache after a fetch', async () => {
      const crossRunCache = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn()
      }
      const cachedRegistry = await withCache(crossRunCache)
      const m = served({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        subject: { digest: 'sha256:subj' }
      })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })

      await cachedRegistry.getManifestByDigest(m.digest)

      expect(crossRunCache.set).toHaveBeenCalledWith(m.digest, m.text)
    })

    it('caches pretty-printed text exactly, whitespace and trailing newline included', async () => {
      // Registries commonly serve indented manifests ending in a newline;
      // the digest covers every byte of that.
      const crossRunCache = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn()
      }
      const cachedRegistry = await withCache(crossRunCache)
      const text = `${JSON.stringify({ schemaVersion: 2, layers: [] }, null, 3)}\n`
      const bytes = Buffer.from(text, 'utf8')
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      mockAxiosInstance.get.mockResolvedValueOnce({ data: bytes })

      await cachedRegistry.getManifestByDigest(digest)

      expect(crossRunCache.set).toHaveBeenCalledWith(digest, text)
    })

    it('does not touch the cross-run cache when verification fails', async () => {
      const crossRunCache = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn()
      }
      const cachedRegistry = await withCache(crossRunCache)
      const real = served({ layers: [] })
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: served({ layers: [1] }).bytes
      })

      await expect(
        cachedRegistry.getManifestByDigest(real.digest)
      ).rejects.toThrow(/does not match that digest/)
      expect(crossRunCache.set).not.toHaveBeenCalled()
    })

    it('caches end to end in a real ManifestCache only what verifies', async () => {
      const { ManifestCache } =
        await vi.importActual<typeof import('../manifest-cache')>(
          '../manifest-cache'
        )
      const real = new ManifestCache('test-owner', 'pkg')
      const r = new Registry(config, packageRepo, real)
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await r.login('pkg')
      const m = served({ layers: [{ digest: 'sha256:l' }] })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })

      await r.getManifestByDigest(m.digest)

      expect(real.size()).toBe(1)
      expect(real.get(m.digest)).toEqual(JSON.parse(m.text))
    })

    it('getRawManifestByDigest bypasses both in-memory and cross-run caches', async () => {
      const crossRunCache = {
        get: vi.fn().mockReturnValue({ manifests: [] }),
        set: vi.fn()
      }
      const cachedRegistry = await withCache(crossRunCache)
      const m = served({
        config: { mediaType: 'cfg', digest: 'sha256:cfg', size: 1 },
        layers: [{ mediaType: 'l', digest: 'sha256:l', size: 2 }]
      })
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })
      // Warm the in-memory cache with something else under the digest.
      ;(cachedRegistry as any).manifestCache.set(m.digest, { stale: true })

      const result = await cachedRegistry.getRawManifestByDigest(m.digest)

      expect(crossRunCache.get).not.toHaveBeenCalled()
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
      expect(result).toEqual(JSON.parse(m.text))
    })

    it('getRawManifestByDigest verifies too', async () => {
      const real = served({ layers: [] })
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: served({ layers: [2] }).bytes
      })

      await expect(
        registry.getRawManifestByDigest(real.digest)
      ).rejects.toThrow(/does not match that digest/)
    })
  })

  describe('getManifestByTag', () => {
    beforeEach(async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('pkg')
      mockAxiosInstance.get.mockClear()
    })

    it('looks up the digest for a tag and fetches that manifest', async () => {
      const m = served({ layers: [] })
      packageRepo.getDigestByTag.mockReturnValue(m.digest)
      mockAxiosInstance.get.mockResolvedValueOnce({ data: m.bytes })

      const result = await registry.getManifestByTag('latest')

      expect(packageRepo.getDigestByTag).toHaveBeenCalledWith('latest')
      expect(result).toEqual({ layers: [] })
    })

    it('returns undefined when the tag is unknown', async () => {
      packageRepo.getDigestByTag.mockReturnValue(undefined)

      const result = await registry.getManifestByTag('nonexistent')

      expect(result).toBeUndefined()
      expect(mockAxiosInstance.get).not.toHaveBeenCalled()
    })
  })

  describe('putManifest', () => {
    beforeEach(async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('pkg')
      mockAxiosInstance.get.mockClear()
      mockAxiosInstance.put.mockClear()
    })

    const sha256 = (bytes: Buffer): string =>
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`

    it('skips the network in dry-run mode but still returns the digest', async () => {
      config.dryRun = true

      const digest = await registry.putManifest(
        'latest',
        { mediaType: 'x' },
        false
      )

      expect(digest).toBe(sha256(Buffer.from('{"mediaType":"x"}')))
      expect(mockAxiosInstance.put).not.toHaveBeenCalled()
      expect(mockAxiosInstance.get).not.toHaveBeenCalled()
    })

    it('returns early when the first PUT succeeds without a challenge', async () => {
      // Regression: an earlier flow threw "no token set to upload manifest"
      // on this path even though the upload succeeded.
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })

      const digest = await registry.putManifest(
        'latest',
        { mediaType: 'x' },
        false
      )

      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1)
      // It sends one serialized Buffer and returns that Buffer's sha256 —
      // the digest the registry assigns to the version it creates.
      const sent = mockAxiosInstance.put.mock.calls[0][1]
      expect(Buffer.isBuffer(sent)).toBe(true)
      expect(digest).toBe(sha256(sent))
    })

    it('on 401, fetches a push token and retries the PUT with auth', async () => {
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'push-token' }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })

      const digest = await registry.putManifest(
        'latest',
        { mediaType: 'x' },
        false
      )

      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(2)
      // Second PUT should carry the push token in its Authorization header
      const secondPutCall = mockAxiosInstance.put.mock.calls[1]
      expect(secondPutCall[2].headers.Authorization).toBe('Bearer push-token')
      // Both PUTs send the same bytes, and the digest is of those bytes.
      expect(secondPutCall[1]).toBe(mockAxiosInstance.put.mock.calls[0][1])
      expect(digest).toBe(sha256(secondPutCall[1]))
      // The exchanged push token is masked.
      expect(core.setSecret).toHaveBeenCalledWith('push-token')
    })

    it('throws if the 401 challenge produces no token', async () => {
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).rejects.toThrow(/failed to obtain push token/)
    })

    it('accepts a matching Docker-Content-Digest from the registry', async () => {
      const expected = sha256(Buffer.from('{"mediaType":"x"}'))
      mockAxiosInstance.put.mockResolvedValueOnce({
        status: 201,
        headers: { 'docker-content-digest': expected }
      })

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).resolves.toBe(expected)
    })

    it('fails when the registry stored the manifest under a different digest (no-challenge path)', async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({
        status: 201,
        headers: { 'docker-content-digest': 'sha256:somethingelse' }
      })

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).rejects.toThrow(/stored the manifest as sha256:somethingelse/)
    })

    it('fails on a digest mismatch after the token exchange too', async () => {
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'push-token' }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({
        status: 201,
        headers: { 'docker-content-digest': 'sha256:somethingelse' }
      })

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).rejects.toThrow(/stored the manifest as sha256:somethingelse/)
    })

    it('rethrows non-401 errors from the first PUT', async () => {
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({ status: 500 })
      )

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).rejects.toBeDefined()
    })

    it('throws a clear error when a push 401 has no www-authenticate header', async () => {
      const the401 = fakeAxiosError({ status: 401, headers: {} })
      mockAxiosInstance.put.mockRejectedValueOnce(the401)

      const err = await rejectionOf(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      )
      expect((err as Error).message).toMatch(
        /401 without a www-authenticate challenge/
      )
      expect((err as Error).cause).toBe(the401)
    })

    it('reuses a cached push token across calls without re-exchanging on 401', async () => {
      // First PUT: 401 → token exchange → authed PUT.
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'push-token', expires_in: 300 }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })

      await registry.putManifest('tag1', { mediaType: 'x' }, false)

      // Second PUT: should use the cached token and skip the challenge.
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })
      const digest2 = await registry.putManifest(
        'tag2',
        { mediaType: 'y' },
        false
      )

      // Only one token-exchange GET across both putManifest calls.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
      // Three PUTs total: the initial unauthed 401-triggering PUT, the
      // authed retry on tag1, and the fast-path PUT on tag2.
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(3)
      // tag2's PUT carried the cached bearer token from the start.
      const tag2Call = mockAxiosInstance.put.mock.calls[2]
      expect(tag2Call[2].headers.Authorization).toBe('Bearer push-token')
      // The fast path also sends exactly the bytes whose digest it returns.
      expect(tag2Call[1]).toEqual(Buffer.from('{"mediaType":"y"}'))
      expect(digest2).toBe(sha256(tag2Call[1]))
    })

    it('drops a cached token that the server later rejects and re-exchanges', async () => {
      // Prime the cache via a normal 401-challenge flow.
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'token-A', expires_in: 300 }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })
      await registry.putManifest('tag1', { mediaType: 'x' }, false)

      // Second call: cached-token PUT is rejected with 401 (mid-TTL
      // revocation). Implementation must fall through to a fresh
      // challenge exchange and retry.
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({ status: 401, headers: {} })
      )
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'token-B', expires_in: 300 }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })

      await registry.putManifest('tag2', { mediaType: 'x' }, false)

      // Two token exchanges total — the original and the post-rejection one.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2)
      // Final PUT used the refreshed token-B.
      const finalCall = mockAxiosInstance.put.mock.calls.at(-1)
      expect(finalCall?.[2].headers.Authorization).toBe('Bearer token-B')
    })

    it('clears the cached push token when login() switches package', async () => {
      // First package: prime the cache.
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'pkg-token', expires_in: 300 }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })
      await registry.putManifest('tag1', { mediaType: 'x' }, false)

      // Switch packages. login() does its own tags/list call (resolved
      // here without a challenge to keep the setup short).
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('other-pkg')

      // Next putManifest must NOT use the stale pkg-token. Expect a
      // fresh challenge handshake.
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:test-owner/other-pkg:push,pull"'
          }
        })
      )
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { token: 'other-token', expires_in: 300 }
      })
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })
      await registry.putManifest('tag2', { mediaType: 'x' }, false)

      // First PUT on the second package paid a challenge — would not
      // happen if the prior cache had leaked across the login boundary.
      const tag2FirstPut = mockAxiosInstance.put.mock.calls[2]
      expect(tag2FirstPut[2]?.headers?.Authorization).toBeUndefined()
    })
  })
})
