import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type InternalAxiosRequestConfig
} from 'axios'
import {
  DEFAULT_RETRY_POLICY,
  installRetry,
  parseRetryAfterMs,
  retryDelayMs,
  retryReason,
  type RetryDeps
} from '../http-retry'

vi.mock('@actions/core')

// One scripted outcome per request the transport receives.
type Outcome =
  { status: number; headers?: Record<string, string> } | { code: string }

// A real axios instance whose transport plays back `script`. Every call is
// recorded, and the transport refuses to run more than `maxCalls` times, so
// a retry loop that never stops fails the test instead of hanging it.
interface Harness {
  instance: ReturnType<typeof axios.create>
  calls: InternalAxiosRequestConfig[]
  sleeps: number[]
}

function harness(script: Outcome[], maxCalls = 20): Harness {
  const calls: InternalAxiosRequestConfig[] = []
  const adapter: AxiosAdapter = async config => {
    calls.push(config)
    if (calls.length > maxCalls) throw new Error('runaway retry loop')
    const outcome = script[Math.min(calls.length - 1, script.length - 1)]
    if ('code' in outcome) {
      throw new AxiosError(`net ${outcome.code}`, outcome.code, config)
    }
    const response = {
      data: {},
      status: outcome.status,
      statusText: String(outcome.status),
      headers: new AxiosHeaders(outcome.headers ?? {}),
      config
    }
    if (outcome.status >= 200 && outcome.status < 300) return response
    throw new AxiosError(
      `HTTP ${outcome.status}`,
      AxiosError.ERR_BAD_RESPONSE,
      config,
      undefined,
      response
    )
  }
  const instance = axios.create({ adapter })
  const sleeps: number[] = []
  const deps: RetryDeps = {
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms)
    }),
    random: () => 0,
    now: () => Date.parse('2026-11-15T00:00:00Z')
  }
  installRetry(instance, DEFAULT_RETRY_POLICY, deps)
  return { instance, calls, sleeps }
}

