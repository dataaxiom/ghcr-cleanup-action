import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
  type Mock
} from 'vitest'
import * as core from '@actions/core'
import { RequestError } from '@octokit/request-error'
import { Octokit } from '@octokit/rest'
import { OctokitClient } from '../octokit-client'
import { LogLevel } from '../config'

// Mock dependencies
vi.mock('@actions/core')

vi.mock('@octokit/rest', () => {
  const MockOctokit = vi.fn(function () {
    return { request: vi.fn() }
  }) as ReturnType<typeof vi.fn> & { plugin: ReturnType<typeof vi.fn> }
  MockOctokit.plugin = vi.fn(function () {
    return MockOctokit
  })

  return {
    Octokit: MockOctokit
  }
})

vi.mock('@octokit/plugin-throttling', () => ({
  throttling: vi.fn()
}))
vi.mock('@octokit/plugin-retry', () => ({
  retry: vi.fn()
}))
vi.mock('@octokit/plugin-request-log', () => ({
  requestLog: vi.fn()
}))

describe('OctokitClient', () => {
  let mockWarning: MockedFunction<typeof core.warning>

  beforeEach(() => {
    vi.clearAllMocks()
    mockWarning = core.warning as MockedFunction<typeof core.warning>
  })

  describe('constructor', () => {
    it('should create client with default settings', () => {
      const client = new OctokitClient('test-token')

      expect(client).toBeDefined()
      expect(client.getClient()).toBeDefined()
    })

    it('should create client with custom GitHub API URL', () => {
      const client = new OctokitClient(
        'test-token',
        'https://custom.github.com'
      )

      expect(client).toBeDefined()
    })

    it('should create client with custom log level', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.DEBUG)

      expect(client).toBeDefined()
    })

    it('should use default API URL when not provided', () => {
      const client = new OctokitClient('test-token', undefined)

      expect(client).toBeDefined()
    })
  })

  describe('throttling configuration', () => {
    // Pull the throttle config out of the most recent Octokit
    // constructor call so we can invoke the callbacks directly.
    const getThrottleConfig = (): {
      onRateLimit: (
        retryAfter: number,
        options: any,
        octokit: any,
        retryCount: number
      ) => boolean | undefined
      onSecondaryRateLimit: (
        retryAfter: number,
        options: any,
        octokit: any,
        retryCount: number
      ) => boolean | undefined
    } => {
      const mockOctokit = Octokit as unknown as Mock
      const lastCall = mockOctokit.mock.calls.at(-1)
      return lastCall?.[0]?.throttle
    }

    it('onRateLimit retries the first 3 attempts and then gives up', () => {
      new OctokitClient('test-token')
      const { onRateLimit } = getThrottleConfig()
      const opts = { method: 'GET', url: '/x' }

      expect(onRateLimit(1, opts, null, 0)).toBe(true)
      expect(onRateLimit(1, opts, null, 1)).toBe(true)
      expect(onRateLimit(1, opts, null, 2)).toBe(true)
      expect(onRateLimit(1, opts, null, 3)).toBe(false)
    })

    it('onSecondaryRateLimit retries instead of giving up on first hit', () => {
      // Regression: the previous handler logged and returned nothing,
      // which Octokit treats as "do not retry" — so a single secondary
      // rate-limit hit during a burst killed the request and surfaced
      // as a workflow failure.
      new OctokitClient('test-token')
      const { onSecondaryRateLimit } = getThrottleConfig()
      const opts = { method: 'POST', url: '/y' }

      expect(onSecondaryRateLimit(1, opts, null, 0)).toBe(true)
      expect(onSecondaryRateLimit(1, opts, null, 1)).toBe(true)
      expect(onSecondaryRateLimit(1, opts, null, 2)).toBe(true)
      expect(onSecondaryRateLimit(1, opts, null, 3)).toBe(false)
    })
  })

  describe('getClient', () => {
    it('should return the Octokit instance', () => {
      const client = new OctokitClient('test-token')
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
      // The actual type is the extended MyOctokitInstance
      expect(octokit).toHaveProperty('request')
    })
  })

  describe('log handlers', () => {
    // Pull the `log` object the constructor passed to Octokit so we can
    // call the four handlers directly. Each one gates on logLevel and
    // forwards to core.info with a level-tagged prefix.
    const getLogHandlers = (): {
      debug: (message: string) => void
      info: (message: string) => void
      warn: (message: string) => void
      error: (message: string) => void
    } => {
      const mockOctokit = Octokit as unknown as Mock
      const lastCall = mockOctokit.mock.calls.at(-1)
      return lastCall?.[0]?.log
    }

    it('forwards debug/info to core.info only at DEBUG level', () => {
      new OctokitClient('t', undefined, LogLevel.DEBUG)
      const log = getLogHandlers()
      const mockInfo = vi.mocked(core.info)

      log.debug('d1')
      log.info('i1')
      expect(mockInfo).toHaveBeenCalledWith('[Octokit DEBUG] d1')
      expect(mockInfo).toHaveBeenCalledWith('[Octokit DEBUG] i1')
    })

    it('silences debug/info below DEBUG level', () => {
      new OctokitClient('t', undefined, LogLevel.INFO)
      const log = getLogHandlers()
      const mockInfo = vi.mocked(core.info)
      mockInfo.mockClear()

      log.debug('hush')
      log.info('also hush')
      expect(mockInfo).not.toHaveBeenCalled()
    })

    it('forwards warn at WARN level and above', () => {
      new OctokitClient('t', undefined, LogLevel.WARN)
      const log = getLogHandlers()
      const mockInfo = vi.mocked(core.info)
      mockInfo.mockClear()

      log.warn('careful')
      expect(mockInfo).toHaveBeenCalledWith('[Octokit WARN] careful')
    })

    it('forwards error at ERROR level (the floor)', () => {
      new OctokitClient('t', undefined, LogLevel.ERROR)
      const log = getLogHandlers()
      const mockInfo = vi.mocked(core.info)
      mockInfo.mockClear()

      log.error('boom')
      expect(mockInfo).toHaveBeenCalledWith('[Octokit ERROR] boom')
      // warn is one above error and should also fire at this point —
      // logLevel >= LogLevel.WARN is false, so it should be silent.
      log.warn('quiet')
      expect(mockInfo).not.toHaveBeenCalledWith('[Octokit WARN] quiet')
    })
  })

  describe('getOwnerType', () => {
    let client: OctokitClient
    let mockRequest: Mock

    beforeEach(() => {
      client = new OctokitClient('test-token')
      mockRequest = vi.fn()
      ;(client as any).octokit = { request: mockRequest }
    })

    it('returns "User" for a user account', async () => {
      mockRequest.mockResolvedValue({ data: { type: 'User' } })

      await expect(client.getOwnerType('alice')).resolves.toBe('User')
      expect(mockRequest).toHaveBeenCalledWith('GET /users/alice')
    })

    it('returns "Organization" for an org account', async () => {
      mockRequest.mockResolvedValue({ data: { type: 'Organization' } })

      await expect(client.getOwnerType('acme')).resolves.toBe('Organization')
    })

    it('throws on unexpected type values', async () => {
      mockRequest.mockResolvedValue({ data: { type: 'Bot' } })

      await expect(client.getOwnerType('weirdbot')).rejects.toThrow(
        /unexpected owner type "Bot"/
      )
    })

    it('warns on 404 and rethrows', async () => {
      const error = new RequestError('Not Found', 404, {
        request: {
          method: 'GET',
          url: 'https://api.github.com/users/missing',
          headers: {}
        },
        response: {
          status: 404,
          url: 'https://api.github.com/users/missing',
          headers: {},
          data: {}
        }
      })
      mockRequest.mockRejectedValue(error)

      await expect(client.getOwnerType('missing')).rejects.toThrow(error)
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Owner "missing" not found')
      )
    })
  })

  describe('getAuthenticatedUserLogin', () => {
    let client: OctokitClient
    let mockRequest: Mock

    beforeEach(() => {
      client = new OctokitClient('test-token')
      mockRequest = vi.fn()
      ;(client as any).octokit = { request: mockRequest }
    })

    it('returns the login when /user succeeds', async () => {
      mockRequest.mockResolvedValue({ data: { login: 'alice' } })

      await expect(client.getAuthenticatedUserLogin()).resolves.toBe('alice')
      expect(mockRequest).toHaveBeenCalledWith('GET /user')
    })

    it('short-circuits without calling /user for ghs_ (App installation) tokens', async () => {
      // Workflow GITHUB_TOKEN uses the ghs_ prefix. Calling /user with
      // it 403s and produces a noisy log line for zero benefit, since
      // app installations can never "own" a user-scoped package.
      const appClient = new OctokitClient('ghs_fakeAppInstallationToken')
      const appMockRequest = vi.fn()
      ;(appClient as any).octokit = { request: appMockRequest }

      await expect(appClient.getAuthenticatedUserLogin()).resolves.toBeNull()
      expect(appMockRequest).not.toHaveBeenCalled()
    })

    it.each([
      ['classic PAT (ghp_)', 'ghp_xxx'],
      ['OAuth (gho_)', 'gho_xxx'],
      ['fine-grained PAT (github_pat_)', 'github_pat_xxx'],
      ['unknown prefix', 'some-token']
    ])(
      'does NOT short-circuit for %s (calls /user normally)',
      async (_label, token) => {
        const c = new OctokitClient(token)
        const m = vi.fn().mockResolvedValue({ data: { login: 'alice' } })
        ;(c as any).octokit = { request: m }

        await expect(c.getAuthenticatedUserLogin()).resolves.toBe('alice')
        expect(m).toHaveBeenCalledWith('GET /user')
      }
    )

    it('returns null when login is missing from the response', async () => {
      mockRequest.mockResolvedValue({ data: {} })

      await expect(client.getAuthenticatedUserLogin()).resolves.toBeNull()
    })

    it('returns null when login is empty string', async () => {
      mockRequest.mockResolvedValue({ data: { login: '' } })

      await expect(client.getAuthenticatedUserLogin()).resolves.toBeNull()
    })

    it.each([
      ['401 Unauthorized', 401],
      ['403 Forbidden', 403],
      ['404 Not Found', 404]
    ])(
      "returns null on %s (token can't identify a user)",
      async (_label, status) => {
        const error = new RequestError('err', status, {
          request: {
            method: 'GET',
            url: 'https://api.github.com/user',
            headers: {}
          },
          response: {
            status,
            url: 'https://api.github.com/user',
            headers: {},
            data: {}
          }
        })
        mockRequest.mockRejectedValue(error)

        await expect(client.getAuthenticatedUserLogin()).resolves.toBeNull()
      }
    )

    it('rethrows on unexpected errors (500, network, etc.)', async () => {
      const error = new RequestError('boom', 500, {
        request: {
          method: 'GET',
          url: 'https://api.github.com/user',
          headers: {}
        },
        response: {
          status: 500,
          url: 'https://api.github.com/user',
          headers: {},
          data: {}
        }
      })
      mockRequest.mockRejectedValue(error)

      await expect(client.getAuthenticatedUserLogin()).rejects.toThrow(error)
    })
  })

  describe('logging configuration', () => {
    it('should log debug messages when log level is DEBUG', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.DEBUG)
      const octokit = client.getClient()

      // Verify client is created with debug logging
      expect(octokit).toBeDefined()
    })

    it('should log info messages when log level is INFO or higher', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.INFO)
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
    })

    it('should log warn messages when log level is WARN or higher', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.WARN)
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
    })

    it('should log error messages when log level is ERROR or higher', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.ERROR)
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
    })

    // Errors must surface regardless of verbosity — historically the gate
    // was `>= LogLevel.INFO` which silently suppressed Octokit errors for
    // anyone running with log-level: error or warn. Lock that down.
    it.each([
      ['ERROR', LogLevel.ERROR],
      ['WARN', LogLevel.WARN],
      ['INFO', LogLevel.INFO],
      ['DEBUG', LogLevel.DEBUG]
    ])(
      'invokes core.info for Octokit errors at log level %s',
      (_label, level) => {
        const infoSpy = core.info as MockedFunction<typeof core.info>
        infoSpy.mockClear()

        new OctokitClient('test-token', undefined, level)

        const lastCallArgs = (Octokit as unknown as Mock).mock.calls.at(-1)
        const log = (
          lastCallArgs?.[0] as {
            log?: { error?: (m: string) => void }
          }
        )?.log
        if (typeof log?.error !== 'function') {
          throw new Error('expected Octokit options to carry a log.error fn')
        }
        log.error('boom')

        expect(infoSpy).toHaveBeenCalledWith('[Octokit ERROR] boom')
      }
    )
  })
})
