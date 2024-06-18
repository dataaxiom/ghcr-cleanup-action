import * as core from '@actions/core'
import { Config } from './config.js'

export class GithubPackageRepo {
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
    let getParams

    if (this.repoType === 'User') {
      getFunc = this.config.isPrivateRepo
        ? this.config.octokit.rest.packages
            .getAllPackageVersionsForPackageOwnedByAuthenticatedUser
        : this.config.octokit.rest.packages
            .getAllPackageVersionsForPackageOwnedByUser

      getParams = {
        package_type: 'container',
        package_name: this.config.package,
        username: this.config.owner,
        state: 'active',
        per_page: 100
      }
    } else {
      getParams = {
        package_type: 'container',
        package_name: this.config.package,
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

  async deletePackageVersion(
    id: string,
    digest: string,
    tags?: string[],
    label?: string
  ): Promise<void> {
    if (tags && tags.length > 0) {
      core.info(` deleting package id: ${id} digest: ${digest} tag: ${tags}`)
    } else if (label) {
      core.info(` deleting package id: ${id} digest: ${digest} ${label}`)
    } else {
      core.info(` deleting package id: ${id} digest: ${digest}`)
    }
    if (!this.config.dryRun) {
      if (this.repoType === 'User') {
        ;(await this.config.isPrivateRepo)
          ? this.config.octokit.rest.packages.deletePackageVersionForAuthenticatedUser(
              {
                package_type: 'container',
                package_name: this.config.package,
                package_version_id: id
              }
            )
          : this.config.octokit.rest.packages.deletePackageVersionForUser({
              package_type: 'container',
              package_name: this.config.package,
              username: this.config.owner,
              package_version_id: id
            })
      } else {
        await this.config.octokit.rest.packages.deletePackageVersionForOrg({
          package_type: 'container',
          package_name: this.config.package,
          org: this.config.owner,
          package_version_id: id
        })
      }
    }
  }
}
