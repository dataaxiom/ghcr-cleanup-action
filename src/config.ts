import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

export class Config {
  owner?: string
  isPrivateRepo = false
  repository?: string
  package?: string
  tags?: string
  excludeTags?: string
  validate?: boolean
  keepNuntagged?: number
  keepNtagged?: number
  dryRun?: boolean
  token: string
  octokit: any

  constructor(token: string) {
    this.token = token
    this.octokit = getOctokit(token)
  }

  async getOwnerType(): Promise<string> {
    const result = await this.octokit.request(
      `GET /repos/${this.owner}/${this.repository}`
    )
    this.isPrivateRepo = result.data.private
    return result.data.owner.type
  }
}

export function getConfig(): Config {
  const token: string = core.getInput('token', { required: true })
  const config = new Config(token)

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
      }
      config.repository = parts[1]
    } else {
      throw Error(`Error parsing GITHUB_REPOSITORY: ${GITHUB_REPOSITORY}`)
    }
  } else {
    throw Error('GITHUB_REPOSITORY is not set')
  }

  config.tags = core.getInput('tags')
  config.excludeTags = core.getInput('exclude-tags')
  if (core.getInput('dry-run')) {
    config.dryRun = core.getBooleanInput('dry-run')
    if (config.dryRun) {
      core.info('in dry run mode - no packages will be deleted')
    }
  } else {
    config.dryRun = false
  }
  if (core.getInput('validate')) {
    config.validate = core.getBooleanInput('validate')
  } else {
    config.validate = false
  }

  if (core.getInput('keep-n-untagged')) {
    if (isNaN(parseInt(core.getInput('keep-n-untagged')))) {
      throw new Error('keep-n-untagged is not number')
    } else {
      config.keepNuntagged = parseInt(core.getInput('keep-n-untagged'))
    }
  }
  if (core.getInput('keep-n-tagged')) {
    if (isNaN(parseInt(core.getInput('keep-n-tagged')))) {
      throw new Error('keep-n-tagged is not number')
    } else {
      config.keepNtagged = parseInt(core.getInput('keep-n-tagged'))
    }
  }

  if (config.keepNuntagged && config.keepNtagged) {
    throw Error(
      'keep-n-untagged and keep-n-tagged options can not be set at the same time'
    )
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
  return config
}
