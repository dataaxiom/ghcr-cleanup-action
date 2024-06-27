import { Config } from './config.js'

/**
 * Provides access to a package via the GitHub Packages REST API.
 */
export class GithubPackageRepo {
  // The action configuration
  config: Config

  // The type of repository (User or Organization)
  repoType = 'Organization'

  // Map of tags to package versions.
  tag2version = new Map<string, any>()

  // Map of digests to package versions.
  digest2version = new Map<string, any>()

  /**
   * Constructor.
   *
   * @param config The action configuration
   */
  constructor(config: Config) {
    this.config = config
  }

  async init(): Promise<void> {
    // Determine the repository type (User or Organization).
    this.repoType = await this.config.getOwnerType()
  }

  /**
   * Loads all versions of the package from the GitHub Packages API and populates the internal maps.
   */
  async loadVersions(): Promise<void> {
    // Clear the internal maps.
    this.tag2version.clear()
    this.digest2version.clear()

    // Function to retrieve package versions.
    let getFunc

    // Parameters for the function call.
    let getParams

    if (this.repoType === 'User') {
      // Use the appropriate function for user repos.
      getFunc = this.config.isPrivateRepo
        ? this.config.octokit.rest.packages
            .getAllPackageVersionsForPackageOwnedByAuthenticatedUser
        : this.config.octokit.rest.packages
            .getAllPackageVersionsForPackageOwnedByUser

      // Parameters for the function call.
      getParams = {
        package_type: 'container',
        package_name: this.config.package,
        username: this.config.owner,
        state: 'active',
        per_page: 100
      }
    } else {
      getFunc =
        this.config.octokit.rest.packages
          .getAllPackageVersionsForPackageOwnedByOrg

      // Parameters for the function call.
      getParams = {
        package_type: 'container',
        package_name: this.config.package,
        org: this.config.owner,
        state: 'active',
        per_page: 100
      }
    }

    // Iterate over all package versions.
    for await (const response of this.config.octokit.paginate.iterator(
      getFunc,
      getParams
    )) {
      for (const packageVersion of response.data) {
        // Add the digest to the internal map.
        this.digest2version.set(packageVersion.name, packageVersion)

        // Add each tag to the internal map.
        for (const tag of packageVersion.metadata.container.tags) {
          this.tag2version.set(tag, packageVersion)
        }
      }
    }
  }

  /**
   * Return the tags for the package.
   * @returns The tags for the package.
   */
  getTags(): string[] {
    return Array.from(this.tag2version.keys())
  }

  /**
   * Return the package version for a tag.
   * @param tag The tag to search for.
   * @returns The package version for the tag.
   */
  getVersionForTag(tag: string): any {
    return this.tag2version.get(tag)
  }

  /**
   Return the digests for the package.
   * @returns The digests for the package.
   */
  getDigests(): string[] {
    return Array.from(this.digest2version.keys())
  }

  /**
   * Return the package version for a digest.
   * @param digest The digest to search for.
   * @returns The package version for the digest.
   */
  getVersionForDigest(digest: string): any {
    return this.digest2version.get(digest)
  }

  /**
   * Return all versions of the package.
   * @returns All versions of the package.
   */
  getVersions(): any[] {
    return Array.from(this.digest2version.values())
  }

  /**
   * Delete a package version.
   * @param id The ID of the package version to delete.
   */
  async deletePackageVersion(id: string): Promise<void> {
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