const rejectionOf = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('http-retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('installRetry (real axios, scripted transport)', () => {
    it('recovers from transient 5xx on GET, with backoff 1s then 2s', async () => {
      const { instance, calls, sleeps } = harness([
        { status: 503 },
        { status: 502 },
        { status: 200 }
      ])
      const res = await instance.get('/v2/x/manifests/sha256:a')
      expect(res.status).toBe(200)
      expect(calls).toHaveLength(3)
      expect(sleeps).toEqual([1000, 2000])
    })

    it('stops after 3 retries and rethrows the last error (counter survives axios config merging)', async () => {
      const { instance, calls, sleeps } = harness([{ status: 503 }])
      const err = await rejectionOf(instance.get('/x'))
      expect((err as AxiosError).response?.status).toBe(503)
      expect(calls).toHaveLength(4) // first try + 3 retries, not a loop
      expect(sleeps).toEqual([1000, 2000, 4000])
    })

    it('re-sends exactly the same body bytes on a retried PUT', async () => {
      const { instance, calls } = harness([{ status: 500 }, { status: 201 }])
      const body = Buffer.from('{"mediaType":"x"}')
      await instance.put('/v2/x/manifests/tag', body, {
        headers: { 'Content-Type': 'application/vnd.oci.image.index.v1+json' }
      })
      expect(calls).toHaveLength(2)
      expect(Buffer.from(calls[1].data as Buffer)).toEqual(body)
      expect(calls[1].data).toEqual(calls[0].data)
    })

    it('does not run the body through transformRequest again on a retry', async () => {
      // A client-level transform runs once on the first attempt; the retry
      // must send the already-transformed body, not transform it twice.
      let attempt = 0
      const sent: unknown[] = []
      const instance = axios.create({
        transformRequest: [(data: unknown) => `signed(${String(data)})`],
        adapter: async config => {
          sent.push(config.data)
          attempt++
          if (attempt === 1) {
            throw new AxiosError(
              'HTTP 503',
              AxiosError.ERR_BAD_RESPONSE,
              config,
              undefined,
              {
                data: {},
                status: 503,
                statusText: '503',
                headers: new AxiosHeaders(),
                config
              }
            )
          }
          return {
            data: {},
            status: 200,
            statusText: 'OK',
            headers: new AxiosHeaders(),
            config
          }
        }
      })
      installRetry(instance, DEFAULT_RETRY_POLICY, {
        sleep: async () => {},
        random: () => 0,
        now: () => 0
      })
      await instance.put('/x', 'body')
      expect(sent).toEqual(['signed(body)', 'signed(body)'])
    })

    it('retries 429 even for a non-idempotent method', async () => {
      const { instance, calls } = harness([{ status: 429 }, { status: 200 }])
      await instance.post('/token', 'x')
      expect(calls).toHaveLength(2)
    })

    it('does not retry a 5xx or a network error for a non-idempotent method', async () => {
      const a = harness([{ status: 503 }])
      await rejectionOf(a.instance.post('/x', 'body'))
      expect(a.calls).toHaveLength(1)
      const b = harness([{ code: 'ECONNRESET' }])
      await rejectionOf(b.instance.post('/x', 'body'))
      expect(b.calls).toHaveLength(1)
    })

    it.each([400, 401, 403, 404, 501])(
      'does not retry HTTP %i (401 drives the registry login flow)',
      async status => {
        const { instance, calls } = harness([{ status }])
        const err = await rejectionOf(instance.get('/x'))
        expect((err as AxiosError).response?.status).toBe(status)
        expect(calls).toHaveLength(1)
      }
    )

    it.each([
      'ECONNRESET',
      'EPIPE',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ERR_NETWORK',
      'ECONNABORTED',
      'ETIMEDOUT'
    ])(
      'retries %s (transient network error or timeout) for an idempotent request',
      async code => {
        const { instance, calls } = harness([{ code }, { status: 200 }])
        await instance.get('/x')
        expect(calls).toHaveLength(2)
      }
    )

    it.each([
      'ENOTFOUND',
      'ENETUNREACH',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    ])('does not retry the permanent network error %s', async code => {
      const { instance, calls } = harness([{ code }, { status: 200 }])
      await rejectionOf(instance.get('/x'))
      expect(calls).toHaveLength(1)
    })

    it('does not retry a cancelled request', async () => {
      const { instance, calls } = harness([{ code: 'ERR_CANCELED' }])
      await rejectionOf(instance.get('/x'))
      expect(calls).toHaveLength(1)
    })

    it('waits at least as long as Retry-After (seconds)', async () => {
      const { instance, sleeps } = harness([
        { status: 429, headers: { 'retry-after': '7' } },
        { status: 200 }
      ])
      await instance.get('/x')
      expect(sleeps).toEqual([7000])
    })

    it('waits until a Retry-After HTTP date', async () => {
      const { instance, sleeps } = harness([
        {
          status: 503,
          headers: { 'retry-after': 'Sun, 15 Nov 2026 00:00:12 GMT' }
        },
        { status: 200 }
      ])
      await instance.get('/x')
      expect(sleeps).toEqual([12000])
    })

    it('uses the backoff when Retry-After is shorter than it', async () => {
      const { instance, sleeps } = harness([
        { status: 429, headers: { 'retry-after': '0' } },
        { status: 200 }
      ])
      await instance.get('/x')
      expect(sleeps).toEqual([1000])
    })

    it('gives up instead of stalling when Retry-After exceeds 5 minutes', async () => {
      const { instance, calls, sleeps } = harness([
        { status: 429, headers: { 'retry-after': '3600' } }
      ])
      const err = await rejectionOf(instance.get('/x'))
      expect((err as AxiosError).response?.status).toBe(429)
      expect(calls).toHaveLength(1)
      expect(sleeps).toEqual([])
    })

    it('falls back to backoff for an unparsable Retry-After', async () => {
      const { instance, sleeps } = harness([
        { status: 503, headers: { 'retry-after': 'soon-ish' } },
        { status: 200 }
      ])
      await instance.get('/x')
      expect(sleeps).toEqual([1000])
    })

    it('rethrows non-axios errors untouched', async () => {
      const instance = axios.create({
        adapter: async () => {
          throw new TypeError('boom')
        }
      })
      installRetry(instance)
      const err = await rejectionOf(instance.get('/x'))
      expect(err).toBeInstanceOf(TypeError)
    })
  })

  describe('retryDelayMs', () => {
    const err = (headers: Record<string, string> = {}): AxiosError =>
      ({
        response: { headers }
      }) as unknown as AxiosError
    const deps = (
      random: number
    ): { random: () => number; now: () => number } => ({
      random: () => random,
      now: () => 0
    })

    it('doubles from 1s, adds 0-20% jitter, and caps the backoff at 30s', () => {
      expect(retryDelayMs(1, err(), DEFAULT_RETRY_POLICY, deps(0))).toBe(1000)
      expect(retryDelayMs(2, err(), DEFAULT_RETRY_POLICY, deps(0))).toBe(2000)
      expect(retryDelayMs(3, err(), DEFAULT_RETRY_POLICY, deps(1))).toBe(4800)
      expect(retryDelayMs(10, err(), DEFAULT_RETRY_POLICY, deps(0))).toBe(30000)
    })

    it('accepts a Retry-After exactly at the limit, rejects one just past it', () => {
      expect(
        retryDelayMs(
          1,
          err({ 'retry-after': '300' }),
          DEFAULT_RETRY_POLICY,
          deps(0)
        )
      ).toBe(300000)
      expect(
        retryDelayMs(
          1,
          err({ 'retry-after': '301' }),
          DEFAULT_RETRY_POLICY,
          deps(0)
        )
      ).toBeUndefined()
    })
  })

  describe('parseRetryAfterMs', () => {
    const now = Date.parse('2026-11-15T00:00:00Z')
    it.each([
      ['5', 5000],
      [' 2.5 ', 2500],
      ['0', 0],
      ['Sun, 15 Nov 2026 00:00:30 GMT', 30000],
      ['Sat, 14 Nov 2026 23:00:00 GMT', 0] // already past
    ])('parses %j as %i ms', (header, ms) => {
      expect(parseRetryAfterMs(header, now)).toBe(ms)
    })

    it.each([undefined, '', '  ', '-5', 'abc', 42])(
      'treats %j as absent',
      header => {
        expect(parseRetryAfterMs(header, now)).toBeUndefined()
      }
    )
  })

  describe('retryReason', () => {
    const e = (
      method: string | undefined,
      status?: number,
      code?: string
    ): AxiosError =>
      ({
        config: { method },
        response: status === undefined ? undefined : { status },
        code
      }) as unknown as AxiosError

    it('names the reason for retryable errors', () => {
      expect(retryReason(e('get', 503))).toBe('HTTP 503')
      expect(retryReason(e('PUT', 500))).toBe('HTTP 500')
      expect(retryReason(e('post', 429))).toBe('HTTP 429')
      expect(retryReason(e('delete', 408))).toBe('HTTP 408')
      expect(retryReason(e('head', undefined, 'ECONNABORTED'))).toBe('timeout')
      expect(retryReason(e('get', undefined, 'ECONNRESET'))).toBe(
        'network error ECONNRESET'
      )
      expect(retryReason(e('get'))).toBe('network error')
    })

    it('returns undefined when the method is unknown and there is no 429', () => {
      expect(retryReason(e(undefined, 503))).toBeUndefined()
      expect(retryReason(e(undefined, undefined, 'ECONNRESET'))).toBeUndefined()
      expect(retryReason(e(undefined, 429))).toBe('HTTP 429')
    })
  })
})
