import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'
import { retry } from '@octokit/plugin-retry'
import { requestLog } from '@octokit/plugin-request-log'
import { RequestError } from '@octokit/request-error'
import type { EndpointDefaults } from '@octokit/types'
import { LogLevel } from './config.js'

const MyOctokit = Octokit.plugin(requestLog, throttling, retry)
type MyOctokitInstance = InstanceType<typeof MyOctokit>

/**
 * Manages the Octokit client for GitHub API interactions.
 * Handles authentication, rate limiting, retries, and logging.
 */
export class OctokitClient {
  private octokit: MyOctokitInstance

  // GitHub App installation tokens use the `ghs_` prefix (workflow
  // GITHUB_TOKEN is one). These can't successfully call `GET /user` —
  // the endpoint 403s and Octokit's request logger emits a noisy
  // [Octokit ERROR] line. Skip the call entirely for these tokens.
  private tokenIsAppInstallation: boolean

  constructor(
    token: string,
    githubApiUrl?: string,
    logLevel: LogLevel = LogLevel.INFO
  ) {
    this.tokenIsAppInstallation = token.startsWith('ghs_')
    const baseUrl = githubApiUrl || 'https://api.github.com'

    this.octokit = new MyOctokit({
      auth: token,
      baseUrl,
      throttle: {
        onRateLimit: (
          retryAfter: number,
          options: EndpointDefaults,
          octokit: MyOctokitInstance,
          retryCount: number
        ) => {
          core.info(
            `Octokit - request quota exhausted for request ${options.method} ${options.url}`
          )

          if (retryCount < 3) {
            // try up to 3 times
            core.info(`Octokit - retrying after ${retryAfter} seconds!`)
            return true
          }
          return false
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: EndpointDefaults,
          octokit: MyOctokitInstance,
          retryCount: number
        ) => {
          core.info(
            `Octokit - secondaryRateLimit detected for request ${options.method} ${options.url}`
          )
          // Secondary rate limits are GitHub's abuse-detection throttle.
          // The previous implementation logged and gave up; that meant a
          // single secondary hit during a burst (parallel pagination,
          // parallel manifest fetches, parallel untag writes) killed the
          // whole request and surfaced as an action failure. Retry up to
          // 3 times, mirroring onRateLimit.
          if (retryCount < 3) {
            core.info(
              `Octokit - retrying after ${retryAfter} seconds (secondary rate limit)`
            )
            return true
          }
          return false
        }
      },
      log: {
        debug: (message: string) => {
          if (logLevel >= LogLevel.DEBUG) {
            core.info(`[Octokit DEBUG] ${message}`)
          }
        },
        info: (message: string) => {
          if (logLevel >= LogLevel.DEBUG) {
            core.info(`[Octokit DEBUG] ${message}`)
          }
        },
        warn: (message: string) => {
          if (logLevel >= LogLevel.WARN) {
            core.info(`[Octokit WARN] ${message}`)
          }
        },
        error: (message: string) => {
          if (logLevel >= LogLevel.ERROR) {
            core.info(`[Octokit ERROR] ${message}`)
          }
        }
      }
    })
  }

  /**
   * Get the underlying Octokit instance for direct API calls
   */
  getClient(): MyOctokitInstance {
    return this.octokit
  }

  /**
   * Look up an owner (user or organization) and return its account type.
   * Uses `GET /users/{login}`, which returns both Users and Organizations
   * — the response carries a `.type` field distinguishing them. This is
   * the canonical way to ask "is this login a user or an org" without
   * touching any repository.
   */
  async getOwnerType(owner: string): Promise<'User' | 'Organization'> {
    try {
      const result = await this.octokit.request(`GET /users/${owner}`)
      const type = result.data.type
      if (type !== 'User' && type !== 'Organization') {
        throw new Error(
          `unexpected owner type "${type}" for "${owner}" (expected User or Organization)`
        )
      }
      return type
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        core.warning(
          `Owner "${owner}" not found — check the owner input is correct.`
        )
      }
      throw error
    }
  }

  /**
   * Return the authenticated user's login via `GET /user`. Used to compare
   * against the package owner for endpoint selection (token owns package
   * → use the authenticated-user endpoint; otherwise → use the user
   * endpoint).
   *
   * Returns `null` when the token doesn't represent a user we can compare
   * (e.g. a GitHub App installation token whose login is a bot, or a
   * scope-restricted PAT). Callers should treat `null` as "not the
   * package owner" and pick the non-authenticated endpoint.
   */
  async getAuthenticatedUserLogin(): Promise<string | null> {
    // Short-circuit for GitHub App installation tokens (workflow
    // GITHUB_TOKEN is one). They can't usefully identify a user via
    // `GET /user` — the call would 403 and Octokit would log a noisy
    // error. The app's "user" is a bot, which can never own a
    // user-scoped package anyway, so treating it as null is correct.
    if (this.tokenIsAppInstallation) {
      return null
    }
    try {
      const result = await this.octokit.request('GET /user')
      const login = result.data?.login
      return typeof login === 'string' && login.length > 0 ? login : null
    } catch (error) {
      if (error instanceof RequestError) {
        // 401/403/404 all mean "we can't identify this token as a user" —
        // safe to treat as not-the-owner.
        if (
          error.status === 401 ||
          error.status === 403 ||
          error.status === 404
        ) {
          return null
        }
      }
      throw error
    }
  }
}
