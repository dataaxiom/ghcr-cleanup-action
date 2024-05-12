import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

export class Config {
  owner?: string
  name?: string
  tags?: string
  numberUntagged?: number
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

  if (core.getInput('number-untagged')) {
    if (isNaN(parseInt(core.getInput('number-untagged')))) {
      throw new Error('number-untagged is not number')
    } else {
      config.numberUntagged = parseInt(core.getInput('number-untagged'))
    }
  }

  if (config.tags && config.numberUntagged) {
    throw Error('tags and number-untagged can not be set at the same time')
  }

  if (!config.owner) {
    throw new Error('owner is not set')
  }
  if (!config.name) {
    throw new Error('name is not set')
  }
  return config
}
