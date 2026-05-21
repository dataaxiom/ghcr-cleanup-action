import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import { OctokitClient } from './octokit-client.js'
import { RequestError } from '@octokit/request-error'
import {
  GhPackage,
  parentDigestFromReferrerTag,
  runWithConcurrency
} from './utils.js'

// Concurrency for parallel page fetches in loadPackages. Modest fan-out
// — api.github.com applies per-token rate limits that throttling handles
// up to a point, and we'd rather not push other workflows' calls into a
// budget squeeze.
const PACKAGE_LIST_PAGE_CONCURRENCY = 10

/**
 * Parse the last-page number from a paginated GitHub API response's Link
 * header. Returns 1 when there is no `rel="last"` link, which is the
 * single-page case (nothing more to fetch).
 *
 * Example header:
 *   <https://api.github.com/...?page=2>; rel="next",
 *   <https://api.github.com/...?page=42>; rel="last"
 */
export function parseLastPageFromLinkHeader(
  linkHeader: string | undefined
): number {
  if (!linkHeader) return 1
  const match = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>\s*;\s*rel="last"/)
  if (!match) return 1
  const n = parseInt(match[1], 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * Provides access to a package via the GitHub Packages REST API.
 */
export class PackageRepo {
  // The action configuration
  config: Config

  // The Octokit client for API calls
  octokitClient: OctokitClient

  // Map of digests to package ids
  digest2Id = new Map<string, number>()

  // Map of ids to package version definitions
  id2Package = new Map<number, GhPackage>()

  // Map of tags to digests
  tag2Digest = new Map<string, string>()

  // Reverse index: parent image digest → sha256-<digest>.<suffix> tags
  // that fall back to it (cosign signatures, attestations, etc).
  // Populated by loadPackages so the analyzer/deleter don't have to do
  // an O(N×T) scan over every tag for every digest they process.
  referrerTagsByParent = new Map<string, string[]>()

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
  /**
   * Load the package list into the in-memory maps.
   *
   * @param afterLoad - optional callback fired inside the
   *   `[Loaded package data]` log group (when `output` is true), before
   *   the group closes. Lets the caller emit related diagnostic lines
   *   (e.g. manifest-cache prune output) into the same collapsible
   *   section instead of leaking out as a standalone line. The caller
   *   sees the fully-populated cache state.
   */
  async loadPackages(
    targetPackage: string,
    output: boolean,
    afterLoad?: () => void
  ): Promise<void> {
    try {
      // clear the maps for reloading
      this.digest2Id.clear()
      this.id2Package.clear()
      this.tag2Digest.clear()
      this.referrerTagsByParent.clear()
      // reset the 404-tolerance flag so each fresh load starts with a clean
      // "last delete succeeded" baseline (the flag tolerates a single 404 that
      // follows a real delete - we don't want a stale `false` from a prior
      // package leaking in if this repo is ever reused).
      this.lastDeleteResult = true

      const octokit = this.octokitClient.getClient()
      // Three-branch endpoint dispatch with full Octokit types — each
      // branch has a different required owner param (org / username /
      // none), so a single polymorphic helper would need a discriminated
      // union or fall back to `any`. Inline dispatch is clearer and
      // type-safe; the only cast in the flow is `response.data as
      // GhPackage[]` at the ingest boundary (see ingestPage comment).
      const fetchPage = async (
        page: number
      ): Promise<{ data: unknown[]; headers: { link?: string } }> => {
        if (this.config.repoType === 'User') {
          if (this.config.tokenOwnsPackage) {
            return await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByAuthenticatedUser(
              {
                package_type: 'container',
                package_name: targetPackage,
                state: 'active',
                per_page: 100,
                page
              }
            )
          }
          return await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser(
            {
              package_type: 'container',
              package_name: targetPackage,
              username: this.config.owner,
              state: 'active',
              per_page: 100,
              page
            }
          )
        }
        return await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg(
          {
            package_type: 'container',
            package_name: targetPackage,
            org: this.config.owner,
            state: 'active',
            per_page: 100,
            page
          }
        )
      }

      // Custom paginator: fetch page 1 to discover the total page count
      // from the Link header, then fan out remaining pages in parallel.
      // octokit.paginate.iterator follows the rel="next" cursor
      // sequentially, which on a 60k-package repo means ~600 strictly-
      // serial round trips to api.github.com — minutes of wall clock.
      //
      // Boundary cast: Octokit's PackageVersion has `metadata?` and
      // `container?` as optional, but the container-package endpoints
      // always return populated `metadata.container.tags`. Asserting
      // the shape here keeps the rest of the codebase on the
      // required-field GhPackage type without scattering `?.` guards.
      const ingestPage = (data: unknown[]): void => {
        const packages = data as GhPackage[]
        for (const packageVersion of packages) {
          this.digest2Id.set(packageVersion.name, packageVersion.id)
          this.id2Package.set(packageVersion.id, packageVersion)
          for (const tag of packageVersion.metadata.container.tags) {
            this.tag2Digest.set(tag, packageVersion.name)
          }
        }
      }

      const firstResponse = await fetchPage(1)
      ingestPage(firstResponse.data)

      const lastPage = parseLastPageFromLinkHeader(firstResponse.headers?.link)
      if (lastPage > 1) {
        const remainingPages = Array.from(
          { length: lastPage - 1 },
          (_, i) => i + 2
        )
        await runWithConcurrency(
          remainingPages,
          PACKAGE_LIST_PAGE_CONCURRENCY,
          async page => {
            const response = await fetchPage(page)
            // JS is single-threaded — concurrent ingestPage calls
            // mutate the same Maps safely.
            ingestPage(response.data)
          }
        )
      }

      // Build the fallback-tag-by-parent reverse index in one pass after
      // the maps are populated. The three call sites that need this
      // (image-deleter cascade, manifest-analyzer initFilterSet /
      // primeManifests) used to do O(N×T) scans over every tag per
      // digest — quadratic on repos with tens of thousands of tags.
      for (const tag of this.tag2Digest.keys()) {
        const parent = parentDigestFromReferrerTag(tag)
        if (parent) {
          let list = this.referrerTagsByParent.get(parent)
          if (!list) {
            list = []
            this.referrerTagsByParent.set(parent, list)
          }
          list.push(tag)
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
        // Run inside the group so related diagnostic lines (e.g. manifest-
        // cache prune) appear alongside the package listing.
        afterLoad?.()
        core.endGroup()
      } else {
        // Even when the group isn't being printed, give the caller its
        // post-load callback so cache-pruning still happens.
        afterLoad?.()
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
            // The cleanup decision path no longer depends on a parent
            // repository (issue #117) — surface the package's actual
            // owner/name path in the error rather than synthesising a
            // (potentially nonexistent) owner/repository pair.
            const ownerPath = `${this.config.owner}/${targetPackage}`
            if (this.config.defaultPackageUsed) {
              core.warning(
                `The package "${targetPackage}" is not found under ${ownerPath} and is currently using a generated value as it's not set on the action. Override the package option on the action to set to the package you want to cleanup.`
              )
            } else {
              core.warning(
                `The package "${targetPackage}" is not found under ${ownerPath}, check the package value is correctly set.`
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
  getIdByDigest(digest: string): number | undefined {
    return this.digest2Id.get(digest)
  }

  /**
   * Return the `sha256-<digest>.<suffix>` referrer tags that fall back
   * to the given parent digest. Empty array if no such tags exist.
   */
  getReferrerTagsForDigest(parentDigest: string): string[] {
    return this.referrerTagsByParent.get(parentDigest) ?? []
  }

  /**
   * Return the package version descriptor for the given digest
   * @param digest The digest to lookup
   * @returns The the package descriptor
   */
  getPackageByDigest(digest: string): GhPackage | undefined {
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
    id: number,
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
          if (this.config.tokenOwnsPackage) {
            await octokit.rest.packages.deletePackageVersionForAuthenticatedUser(
              {
                package_type: 'container' as const,
                package_name: targetPackage,
                package_version_id: id
              }
            )
          } else {
            await octokit.rest.packages.deletePackageVersionForUser({
              package_type: 'container' as const,
              package_name: targetPackage,
              username: this.config.owner,
              package_version_id: id
            })
          }
        } else {
          await octokit.rest.packages.deletePackageVersionForOrg({
            package_type: 'container' as const,
            package_name: targetPackage,
            org: this.config.owner,
            package_version_id: id
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
                'Multiple 404 errors have occurred, check the package settings and ensure the repository has been granted admin access'
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
    const packages: string[] = []
    const octokit = this.octokitClient.getClient()

    // Three-branch dispatch with paginate.iterator per branch.
    // Inlining is more verbose than a single polymorphic call, but each
    // endpoint has a different required owner param so unifying them
    // forces `any` on the function reference. Each branch's iterator
    // is fully typed end-to-end.
    const ingest = (data: ReadonlyArray<{ name: string }>): void => {
      for (const pkg of data) {
        packages.push(pkg.name)
      }
    }

    if (this.config.repoType === 'User') {
      if (this.config.tokenOwnsPackage) {
        for await (const response of octokit.paginate.iterator(
          octokit.rest.packages.listPackagesForAuthenticatedUser,
          { package_type: 'container', per_page: 100 }
        )) {
          ingest(response.data)
        }
      } else {
        for await (const response of octokit.paginate.iterator(
          octokit.rest.packages.listPackagesForUser,
          {
            package_type: 'container',
            username: this.config.owner,
            per_page: 100
          }
        )) {
          ingest(response.data)
        }
      }
    } else {
      for await (const response of octokit.paginate.iterator(
        octokit.rest.packages.listPackagesForOrganization,
        { package_type: 'container', org: this.config.owner, per_page: 100 }
      )) {
        ingest(response.data)
      }
    }

    core.startGroup(`Available packages for owner: ${this.config.owner}`)
    for (const name of packages) {
      core.info(name)
    }
    core.endGroup()

    return packages
  }
}
