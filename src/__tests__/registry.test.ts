import { describe, it, expect, beforeEach, vi } from 'vitest'
import axiosRetry from 'axios-retry'
import { Registry } from '../registry'
import { Config, LogLevel } from '../config'

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

vi.mock('axios-retry', () => {
  // axios-retry's default export is a function that also carries
  // utility helpers as properties. registry.ts reads both.
  const axiosRetryMock = vi.fn() as ReturnType<typeof vi.fn> & {
    isNetworkOrIdempotentRequestError: ReturnType<typeof vi.fn>
    exponentialDelay: ReturnType<typeof vi.fn>
  }
  axiosRetryMock.isNetworkOrIdempotentRequestError = vi.fn(() => false)
  axiosRetryMock.exponentialDelay = vi.fn(() => 0)
  return { default: axiosRetryMock }
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
    it('retries on 429 responses (rate limit) in addition to network/5xx', () => {
      // The Registry constructor in beforeEach already configured
      // axios-retry. Pull the most recent call's config and exercise
      // the retryCondition directly.
      const lastCall = vi.mocked(axiosRetry).mock.calls.at(-1)
      const cfg = lastCall?.[1]
      const retryCondition = cfg?.retryCondition
      expect(retryCondition).toBeDefined()
      if (!retryCondition) return

      // 429 must retry — that's the new behavior we added on top of
      // axios-retry's default network/idempotent check.
      expect(retryCondition({ response: { status: 429 } } as never)).toBe(true)
      // Non-rate-limit errors fall through to
      // isNetworkOrIdempotentRequestError (mocked to false here).
      expect(retryCondition({ response: { status: 400 } } as never)).toBe(false)
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

    it('rethrows non-401 axios errors instead of swallowing them', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        fakeAxiosError({ status: 500 })
      )

      await expect(registry.login('pkg')).rejects.toBeDefined()
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
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify({ layers: [] })
      })
      await registry.getManifestByDigest('sha256:cached')

      // Re-login should clear the cache
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('pkg')

      // Next fetch should hit the wire again, not the cache
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify({ layers: [] })
      })
      await registry.getManifestByDigest('sha256:cached')

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

    it('fetches and parses a manifest on cache miss', async () => {
      const manifest = { layers: [{ digest: 'sha256:layer' }] }
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify(manifest)
      })

      const result = await registry.getManifestByDigest('sha256:abc')

      expect(result).toEqual(manifest)
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
    })

    it('returns the cached manifest on the second call without refetching', async () => {
      const manifest = { layers: [] }
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify(manifest)
      })

      await registry.getManifestByDigest('sha256:abc')
      await registry.getManifestByDigest('sha256:abc')

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
    })

    it('serves from the cross-run distilled cache on hit', async () => {
      const distilledCache = {
        get: vi.fn().mockReturnValue({
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifestEntries: [{ digest: 'sha256:child', size: 0 }],
          subjectDigest: 'sha256:subject'
        }),
        set: vi.fn()
      }
      const cachedRegistry = new Registry(
        config,
        packageRepo,
        distilledCache as any
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await cachedRegistry.login('pkg')
      mockAxiosInstance.get.mockClear()

      const result = await cachedRegistry.getManifestByDigest('sha256:abc')

      expect(distilledCache.get).toHaveBeenCalledWith('sha256:abc')
      expect(mockAxiosInstance.get).not.toHaveBeenCalled()
      expect(result.manifests?.[0].digest).toBe('sha256:child')
      expect(result.subject?.digest).toBe('sha256:subject')
    })

    it('populates the distilled cache after a registry fetch', async () => {
      const distilledCache = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn()
      }
      const cachedRegistry = new Registry(
        config,
        packageRepo,
        distilledCache as any
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await cachedRegistry.login('pkg')
      mockAxiosInstance.get.mockClear()

      const manifest = {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        subject: { digest: 'sha256:subj' }
      }
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify(manifest)
      })

      await cachedRegistry.getManifestByDigest('sha256:abc')

      expect(distilledCache.set).toHaveBeenCalledWith(
        'sha256:abc',
        expect.objectContaining({ subjectDigest: 'sha256:subj' })
      )
    })

    it('getRawManifestByDigest bypasses both in-memory and distilled caches', async () => {
      const distilledCache = {
        get: vi.fn().mockReturnValue({
          manifestEntries: [{ digest: 'sha256:cached', size: 0 }]
        }),
        set: vi.fn()
      }
      const cachedRegistry = new Registry(
        config,
        packageRepo,
        distilledCache as any
      )
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await cachedRegistry.login('pkg')
      mockAxiosInstance.get.mockClear()

      const fullManifest = {
        config: { mediaType: 'cfg', digest: 'sha256:cfg', size: 1 },
        layers: [{ mediaType: 'l', digest: 'sha256:l', size: 2 }]
      }
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify(fullManifest)
      })

      const result = await cachedRegistry.getRawManifestByDigest('sha256:abc')

      // Distilled cache was not consulted for the read.
      expect(distilledCache.get).not.toHaveBeenCalled()
      // Registry was hit.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
      // Full body fields are preserved.
      expect(result.config?.digest).toBe('sha256:cfg')
      expect(result.layers?.[0].digest).toBe('sha256:l')
    })
  })

  describe('getManifestByTag', () => {
    beforeEach(async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} })
      await registry.login('pkg')
      mockAxiosInstance.get.mockClear()
    })

    it('looks up the digest for a tag and fetches that manifest', async () => {
      packageRepo.getDigestByTag.mockReturnValue('sha256:fromtag')
      const manifest = { layers: [] }
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: JSON.stringify(manifest)
      })

      const result = await registry.getManifestByTag('latest')

      expect(packageRepo.getDigestByTag).toHaveBeenCalledWith('latest')
      expect(result).toEqual(manifest)
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

    it('skips entirely in dry-run mode', async () => {
      config.dryRun = true

      await registry.putManifest('latest', { mediaType: 'x' }, false)

      expect(mockAxiosInstance.put).not.toHaveBeenCalled()
      expect(mockAxiosInstance.get).not.toHaveBeenCalled()
    })

    it('returns early when the first PUT succeeds without a challenge', async () => {
      // Regression: an earlier flow threw "no token set to upload manifest"
      // on this path even though the upload succeeded.
      mockAxiosInstance.put.mockResolvedValueOnce({ status: 201 })

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).resolves.toBeUndefined()

      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1)
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

      await registry.putManifest('latest', { mediaType: 'x' }, false)

      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(2)
      // Second PUT should carry the push token in its Authorization header
      const secondPutCall = mockAxiosInstance.put.mock.calls[1]
      expect(secondPutCall[2].headers.Authorization).toBe('Bearer push-token')
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

    it('rethrows non-401 errors from the first PUT', async () => {
      mockAxiosInstance.put.mockRejectedValueOnce(
        fakeAxiosError({ status: 500 })
      )

      await expect(
        registry.putManifest('latest', { mediaType: 'x' }, false)
      ).rejects.toBeDefined()
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
      await registry.putManifest('tag2', { mediaType: 'x' }, false)

      // Only one token-exchange GET across both putManifest calls.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1)
      // Three PUTs total: the initial unauthed 401-triggering PUT, the
      // authed retry on tag1, and the fast-path PUT on tag2.
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(3)
      // tag2's PUT carried the cached bearer token from the start.
      const tag2Call = mockAxiosInstance.put.mock.calls[2]
      expect(tag2Call[2].headers.Authorization).toBe('Bearer push-token')
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

  describe('auth client retry configuration', () => {
    it('applies the same 429 retry condition to the token-exchange client', () => {
      // Constructor wires axios-retry twice: once for the manifest
      // client, once for the auth client. Both must accept 429.
      const calls = vi.mocked(axiosRetry).mock.calls
      // The two most recent calls correspond to the registry instance
      // built in the outer beforeEach.
      const lastTwo = calls.slice(-2)
      expect(lastTwo).toHaveLength(2)
      for (const call of lastTwo) {
        const retryCondition = call[1]?.retryCondition
        expect(retryCondition).toBeDefined()
        expect(retryCondition?.({ response: { status: 429 } } as never)).toBe(
          true
        )
      }
    })
  })
})
