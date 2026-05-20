import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import axios, { AxiosInstance, isAxiosError } from 'axios'
import axiosRetry from 'axios-retry'
import * as AxiosLogger from 'axios-logger'
import { isValidChallenge, parseChallenge, Manifest } from './utils.js'
import { setGlobalConfig } from 'axios-logger'
import { PackageRepo } from './package-repo.js'
import {
  ManifestCache,
  distillManifest,
  reconstituteManifest
} from './manifest-cache.js'

/**
 * Provides access to the GitHub Container Registry via the Docker Registry HTTP API V2.
 */
export class Registry {
  // The action configuration
  config: Config

  // Reference to the package cache
  githubPackageRepo: PackageRepo

  // http client library instance
  axios: AxiosInstance

  // registry url
  baseUrl: string

  // current package working on
  targetPackage = ''

  // cache of loaded manifests, by digest
  manifestCache = new Map<string, Manifest>()

  // Cross-run distilled cache. Optional — null disables persistent caching
  // (e.g. when running outside a GitHub Actions runner).
  private distilledCache: ManifestCache | null

  /**
   * Constructor
   *
   * @param config The action configuration
   * @param githubPackageRepo The package repo cache
   * @param distilledCache Optional cross-run manifest cache
   */
  constructor(
    config: Config,
    githubPackageRepo: PackageRepo,
    distilledCache: ManifestCache | null = null
  ) {
    this.config = config
    this.githubPackageRepo = githubPackageRepo
    this.distilledCache = distilledCache
    if (this.config.registryUrl) {
      this.baseUrl = this.config.registryUrl
    } else {
      this.baseUrl = 'https://ghcr.io/'
    }
    this.axios = axios.create({
      baseURL: this.baseUrl
    })
    // Retry network errors, 5xx, AND 429 rate limits. The default
    // axios-retry condition skips 429s, which surface from ghcr.io
    // under bursty parallel reads (manifest fan-out, untag PUTs).
    // exponentialDelay honors the Retry-After header automatically when
    // present, so we honor the server's hint without an extra hook.
    axiosRetry(this.axios, {
      retries: 3,
      retryCondition: error =>
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        error.response?.status === 429,
      retryDelay: (retryNumber, error) =>
        axiosRetry.exponentialDelay(retryNumber, error)
    })
    this.axios.defaults.headers.common['Accept'] =
      'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'

    setGlobalConfig({
      data: false,
      logger: core.info
    })

    // set the axios logging on if log level is debug
    if (this.config.logLevel === LogLevel.DEBUG) {
      this.axios.interceptors.request.use(AxiosLogger.requestLogger)
      this.axios.interceptors.response.use(AxiosLogger.responseLogger)
    }
  }

  /**
   * Logs in to the registry
   * This method retrieves a token and handles authentication challenges if necessary
   * @returns A Promise that resolves when the login is successful
   * @throws If an error occurs during the login process
   */
  async login(targetPackage: string): Promise<void> {
    // reset the cache
    this.manifestCache.clear()
    this.targetPackage = targetPackage

    try {
      if (this.config.logLevel === LogLevel.DEBUG) {
        core.info('issuing an authentication challenge')
      }
      // get token
      await this.axios.get(
        `/v2/${this.config.owner}/${targetPackage}/tags/list`
      )
    } catch (error) {
      if (isAxiosError(error) && error.response) {
        if (error.response?.status === 401) {
          const challenge = error.response?.headers['www-authenticate']
          const attributes = parseChallenge(challenge)
          if (isValidChallenge(attributes)) {
            const auth = axios.create()
            axiosRetry(auth, { retries: 3 })
            const tokenResponse = await auth.get(
              `${attributes.get('realm')}?service=${attributes.get('service')}&scope=${attributes.get('scope')}`,
              {
                auth: {
                  username: 'token',
                  password: this.config.token
                }
              }
            )
            const token = tokenResponse.data.token
            if (token) {
              this.axios.defaults.headers.common['Authorization'] =
                `Bearer ${token}`
              if (this.config.logLevel === LogLevel.DEBUG) {
                core.info('authentication challenge succeded')
              }
            } else {
              throw new Error(
                `${this.baseUrl} login failed: ${JSON.stringify(tokenResponse.data)}`
              )
            }
          } else {
            throw new Error(`invalid www-authenticate challenge ${challenge}`)
          }
        } else {
          core.setFailed(
            `Error logging into registry API with package: ${targetPackage}`
          )
          throw error
        }
      } else {
        // Non-axios error or error without a response — rethrow so caller sees it
        throw error
      }
    }
  }

