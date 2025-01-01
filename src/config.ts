import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'
import { retry } from '@octokit/plugin-retry'
import { requestLog } from '@octokit/plugin-request-log'
import { RequestError } from '@octokit/request-error'
import type { EndpointDefaults } from '@octokit/types'
import { MapPrinter } from './utils.js'
import humanInterval from 'human-interval'

// @ts-expect-error: esm errror
const MyOctokit = Octokit.plugin(requestLog, throttling, retry)

export enum LogLevel {
  ERROR = 1,
  WARN,
  INFO,
  DEBUG
}

export class Config {
  isPrivateRepo = false
  repoType = 'Organization'
  owner = ''
  repository = ''
  package = ''
  expandPackages?: boolean
  defaultPackageUsed = false
  deleteTags?: string
  excludeTags?: string
  olderThanReadable?: string
  olderThan?: number
  deleteUntagged?: boolean
  deleteGhostImages?: boolean
  deletePartialImages?: boolean
  deleteOrphanedImages?: boolean
  keepNuntagged?: number
  keepNtagged?: number
  dryRun?: boolean
  validate?: boolean
  logLevel: LogLevel
  useRegex?: boolean
  token: string
  registryUrl?: string
  githubApiUrl?: string
  octokit: any

  constructor(token: string) {
    this.token = token
    this.logLevel = LogLevel.INFO
  }

  async init(): Promise<void> {
    let githubUrl = 'https://api.github.com'
    if (this.githubApiUrl) {
      githubUrl = this.githubApiUrl
    }
    this.octokit = new MyOctokit({
      auth: this.token,
      baseUrl: githubUrl,
      throttle: {
        onRateLimit: (
          retryAfter: number,
          options: EndpointDefaults,
          octokit: Octokit,
          retryCount: number
        ) => {
          core.info(
            `Octokit - request quota exhausted for request ${options.method} ${options.url}`
          )

          if (retryCount < 3) {
            // try upto 3 times
            core.info(`Octokit - retrying after ${retryAfter} seconds!`)
            return true
          }
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: EndpointDefaults,
          octokit: Octokit
        ) => {
          // does not retry, only logs a warning
          core.info(
            `Octokit - secondaryRateLimit detected for request ${options.method} ${options.url}`
          )
        }
      },
      log: {
        debug: (message: string) => {
          if (this.logLevel >= LogLevel.DEBUG) {
            core.info(`[Octokit DEBUG] ${message}`)
          }
        },
        info: (message: string) => {
          if (this.logLevel >= LogLevel.DEBUG) {
            core.info(`[Octokit DEBUG] ${message}`)
          }
        },
        warn: (message: string) => {
          if (this.logLevel >= LogLevel.WARN) {
            core.info(`[Octokit WARN] ${message}`)
          }
        },
        error: (message: string) => {
          if (this.logLevel >= LogLevel.INFO) {
            core.info(`[Octokit ERROR] ${message}`)
          }
        }
      }
    })

    // lookup repo info
    try {
      const result = await this.octokit.request(
        `GET /repos/${this.owner}/${this.repository}`
      )
      this.isPrivateRepo = result.data.private
      this.repoType = result.data.owner.type
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status) {
          if (error.status === 404) {
            core.warning(
              `The repository is not found, check the owner value "${this.owner}" or the repository value "${this.repository}" are correct`
            )
          }
        }
      }
      // rethrow the error
      throw error
    }
  }
}

