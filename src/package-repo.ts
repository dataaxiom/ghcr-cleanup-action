import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import { OctokitClient } from './octokit-client.js'
import { RequestError } from '@octokit/request-error'

/**
 * Provides access to a package via the GitHub Packages REST API.
 */
export class PackageRepo {
  // The action configuration
  config: Config

  // The Octokit client for API calls
  octokitClient: OctokitClient

  // Map of digests to package ids
  digest2Id = new Map<string, string>()

  // Map of ids to package version definitions
  id2Package = new Map<string, any>()

  // Map of tags to digests
  tag2Digest = new Map<string, string>()

  // the result state of the last delete package
  lastDeleteResult = true

  /**
   * Constructor
   *
   * @param config The action configuration
   * @param octokitClient The Octokit client for API calls
   */
  constructor(config: Config, octokitClient: OctokitClient) {
    this.config = config
    this.octokitClient = octokitClient
  }

  /**
   * Loads all versions of the package from the GitHub Packages API and populates the internal maps
   */
  async loadPackages(targetPackage: string, output: boolean): Promise<void> {
    try {
      // clear the maps for reloading
      this.digest2Id.clear()
      this.id2Package.clear()
      this.tag2Digest.clear()

      const octokit = this.octokitClient.getClient()
      // Using 'any' type here because TypeScript cannot unify the different function signatures
      // for Org vs User package endpoints. The actual type safety is maintained by the
      // parameters we pass to these functions.
      let getFunc: any =
        octokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg
      let getParams: any

      if (this.config.repoType === 'User') {
        getFunc = this.config.isPrivateRepo
          ? octokit.rest.packages
              .getAllPackageVersionsForPackageOwnedByAuthenticatedUser
          : octokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser

        getParams = {
          package_type: 'container' as const,
          package_name: targetPackage,
          username: this.config.owner,
          state: 'active' as const,
          per_page: 100
        }
      } else {
        getParams = {
          package_type: 'container' as const,
          package_name: targetPackage,
          org: this.config.owner,
          state: 'active' as const,
          per_page: 100
        }
      }
      for await (const response of octokit.paginate.iterator(
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

      if (output && this.config.logLevel >= LogLevel.INFO) {
        core.startGroup(`[${targetPackage}] Loaded package data`)
        for (const ghPackage of this.id2Package.values()) {
          let tags = ''
          for (const tag of ghPackage.metadata.container.tags) {
            tags += `${tag} `
          }
          core.info(`${ghPackage.id} ${ghPackage.name} ${tags}`)
        }
        core.endGroup()
      }
      if (output && this.config.logLevel === LogLevel.DEBUG) {
        core.startGroup(`[${targetPackage}] Loaded package payloads`)
        for (const ghPackage of this.id2Package.values()) {
          const payload = JSON.stringify(ghPackage, null, 4)
          core.info(payload)
        }
        core.endGroup()
      }
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status) {
          if (error.status === 404) {
            if (this.config.defaultPackageUsed) {
              core.warning(
                `The package "${targetPackage}" is not found in the repository ${this.config.owner}/${this.config.repository} and is currently using a generated value as it's not set on the action. Override the package option on the action to set to the package you want to cleanup.`
              )
            } else {
              core.warning(
                `The package "${targetPackage}" is not found in the repository ${this.config.owner}/${this.config.repository}, check the package value is correctly set.`
              )
            }
          }
        }
      }
      throw error
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
    targetPackage: string,
    id: string,
    digest: string,
    tags?: string[],
    label?: string
  ): Promise<void> {
    try {
      if (tags && tags.length > 0) {
        core.info(` deleting package id: ${id} digest: ${digest} tag: ${tags}`)
      } else if (label) {
        core.info(` deleting package id: ${id} digest: ${digest} ${label}`)
      } else {
        core.info(` deleting package id: ${id} digest: ${digest}`)
      }
      if (!this.config.dryRun) {
        const octokit = this.octokitClient.getClient()
        if (this.config.repoType === 'User') {
          if (this.config.isPrivateRepo) {
            await octokit.rest.packages.deletePackageVersionForAuthenticatedUser(
              {
                package_type: 'container' as const,
                package_name: targetPackage,
                package_version_id: parseInt(id)
              }
            )
          } else {
            await octokit.rest.packages.deletePackageVersionForUser({
              package_type: 'container' as const,
              package_name: targetPackage,
              username: this.config.owner,
              package_version_id: parseInt(id)
            })
          }
        } else {
          await octokit.rest.packages.deletePackageVersionForOrg({
            package_type: 'container' as const,
            package_name: targetPackage,
            org: this.config.owner,
            package_version_id: parseInt(id)
          })
        }
        this.lastDeleteResult = true
      }
    } catch (error) {
      let ignoreError = false
      if (error instanceof RequestError) {
        if (error.status) {
          // ignore 404's, seen these after a 502 error. whereby the first delete causes a 502 but it really
          // deleted the package version, the retry then tries again and returns a 404
          // only disregard 404 if that last call was successful - repeating 404s will fail action
          if (error.status === 404) {
            if (this.lastDeleteResult === true) {
              ignoreError = true
              core.warning(
                `The package "${targetPackage}" version id ${id} wasn't found while trying to delete it, something went wrong and ignoring this error.`
              )
              this.lastDeleteResult = false
            } else {
              core.warning(
                'Multiple 404 errors have occured, check the package settings and ensure the repository has been granted admin access'
              )
            }
          }
        }
      }
      if (!ignoreError) {
        throw error
      }
    }
  }

  /**
   * Get list of the packages in the GitHub account
   * @returns Array of package names
   */
  async getPackageList(): Promise<string[]> {
    const packages = []
    const octokit = this.octokitClient.getClient()

    // Using 'any' type here for the same reason as above - different API endpoints have
    // incompatible signatures that TypeScript cannot unify
    let listFunc: any
    let listParams: any

    if (this.config.repoType === 'User') {
      listFunc = this.config.isPrivateRepo
        ? octokit.rest.packages.listPackagesForAuthenticatedUser
        : octokit.rest.packages.listPackagesForUser

      listParams = {
        package_type: 'container' as const,
        username: this.config.owner,
        per_page: 100
      }
    } else {
      listFunc = octokit.rest.packages.listPackagesForOrganization
      listParams = {
        package_type: 'container' as const,
        org: this.config.owner,
        per_page: 100
      }
    }

    for await (const response of octokit.paginate.iterator(
      listFunc,
      listParams
    )) {
      for (const data of response.data) {
        packages.push(data.name)
      }
    }

    core.startGroup(
      `Available packages in repository: ${this.config.repository}`
    )
    for (const name of packages) {
      core.info(name)
    }
    core.endGroup()

    return packages
  }
}
