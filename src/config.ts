import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

export class Config {
  owner?: string
  name?: string
  tags?: string
  excludeTags?: string
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
      `GET /repos/${this.owner}/${this.name}`
    )
    return result.data.owner.type
  }
}

export function getConfig(): Config {
  const token: string = core.getInput('token', { required: true })
  const config = new Config(token)

  // auto populate
  if (!config.owner || !config.name) {
    const GITHUB_REPOSITORY = process.env['GITHUB_REPOSITORY']
    if (GITHUB_REPOSITORY) {
      const parts = GITHUB_REPOSITORY.split('/')
      if (parts.length === 2) {
        if (!config.owner) {
          config.owner = parts[0]
        }
        if (!config.name) {
          config.name = parts[1]
        }
      }
    }
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

  if (config.tags && (config.keepNuntagged || config.keepNtagged)) {
    throw Error(
      'tags cannot be used with keep-n-untagged or keep-n-tagged options'
    )
  }
  if (config.keepNuntagged && config.keepNtagged) {
    throw Error(
      'keep-n-untagged and keep-n-tagged options can not be set at the same time'
    )
  }

  if (!config.owner) {
    throw new Error('owner is not set')
  }
  if (!config.name) {
    throw new Error('name is not set')
  }
  return config
}
