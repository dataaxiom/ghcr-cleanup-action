import * as core from '@actions/core'
import { Config } from './config'

export class GithubPackage {
  config: Config
  repoType = 'Organization'

  constructor(config: Config) {
    this.config = config
  }

  async init(): Promise<void> {
    this.repoType = await this.config.getOwnerType()
  }

  async loadPackages(
    byDigest: Map<string, string>,
    packages: Map<string, any>
  ): Promise<void> {
    let getFunc =
      this.config.octokit.rest.packages
        .getAllPackageVersionsForPackageOwnedByOrg
    let getParams = {}

    if (this.repoType === 'User') {
      getFunc =
        this.config.octokit.rest.packages
          .getAllPackageVersionsForPackageOwnedByUser

      getParams = {
        package_type: 'container',
        package_name: this.config.name,
        username: this.config.owner,
        state: 'active',
        per_page: 100
      }
    } else {
      getParams = {
        package_type: 'container',
        package_name: this.config.name,
        org: this.config.owner,
        state: 'active',
        per_page: 100
      }
    }
    for await (const response of this.config.octokit.paginate.iterator(
      getFunc,
      getParams
    )) {
      for (const packageVersion of response.data) {
        byDigest.set(packageVersion.name, packageVersion.id)
        packages.set(packageVersion.id, packageVersion)
      }
    }
  }

  async deletePackage(
    id: string,
    digest: string,
    tags: string[]
  ): Promise<void> {
    if (tags.length > 0) {
      core.info(`deleting package id: ${id} digest:${digest} tag:${tags}`)
    } else {
      core.info(`deleting package id: ${id} digest:${digest}`)
    }
    if (!this.config.dryRun) {
      if (this.repoType === 'User') {
        await this.config.octokit.rest.packages.deletePackageVersionForUser({
          package_type: 'container',
          package_name: this.config.name,
          username: this.config.owner,
          package_version_id: id
        })
      } else {
        await this.config.octokit.rest.packages.deletePackageVersionForOrg({
          package_type: 'container',
          package_name: this.config.name,
          org: this.config.owner,
          package_version_id: id
        })
      }
    }
  }

  async getPackage(id: string) {
    if (this.repoType === 'User') {
      return await this.config.octokit.rest.packages.getPackageVersionForUser({
        package_type: 'container',
        package_name: this.config.name,
        package_version_id: id,
        username: this.config.owner
      })
    } else {
      return await this.config.octokit.rest.packages.getPackageVersionForOrganization(
        {
          package_type: 'container',
          package_name: this.config.name,
          package_version_id: id,
          org: this.config.owner
        }
      )
    }
  }
}
