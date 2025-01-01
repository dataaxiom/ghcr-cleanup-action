import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import axios, { AxiosInstance, isAxiosError } from 'axios'
import axiosRetry from 'axios-retry'
import * as AxiosLogger from 'axios-logger'
import { isValidChallenge, parseChallenge } from './utils.js'
import { setGlobalConfig } from 'axios-logger'
import { PackageRepo } from './package-repo.js'

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
  manifestCache = new Map<string, any>()

  // map of referrer manifests
  //referrersCache = new Map<string, any>()

  /**
   * Constructor
   *
   * @param config The action configuration
   */
  constructor(config: Config, githubPackageRepo: PackageRepo) {
    this.config = config
    this.githubPackageRepo = githubPackageRepo
    if (this.config.registryUrl) {
      this.baseUrl = this.config.registryUrl
    } else {
      this.baseUrl = 'https://ghcr.io/'
    }
    this.axios = axios.create({
      baseURL: this.baseUrl
    })
    axiosRetry(this.axios, { retries: 3 })
    this.axios.defaults.headers.common['Accept'] =
      'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json'

    setGlobalConfig({
      data: false,
      logger: core.info.bind(this)
    })

    // set the axios logging on if log level is debug
    if (this.config.logLevel === LogLevel.DEBUG) {
      this.axios.interceptors.request.use(AxiosLogger.requestLogger as any)
      this.axios.interceptors.response.use(AxiosLogger.responseLogger as any)
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
                `${this.baseUrl} login failed: ${token.response.data}`
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
      }
    }
  }

  /**
   * Retrieves a manifest by its digest
   *
   * @param digest - The digest of the manifest to retrieve
   * @returns A Promise that resolves to the retrieved manifest
   */
  async getManifestByDigest(digest: string): Promise<any> {
    if (this.manifestCache.has(digest)) {
      return this.manifestCache.get(digest)
    } else {
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
      const obj = JSON.parse(response?.data)
      // save it for later use
      this.manifestCache.set(digest, obj)
      return obj
    }
  }

  /**
   * Retrieves a manifest by its tag
   *
   * @param tag - The tag of the manifest to retrieve
   * @returns A Promise that resolves to the retrieved manifest
   */
  async getManifestByTag(tag: string): Promise<any> {
    const tagDigest = this.githubPackageRepo.getDigestByTag(tag)
    if (tagDigest) {
      return await this.getManifestByDigest(tagDigest)
    }
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
    manifest: any,
    multiArch: boolean
  ): Promise<void> {
    if (!this.config.dryRun) {
      const contentType = manifest.mediaType
      const config = {
        headers: {
          'Content-Type': contentType
        }
      }
      // upgrade token
      let putToken
      const auth = axios.create()
      axiosRetry(auth, { retries: 3 })
      try {
        await auth.put(
          `${this.baseUrl}v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
          manifest,
          config
        )
      } catch (error) {
        if (isAxiosError(error) && error.response) {
          if (error.response.status === 401) {
            const challenge = error.response?.headers['www-authenticate']
            const attributes = parseChallenge(challenge)
            if (isValidChallenge(attributes)) {
              // crude
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
              throw new Error(`invalid www-authenticate challenge ${challenge}`)
            }
          } else {
            throw error
          }
        } else {
          throw error
        }
      }

      if (putToken) {
        // now put the updated manifest
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
      } else {
        throw new Error('no token set to upload manifest')
      }
    }
  }

  // TODO
  // ghcr.io not yet supporting referrers api?
  /*async getReferrersManifest(digest: string): Promise<any> {
    if (this.referrersCache.has(digest)) {
      return this.referrersCache.get(digest)
    } else {
      const response = await this.axios.get(
        `/v2/${this.config.owner}/${this.targetPackage}/referrers/${digest}`,
        {
          transformResponse: [
            data => {
              return data
            }
          ]
        }
      )
      const obj = JSON.parse(response?.data)
      // save it for later use
      this.referrersCache.set(digest, obj)
      return obj
    }
  } */
}
