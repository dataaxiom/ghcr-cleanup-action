import { Config } from './config'
import axios, { AxiosInstance, isAxiosError } from 'axios'
import { calcDigest, isValidChallenge, parseChallenge } from './utils'

export class Registry {
  config: Config
  axios: AxiosInstance

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

  async getRawManifest(reference: string): Promise<string> {
    const response = await this.axios.get(
      `/v2/${this.config.owner}/${this.config.name}/manifests/${reference}`,
      {
        transformResponse: [
          data => {
            return data
          }
        ]
      }
    )
    return response?.data
  }

  async tagExists(reference: string): Promise<boolean> {
    let exists = false
    try {
      await this.axios.get(
        `/v2/${this.config.owner}/${this.config.name}/manifests/${reference}`
      )
      exists = true
    } catch (error) {
      if (isAxiosError(error)) {
        if (error.response?.status !== 404) {
          throw error
        }
      }
    }
    return exists
  }

  async getAllTagDigests(): Promise<string[]> {
    const images = []
    const tags = await this.getTags()
    for (const tag of tags) {
      const manifest = await this.getRawManifest(tag)
      const hexDigest = calcDigest(manifest)
      images.push(hexDigest)
      // if manifest image add the images to
      const data = JSON.parse(manifest)
      if (data.manifests) {
        for (const imageManifest of data.manifests) {
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
