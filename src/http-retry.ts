import * as core from '@actions/core'
import axios, {
  AxiosError,
  AxiosInstance,
  InternalAxiosRequestConfig
} from 'axios'
import { sleep } from './utils.js'

/**
 * Retry for the registry (ghcr.io) HTTP clients.
 *
 * Replaces the unmaintained axios-retry. The rules below combine what
 * axios-retry and retry-axios each get right and close the gaps they
 * share:
 *
 * - A request is retried only when repeating it is safe: on a 429 (the
 *   server refused it), or for an idempotent method on a 408, a 5xx other
 *   than 501, a timeout, or a transient network error.
 * - Permanent failures are never retried: cancellation, other 4xx (401
 *   drives the registry login flow), 501, and network errors that cannot
 *   heal by waiting (DNS name not found, unreachable network, certificate
 *   problems).
 * - Retry-After (seconds or an HTTP date) is honoured, and the delay is
 *   never shorter than it; a Retry-After beyond `maxRetryAfterMs` gives up
 *   instead of stalling the run. An unparsable header falls back to
 *   backoff.
 * - The attempt count lives on the request config as a plain number, which
 *   survives axios's config merge on each retry (a symbol key would not,
 *   and the request would retry forever).
 * - The already-serialized body is re-sent as-is (transformRequest is
 *   reset), so a retried PUT sends the same bytes.
 */

export interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number
  /** Backoff before retry n is baseDelayMs * 2^(n-1), plus 0-20% jitter. */
  baseDelayMs: number
  /** Upper bound on the backoff delay (not on Retry-After). */
  maxDelayMs: number
  /** Give up rather than wait longer than this for a Retry-After. */
  maxRetryAfterMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 5 * 60_000
}

/** Per-attempt timeout for registry requests, so a stalled connection becomes a retryable timeout instead of hanging the run. */
export const REGISTRY_REQUEST_TIMEOUT_MS = 60_000

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => number
}

const DEFAULT_DEPS: RetryDeps = {
  sleep,
  random: Math.random,
  now: Date.now
}

const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options', 'put', 'delete'])

// Network error codes that waiting cannot fix (is-retry-allowed's list, as
// used by axios-retry): name resolution / routing failures and TLS
// certificate errors.
const PERMANENT_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ENETUNREACH',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT'])

// Request-config key holding the number of retries made so far.
const ATTEMPT_KEY = 'ghcrCleanupRetryCount'

type RetryableConfig = InternalAxiosRequestConfig & {
  [ATTEMPT_KEY]?: number
}

/**
 * Why `error` is worth retrying (a short reason for the log), or
 * undefined if it is not.
 */
export function retryReason(error: AxiosError): string | undefined {
  if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
    return undefined
  }
  const method = error.config?.method?.toLowerCase()
  const idempotent = method !== undefined && IDEMPOTENT_METHODS.has(method)
  const status = error.response?.status

  if (status !== undefined) {
    if (status === 429) return 'HTTP 429'
    if (!idempotent) return undefined
    if (status === 408) return 'HTTP 408'
    if (status >= 500 && status <= 599 && status !== 501) {
      return `HTTP ${status}`
    }
    return undefined
  }

  // No response: the request may or may not have reached the server, so
  // only an idempotent request can safely be sent again.
  if (!idempotent) return undefined
  if (error.code && TIMEOUT_CODES.has(error.code)) return 'timeout'
  if (error.code && PERMANENT_NETWORK_CODES.has(error.code)) return undefined
  return error.code ? `network error ${error.code}` : 'network error'
}

/**
 * Milliseconds requested by a Retry-After header (delta-seconds or an
 * HTTP date), 0 if already elapsed, or undefined if absent/unparsable.
 */
export function parseRetryAfterMs(
  header: unknown,
  now: number
): number | undefined {
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const value = header.trim()
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000)
  }
  // An HTTP date always has a day/month name. Requiring a letter stops
  // Date.parse accepting junk like "-5" (read as the year -5).
  if (!/[a-z]/i.test(value)) return undefined
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

/**
 * Delay before retry number `retry` (1-based), or undefined if the server
 * asked us to wait longer than the policy allows.
 */
export function retryDelayMs(
  retry: number,
  error: AxiosError,
  policy: RetryPolicy,
  deps: Pick<RetryDeps, 'random' | 'now'>
): number | undefined {
  const retryAfter = parseRetryAfterMs(
    error.response?.headers?.['retry-after'],
    deps.now()
  )
  if (retryAfter !== undefined && retryAfter > policy.maxRetryAfterMs) {
    return undefined
  }
  const backoff = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (retry - 1)
  )
  const jittered = backoff + backoff * 0.2 * deps.random()
  return Math.max(retryAfter ?? 0, jittered)
}

/**
 * Install the retry policy on an axios instance (response interceptor).
 */
export function installRetry(
  instance: AxiosInstance,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: RetryDeps = DEFAULT_DEPS
): void {
  instance.interceptors.response.use(undefined, async (error: unknown) => {
    if (!axios.isAxiosError(error) || !error.config) {
      throw error
    }
    const config = error.config as RetryableConfig
    const done = config[ATTEMPT_KEY] ?? 0
    const reason = retryReason(error)
    if (reason === undefined || done >= policy.retries) {
      throw error
    }

    const retry = done + 1
    const delay = retryDelayMs(retry, error, policy, deps)
    const what = `${config.method?.toUpperCase() ?? 'request'} ${config.url ?? ''}`
    if (delay === undefined) {
      core.info(
        `Registry ${what} failed (${reason}); not retrying: Retry-After exceeds ${policy.maxRetryAfterMs / 1000}s`
      )
      throw error
    }
    core.info(
      `Registry ${what} failed (${reason}); retrying in ${(delay / 1000).toFixed(1)}s (retry ${retry}/${policy.retries})`
    )

    config[ATTEMPT_KEY] = retry
    // The body was serialized on the first attempt; send it as-is.
    config.transformRequest = [(data: unknown) => data]
    await deps.sleep(delay)
    return instance.request(config)
  })
}