  /**
   * Retrieves a manifest by its digest. May return a reconstituted manifest
   * sourced from the cross-run distilled cache — sufficient for the cleanup
   * pipeline's read paths (analyzer, deleter cascade, validator) but NOT
   * safe for round-tripping back to the registry. The untag-PUT path must
   * use {@link getRawManifestByDigest} instead.
   *
   * @param digest - The digest of the manifest to retrieve
   */
  async getManifestByDigest(digest: string): Promise<Manifest> {
    const cached = this.manifestCache.get(digest)
    if (cached) {
      return cached
    }
    const distilled = this.distilledCache?.get(digest)
    if (distilled) {
      const reconstituted = reconstituteManifest(distilled)
      this.manifestCache.set(digest, reconstituted)
      return reconstituted
    }
    return await this.fetchAndCacheManifest(digest)
  }

  /**
   * Always hits the registry and returns the full, unmodified manifest body.
   * Required for the untag flow, which clones the manifest and PUTs it back.
   */
  async getRawManifestByDigest(digest: string): Promise<Manifest> {
    // If the in-memory cache holds an entry that originated from the
    // distilled cache, the cloned PUT would be missing fields. Force a
    // refetch by skipping in-memory cache too — partial entries can't be
    // distinguished without extra bookkeeping, and a single PUT-path fetch
    // per untag operation is cheap.
    return await this.fetchAndCacheManifest(digest)
  }

  private async fetchAndCacheManifest(digest: string): Promise<Manifest> {
    const response = await this.axios.get(
      `/v2/${this.config.owner}/${this.targetPackage}/manifests/${digest}`,
      {
        transformResponse: [
          data => {
            return data
          }
        ]
      }
    )
    // ghcr.io's response shape is trusted — no runtime validation.
    const obj: Manifest = JSON.parse(response?.data)
    this.manifestCache.set(digest, obj)
    if (this.distilledCache) {
      this.distilledCache.set(digest, distillManifest(obj))
    }
    return obj
  }

  /**
   * Retrieves a manifest by its tag
   *
   * @param tag - The tag of the manifest to retrieve
   * @returns A Promise that resolves to the retrieved manifest
   */
  async getManifestByTag(tag: string): Promise<Manifest | undefined> {
    const tagDigest = this.githubPackageRepo.getDigestByTag(tag)
    if (tagDigest) {
      return await this.getManifestByDigest(tagDigest)
    }
    return undefined
  }

  /**
   * Puts the manifest for a given tag in the registry.
   * @param tag - The tag of the manifest.
   * @param manifest - The manifest to be put.
   * @param multiArch - A boolean indicating whether the manifest is for a multi-architecture image.
   * @returns A Promise that resolves when the manifest is successfully put in the registry.
   */
  async putManifest(
    tag: string,
    manifest: Manifest,
    multiArch: boolean
  ): Promise<void> {
    if (!this.config.dryRun) {
      const contentType = manifest.mediaType
      const config = {
        headers: {
          'Content-Type': contentType
        }
      }

      const auth = axios.create()
      axiosRetry(auth, { retries: 3 })

      let putToken: string | undefined
      try {
        await auth.put(
          `${this.baseUrl}v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
          manifest,
          config
        )
        // No challenge issued — upload already succeeded
        return
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 401) {
          const challenge = error.response.headers['www-authenticate']
          const attributes = parseChallenge(challenge)
          if (!isValidChallenge(attributes)) {
            throw new Error(`invalid www-authenticate challenge ${challenge}`)
          }
          const tokenResponse = await auth.get(
            `${attributes.get('realm')}?service=${attributes.get('service')}&scope=${attributes.get('scope')}`,
            {
              auth: {
                username: 'token',
                password: this.config.token
              }
            }
          )
          putToken = tokenResponse.data.token
        } else {
          throw error
        }
      }

      if (!putToken) {
        throw new Error(
          'failed to obtain push token from authentication challenge'
        )
      }

      await this.axios.put(
        `/v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
        manifest,
        {
          headers: {
            'content-type': contentType,
            Authorization: `Bearer ${putToken}`
          }
        }
      )
    }
  }
}
