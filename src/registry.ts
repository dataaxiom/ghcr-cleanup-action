import { Config } from './config.js'
import axios, { AxiosInstance, isAxiosError } from 'axios'
import axiosRetry from 'axios-retry'
import { calcDigest, isValidChallenge, parseChallenge } from './utils.js'

/**
 * Provides access to the GitHub Container Registry via the Docker Registry HTTP API V2.
 */
export class Registry {
  // The action configuration
  config: Config

  // http client library instance
  axios: AxiosInstance

  // cache of loaded manifests, by digest
  manifestCache = new Map<string, any>()

  // map of tag digests
  digestByTagCache = new Map<string, string>()

  // map of referrer manifests
  referrersCache = new Map<string, any>()

  /**
   * Constructor
   *
   * @param config The action configuration
   */
  constructor(config: Config) {
    this.config = config
    this.axios = axios.create({
      baseURL: 'https://ghcr.io/'
    })
    axiosRetry(this.axios, { retries: 3 })
    this.axios.defaults.headers.common['Accept'] =
      'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json'
  }

  /**
   * Logs in to the registry
   * This method retrieves a token and handles authentication challenges if necessary
   * @returns A Promise that resolves when the login is successful
   * @throws If an error occurs during the login process
   */
  async login(): Promise<void> {
    try {
      // get token
      await this.axios.get(
        `/v2/${this.config.owner}/${this.config.package}/tags/list`
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
            } else {
              throw new Error(`ghcr.io login failed: ${token.response.data}`)
            }
          } else {
            throw new Error(`invalid www-authenticate challenge ${challenge}`)
          }
        } else {
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
        `/v2/${this.config.owner}/${this.config.package}/manifests/${digest}`,
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
   * Delete the associated cached digest for tag
   *
   * @param tag - The tag to delete
   */
  deleteTag(tag: string): void {
    this.digestByTagCache.delete(tag)
  }

  /**
   * Retrieves tag for the given digest
   *
   * @param tag - The tag to lookup
   * @returns A Promise that resolves to the retrieved digest
   */
  async getTagDigest(tag: string): Promise<string> {
    if (!this.digestByTagCache.has(tag)) {
      // load it
      await this.getManifestByTag(tag)
    }
    const digest = this.digestByTagCache.get(tag)
    if (digest) {
      return digest
    } else {
      throw new Error(`couln't find digest for tag ${tag}`)
    }
  }

  /**
   * Retrieves a manifest by its tag
   *
   * @param tag - The tag of the manifest to retrieve
   * @returns A Promise that resolves to the retrieved manifest
   */
  async getManifestByTag(tag: string): Promise<any> {
    const cacheDigest = this.digestByTagCache.get(tag)
    if (cacheDigest) {
      // get the digest to look up the manifest
      return this.manifestCache.get(cacheDigest)
    } else {
      const response = await this.axios.get(
        `/v2/${this.config.owner}/${this.config.package}/manifests/${tag}`,
        {
          transformResponse: [
            data => {
              return data
            }
          ]
        }
      )
      const digest = calcDigest(response?.data)
      const obj = JSON.parse(response?.data)
      this.manifestCache.set(digest, obj)
      this.digestByTagCache.set(tag, digest)
      return obj
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
      let contentType = 'application/vnd.oci.image.manifest.v1+json'
      if (multiArch) {
        contentType = 'application/vnd.oci.image.index.v1+json'
      }
      const config = {
        headers: {
          'Content-Type': contentType
        }
      }
      // upgrade token
      let putToken
      const auth = axios.create()
      try {
        await auth.put(
          `https://ghcr.io/v2/${this.config.owner}/${this.config.package}/manifests/${tag}`,
          manifest,
          config
        )
      } catch (error) {
        if (isAxiosError(error) && error.response) {
          if (error.response?.status === 401) {
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
        }
      }

      if (putToken) {
        // now put the updated manifest
        await this.axios.put(
          `/v2/${this.config.owner}/${this.config.package}/manifests/${tag}`,
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
  async getReferrersManifest(digest: string): Promise<any> {
    if (this.referrersCache.has(digest)) {
      return this.referrersCache.get(digest)
    } else {
      const response = await this.axios.get(
        `/v2/${this.config.owner}/${this.config.package}/referrers/${digest}`,
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
  }
}
