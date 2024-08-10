import * as core from '@actions/core'
import { Config } from './config.js'

/**
 * Provides access to a package via the GitHub Packages REST API.
 */
export class GithubPackageRepo {
  // The action configuration
  config: Config

  // The type of repository (User or Organization)
  repoType = 'Organization'

  // Map of digests to package ids
  digest2Id = new Map<string, string>()

  // Map of ids to package version definitions
  id2Package = new Map<string, any>()

  // Map of tags to digests
  tag2Digest = new Map<string, string>()

  /**
   * Constructor
   *
   * @param config The action configuration
   */
  constructor(config: Config) {
    this.config = config
  }

  /*
   * Initialization method.
   */
  async init(): Promise<void> {
    // Determine the repository type (User or Organization)
    this.repoType = await this.config.getOwnerType()
  }

  /**
   * Loads all versions of the package from the GitHub Packages API and populates the internal maps
   */
  async loadPackages(): Promise<void> {
    // clear the maps for reloading
    this.digest2Id.clear()
    this.id2Package.clear()
    this.tag2Digest.clear()

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
        this.digest2Id.set(packageVersion.name, packageVersion.id)
        this.id2Package.set(packageVersion.id, packageVersion)
        for (const tag of packageVersion.metadata.container.tags) {
          this.tag2Digest.set(tag, packageVersion.name)
        }
      }
    }
  }

  /**
   * Return all tags in use for the package
   * @returns The tags for the package
   */
  getTags(): Set<string> {
    return new Set(this.tag2Digest.keys())
  }

  /**
   * Return all digests version in use for the package
   * @returns The digests for the package
   */
  getDigests(): Set<string> {
    return new Set(this.digest2Id.keys())
  }

  /**
   * Return the digest for given tag
   * @param The tag to lookup
   * @returns The the digest
   */
  getDigestByTag(tag: string): string | undefined {
    return this.tag2Digest.get(tag)
  }

  /**
   * Return the package version id for the given digest
   * @returns The the package id
   */
  getIdByDigest(digest: string): string | undefined {
    return this.digest2Id.get(digest)
  }

  /**
   * Return the package version descriptor for the given digest
   * @param digest The digest to lookup
   * @returns The the package descriptor
   */
  getPackageByDigest(digest: string): any | undefined {
    let ghPackage
    const id = this.digest2Id.get(digest)
    if (id) {
      ghPackage = this.id2Package.get(id)
    }
    return ghPackage
  }

  /**
   * Delete a package version
   * @param id The ID of the package version to delete
   * @param digest The associated digest for the package version
   * @param tags The tags associated with the package
   * @param label Additional label to display
   */
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
        if (this.config.isPrivateRepo) {
          await this.config.octokit.rest.packages.deletePackageVersionForAuthenticatedUser(
            {
              package_type: 'container',
              package_name: this.config.package,
              package_version_id: id
            }
          )
        } else {
          await this.config.octokit.rest.packages.deletePackageVersionForUser({
            package_type: 'container',
            package_name: this.config.package,
            username: this.config.owner,
            package_version_id: id
          })
        }
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
