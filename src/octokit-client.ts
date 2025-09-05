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

  constructor(
    token: string,
    githubApiUrl?: string,
    logLevel: LogLevel = LogLevel.INFO
  ) {
    const baseUrl = githubApiUrl || 'https://api.github.com'

    this.octokit = new MyOctokit({
      auth: token,
      baseUrl,
      throttle: {
        // @ts-expect-error Plugin type definitions don't match the actual runtime behavior
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
        // @ts-expect-error Plugin type definitions don't match the actual runtime behavior
        onSecondaryRateLimit: (
          retryAfter: number,
          options: EndpointDefaults,
          octokit: MyOctokitInstance
        ) => {
          // does not retry, only logs a warning
          core.info(
            `Octokit - secondaryRateLimit detected for request ${options.method} ${options.url}`
          )
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
          if (logLevel >= LogLevel.INFO) {
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
   * Get repository information
   */
  async getRepository(
    owner: string,
    repository: string
  ): Promise<{
    isPrivate: boolean
    ownerType: string
  }> {
    try {
      const result = await this.octokit.request(
        `GET /repos/${owner}/${repository}`
      )
      return {
        isPrivate: result.data.private,
        ownerType: result.data.owner.type
      }
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 404) {
          core.warning(
            `The repository is not found, check the owner value "${owner}" or the repository value "${repository}" are correct`
          )
        }
      }
      // rethrow the error
      throw error
    }
  }
}
