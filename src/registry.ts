import { Config } from './config'
import axios, { AxiosInstance, isAxiosError } from 'axios'
import { calcDigest, isValidChallenge, parseChallenge } from './utils'

export class Registry {
  config: Config
  axios: AxiosInstance
  // cache of loaded manifests, by digest
  manifestCache = new Map<string, any>()
  // map of tag digests
  digestByTagCache = new Map<string, string>()

  constructor(config: Config) {
    this.config = config
    this.axios = axios.create({
      baseURL: 'https://ghcr.io/'
    })
    this.axios.defaults.headers.common['Accept'] =
      'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json'
  }

  async login(): Promise<void> {
    try {
      // get token
      await this.axios.get(
        `/v2/${this.config.owner}/${this.config.name}/tags/list`
      )
    } catch (error) {
      if (isAxiosError(error) && error.response) {
        if (error.response?.status === 401) {
          const challenge = error.response?.headers['www-authenticate']
          const attributes = parseChallenge(challenge)
          if (isValidChallenge(attributes)) {
            const auth = axios.create()
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

  async getTags(link?: string): Promise<string[]> {
    let tags = []
    let url = `/v2/${this.config.owner}/${this.config.name}/tags/list?n=100`
    if (link) {
      url = link
    }
    const response = await this.axios.get(url)
    if (response.data.tags) {
      tags = response.data.tags
    }
    if (response.headers['link']) {
      // we have more results to read
      const headerLink = response.headers['link']
      const parts = headerLink.split('; ')
      let next = parts[0]
      if (next.startsWith('<') && next.endsWith('>')) {
        next = next.substring(1, next.length - 1)
      }
      tags = tags.concat(await this.getTags(next))
    }
    return tags
  }

  async getManifestByDigest(digest: string): Promise<any> {
    if (this.manifestCache.has(digest)) {
      return this.manifestCache.get(digest)!
    } else {
      const response = await this.axios.get(
        `/v2/${this.config.owner}/${this.config.name}/manifests/${digest}`,
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

  deleteTag(tag: string) {
    this.digestByTagCache.delete(tag)
  }

  async getTagDigest(tag: string): Promise<string> {
    if (!this.digestByTagCache.has(tag)) {
      // load it
      await this.getManifestByTag(tag)
    }
    return this.digestByTagCache.get(tag)!
  }

  async getManifestByTag(tag: string): Promise<any> {
    if (this.digestByTagCache.has(tag)) {
      // get the digest to look up the manifest
      return this.manifestCache.get(this.digestByTagCache.get(tag)!)
    } else {
      const response = await this.axios.get(
        `/v2/${this.config.owner}/${this.config.name}/manifests/${tag}`,
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

  async getAllTagDigests(): Promise<string[]> {
    const images = []
    const tags = await this.getTags()
    for (const tag of tags) {
      const manifest = await this.getManifestByTag(tag)
      const digest = await this.getTagDigest(tag)
      images.push(digest)
      // if manifest image add the images to
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          images.push(imageManifest.digest)
        }
      }
    }
    return images
  }

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
          `https://ghcr.io/v2/${this.config.owner}/${this.config.name}/manifests/${tag}`,
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
          `/v2/${this.config.owner}/${this.config.name}/manifests/${tag}`,
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
}