export function buildConfig(): Config {
  const token: string = core.getInput('token', { required: true })
  const config = new Config(token)
  config.owner = core.getInput('owner')
  config.repository = core.getInput('repository')

  if (core.getInput('package') && core.getInput('packages')) {
    throw Error(
      'package and packages cant be used at the same time, use either one'
    )
  }
  config.package = core.getInput('package')
  if (!config.package) {
    config.package = core.getInput('packages')
  }

  // auto populate
  const GITHUB_REPOSITORY = process.env['GITHUB_REPOSITORY']
  if (GITHUB_REPOSITORY) {
    const parts = GITHUB_REPOSITORY.split('/')
    if (parts.length === 2) {
      if (!config.owner) {
        config.owner = parts[0]
      }
      if (!config.package) {
        config.package = parts[1]
        config.defaultPackageUsed = true
      } else {
        config.defaultPackageUsed = false
      }
      if (!config.repository) {
        config.repository = parts[1]
      }
    } else {
      throw Error(`Error parsing GITHUB_REPOSITORY: ${GITHUB_REPOSITORY}`)
    }
  } else {
    throw Error('GITHUB_REPOSITORY is not set')
  }

  if (core.getInput('expand-packages')) {
    config.expandPackages = core.getBooleanInput('expand-packages')
  }

  if (core.getInput('tags') && core.getInput('delete-tags')) {
    throw Error(
      'tags and delete-tags cant be used at the same time, use either one'
    )
  }
  if (core.getInput('tags')) {
    config.deleteTags = core.getInput('tags')
  } else if (core.getInput('delete-tags')) {
    config.deleteTags = core.getInput('delete-tags')
  }

  config.excludeTags = core.getInput('exclude-tags')

  if (core.getInput('older-than')) {
    config.olderThan = humanInterval(core.getInput('older-than'))
    // save the text version of it
    config.olderThanReadable = core.getInput('older-than')

    if (config.olderThan != null && isNaN(config.olderThan)) {
      // check if it has an interval type
      const regexp = /(second|minute|hour|day|week|month|year)s?/
      const match = config.olderThanReadable.match(regexp)
      if (match) {
        throw Error(
          `older-than value "${config.olderThanReadable}" is not a valid interval`
        )
      } else {
        throw Error(
          `older-than value "${config.olderThanReadable}" is not a valid interval, it's missing an interval such as second, minute, hour, day, week or year`
        )
      }
    }
  }

  if (core.getInput('keep-n-tagged')) {
    const value: number = parseInt(core.getInput('keep-n-tagged'))
    if (isNaN(value)) {
      throw new Error('keep-n-tagged is not number')
    } else if (value < 0) {
      throw new Error('keep-n-tagged is negative')
    } else {
      config.keepNtagged = value
    }
  }

  if (core.getInput('keep-n-untagged')) {
    const value: number = parseInt(core.getInput('keep-n-untagged'))
    if (isNaN(value)) {
      throw new Error('keep-n-untagged is not number')
    } else if (value < 0) {
      throw new Error('keep-n-untagged is negative')
    } else {
      config.keepNuntagged = value
    }
  }

  if (core.getInput('delete-untagged')) {
    config.deleteUntagged = core.getBooleanInput('delete-untagged')
  } else {
    // default is deleteUntagged if no options are set
    if (
      !core.getInput('tags') &&
      !core.getInput('delete-tags') &&
      !core.getInput('delete-ghost-images') &&
      !core.getInput('delete-partial-images') &&
      !core.getInput('delete-orphaned-images') &&
      !core.getInput('keep-n-untagged') &&
      !core.getInput('keep-n-tagged')
    ) {
      config.deleteUntagged = true
    }
  }

  if (config.keepNuntagged && core.getInput('delete-untagged')) {
    throw new Error(
      'delete-untagged and keep-n-untagged can not be set at the same time'
    )
  }

  if (core.getInput('delete-ghost-images')) {
    config.deleteGhostImages = core.getBooleanInput('delete-ghost-images')
  }
  if (core.getInput('delete-partial-images')) {
    config.deletePartialImages = core.getBooleanInput('delete-partial-images')
  }
  if (core.getInput('delete-orphaned-images')) {
    config.deleteOrphanedImages = core.getBooleanInput('delete-orphaned-images')
  }

  if (core.getInput('dry-run')) {
    config.dryRun = core.getBooleanInput('dry-run')
    if (config.dryRun) {
      core.info('***** In dry run mode - No packages will be deleted *****')
    }
  }

  if (core.getInput('validate')) {
    config.validate = core.getBooleanInput('validate')
  }

  if (core.getInput('log-level')) {
    const level = core.getInput('log-level').toLowerCase()
    if (level === 'error') {
      config.logLevel = LogLevel.ERROR
    } else if (level === 'warn') {
      config.logLevel = LogLevel.WARN
    } else if (level === 'info') {
      config.logLevel = LogLevel.INFO
    } else if (level === 'debug') {
      config.logLevel = LogLevel.DEBUG
    }
  }

  if (core.getInput('use-regex')) {
    config.useRegex = core.getBooleanInput('use-regex')
  }

  if (core.getInput('registry-url')) {
    config.registryUrl = core.getInput('registry-url')
    if (!config.registryUrl.endsWith('/')) {
      config.registryUrl += '/'
    }
  }
  if (core.getInput('github-api-url')) {
    config.githubApiUrl = core.getInput('github-api-url')
    if (config.githubApiUrl.endsWith('/')) {
      config.githubApiUrl = config.githubApiUrl.slice(0, -1)
    }
  }

  if (!config.owner) {
    throw new Error('owner is not set')
  }
  if (!config.package) {
    throw new Error('package is not set')
  }
  if (!config.repository) {
    throw new Error('repository is not set')
  }

  const optionsMap = new MapPrinter()
  optionsMap.add('private repository', `${config.isPrivateRepo}`)
  optionsMap.add('project owner', `${config.owner}`)
  optionsMap.add('repository', `${config.repository}`)
  optionsMap.add('package', `${config.package}`)
  if (config.expandPackages !== undefined) {
    optionsMap.add('expand-packages', `${config.expandPackages}`)
  }
  if (config.deleteTags) {
    optionsMap.add('delete-tags', config.deleteTags)
  }
  if (config.excludeTags) {
    optionsMap.add('exclude-tags', config.excludeTags)
  }
  if (config.olderThan) {
    try {
      const cutOff = new Date(Date.now() - config.olderThan)
      optionsMap.add('older-than', cutOff.toUTCString())
    } catch (error) {
      core.info('error processing older-than value')
      throw error
    }
  }
  if (config.deleteUntagged !== undefined) {
    optionsMap.add('delete-untagged', `${config.deleteUntagged}`)
  }
  if (config.deleteGhostImages !== undefined) {
    optionsMap.add('delete-ghost-images', `${config.deleteGhostImages}`)
  }
  if (config.deletePartialImages !== undefined) {
    optionsMap.add('delete-partial-images', `${config.deletePartialImages}`)
  }
  if (config.deleteOrphanedImages !== undefined) {
    optionsMap.add('delete-orphaned-images', `${config.deleteOrphanedImages}`)
  }
  if (config.keepNtagged !== undefined) {
    optionsMap.add('keep-n-tagged', `${config.keepNtagged}`)
  }
  if (config.keepNuntagged !== undefined) {
    optionsMap.add('keep-n-untagged', `${config.keepNuntagged}`)
  }
  if (config.dryRun !== undefined) {
    optionsMap.add('dry-run', `${config.dryRun}`)
  }
  if (config.validate !== undefined) {
    optionsMap.add('validate', `${config.validate}`)
  }
  optionsMap.add('log-level', LogLevel[config.logLevel])

  if (config.useRegex !== undefined) {
    optionsMap.add('use-regex', `${config.useRegex}`)
  }

  if (config.registryUrl !== undefined) {
    optionsMap.add('registry-url', `${config.registryUrl}`)
  }
  if (config.githubApiUrl !== undefined) {
    optionsMap.add('github-api-url', `${config.githubApiUrl}`)
  }

  core.startGroup('Runtime configuration')
  optionsMap.print()
  core.endGroup()

  return config
}
