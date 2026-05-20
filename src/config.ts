import * as core from '@actions/core'
import { MapPrinter, validateUserRegex } from './utils.js'
import { OctokitClient } from './octokit-client.js'
import humanInterval from 'human-interval'

export enum LogLevel {
  ERROR = 1,
  WARN,
  INFO,
  DEBUG
}

export class Config {
  // True when the authenticated token's login matches `owner` —
  // tells package-repo which Packages-API endpoint flavour to call:
  // - tokenOwnsPackage  → packages.forAuthenticatedUser.*
  // - !tokenOwnsPackage → packages.forUser.* (or forOrg if owner is Org)
  // Named for what it actually means; replaced the older `isPrivateRepo`
  // proxy, which was derived from an unrelated repository's privacy flag.
  tokenOwnsPackage = false
  repoType: 'User' | 'Organization' = 'Organization'
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
  token = ''
  registryUrl?: string
  githubApiUrl?: string

  constructor() {
    this.logLevel = LogLevel.INFO
  }
}

export async function buildConfig(): Promise<Config> {
  const token: string = core.getInput('token', { required: true })
  const config = new Config()
  config.token = token
  config.owner = core.getInput('owner')
  config.repository = core.getInput('repository')

  if (core.getInput('package') && core.getInput('packages')) {
    throw Error(
      'package and packages cannot be used at the same time, use either one'
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
  } else {
    // check if the value has a wildcard and expand-packages isn't set
    if (config.package.includes('*') || config.package.includes('?')) {
      core.info(
        `The packages value "${config.package}" contains a wildcard character but the expand-packages option has not been set, auto enabling expand-packages to true`
      )
      config.expandPackages = true
    }
  }

  if (core.getInput('tags') && core.getInput('delete-tags')) {
    throw Error(
      'tags and delete-tags cannot be used at the same time, use either one'
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

    // humanInterval returns undefined for unparsable strings and NaN for
    // partially-parsed ones. Both must be treated as fatal — otherwise the
    // filter is silently skipped at runtime.
    if (config.olderThan == null || isNaN(config.olderThan)) {
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

  if (config.keepNuntagged != null && core.getInput('delete-untagged')) {
    throw new Error(
      'delete-untagged and keep-n-untagged cannot be set at the same time'
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

  // When regex mode is on, validate every user-supplied pattern up front
  // so a ReDoS-prone or absurdly long pattern fails fast with a clear
  // message rather than burning workflow minutes inside `.test()`.
  if (config.useRegex) {
    if (config.deleteTags) {
      validateUserRegex(config.deleteTags, 'delete-tags')
    }
    if (config.excludeTags) {
      validateUserRegex(config.excludeTags, 'exclude-tags')
    }
    if (config.expandPackages && config.package) {
      validateUserRegex(config.package, 'package')
    }
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
  // `repository` is no longer required. It now only appears in
  // diagnostic log lines; the cleanup decision path uses `owner` + token
  // identity directly. Falls back to empty string if unset.

  // Identify the owner (User vs Organization) and the authenticated
  // token's login. Endpoint selection in package-repo.ts uses these
  // directly — no repository lookup needed. See issue #117.
  const octokitClient = new OctokitClient(
    config.token,
    config.githubApiUrl,
    config.logLevel
  )
  config.repoType = await octokitClient.getOwnerType(config.owner)
  const tokenLogin = await octokitClient.getAuthenticatedUserLogin()
  config.tokenOwnsPackage =
    tokenLogin !== null &&
    tokenLogin.toLowerCase() === config.owner.toLowerCase()

  const optionsMap = new MapPrinter()
  optionsMap.add('token owns package', `${config.tokenOwnsPackage}`)
  optionsMap.add('project owner', `${config.owner}`)
  // `repository` was previously printed here. Removed in the #117 fix —
  // the field is no longer load-bearing and showing it implied otherwise.
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
