import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import axios, { AxiosError, AxiosInstance, isAxiosError } from 'axios'
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

  // Shared client for token-exchange calls (used by both login and
  // putManifest). Carries the same 429 retry condition as `this.axios`
  // — the token endpoint is rate-limited under bursty fan-out just like
  // the manifest endpoints.
  private authClient: AxiosInstance

  // Memoised push-scope token for putManifest. The first untag PUT pays
  // a 401-challenge round-trip; subsequent PUTs reuse this until expiry.
  // Cleared on login() (which switches targetPackage and therefore
  // invalidates the scope) and on any 401 from a subsequent PUT.
  private pushToken: { value: string; expiresAt: number } | null = null

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
    const retryConfig = {
      retries: 3,
      retryCondition: (error: AxiosError) =>
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        error.response?.status === 429,
      retryDelay: (retryNumber: number, error: AxiosError) =>
        axiosRetry.exponentialDelay(retryNumber, error)
    }
    axiosRetry(this.axios, retryConfig)
    // The token-exchange client gets the same retry posture — token
    // endpoint 429s used to slip through with the old `retries: 3`-only
    // config and surface as bare failures under parallel untag PUTs.
    this.authClient = axios.create()
    axiosRetry(this.authClient, retryConfig)
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
    // Drop any push token cached for the previous package — its scope
    // is repository-bound and cannot be reused after the switch.
    this.pushToken = null
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
            const tokenResponse = await this.fetchRegistryToken(attributes)
            const token = tokenResponse.token
            if (token) {
              this.axios.defaults.headers.common['Authorization'] =
                `Bearer ${token}`
              if (this.config.logLevel === LogLevel.DEBUG) {
                core.info('authentication challenge succeded')
              }
            } else {
              throw new Error(
                `${this.baseUrl} login failed: ${JSON.stringify(tokenResponse)}`
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
   * Exchange a www-authenticate challenge for a bearer token using the
   * shared {@link authClient}. Returns the raw token-service response
   * so callers can read both `token` and `expires_in` if present.
   *
   * Docker token spec: https://distribution.github.io/distribution/spec/auth/token/
   */
  private async fetchRegistryToken(
    attributes: Map<string, string>
  ): Promise<{ token?: string; expires_in?: number }> {
    const response = await this.authClient.get(
      `${attributes.get('realm')}?service=${attributes.get('service')}&scope=${attributes.get('scope')}`,
      {
        auth: {
          username: 'token',
          password: this.config.token
        }
      }
    )
    return response.data
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
    if (this.config.dryRun) {
      return
    }

    const contentType = manifest.mediaType

    // Fast path: a cached push token from a previous PUT this run. Skip
    // the 401-challenge handshake entirely. On expiry we clear the cache
    // and fall through to the challenge path below.
    const cached = this.getCachedPushToken()
    if (cached) {
      try {
        await this.putManifestWithToken(tag, manifest, contentType, cached)
        return
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 401) {
          // Token rejected (likely server-side revocation or rotation
          // before our TTL window elapsed). Drop it and fall through.
          this.pushToken = null
        } else {
          throw error
        }
      }
    }

    // Cold path: PUT without auth, expect a 401 challenge, exchange it
    // for a fresh push token, then PUT again with the token. The
    // challenge body carries the realm/service/scope we need.
    try {
      await this.authClient.put(
        `${this.baseUrl}v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
        manifest,
        { headers: { 'Content-Type': contentType } }
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
        const tokenResponse = await this.fetchRegistryToken(attributes)
        const token = tokenResponse.token
        if (!token) {
          throw new Error(
            'failed to obtain push token from authentication challenge'
          )
        }
        this.cachePushToken(token, tokenResponse.expires_in)
        await this.putManifestWithToken(tag, manifest, contentType, token)
      } else {
        throw error
      }
    }
  }

  /**
   * PUT a manifest body to `<tag>` using the supplied bearer token.
   * Extracted so both the cached-token fast path and the
   * challenge-response cold path share the same call shape.
   */
  private async putManifestWithToken(
    tag: string,
    manifest: Manifest,
    contentType: string | undefined,
    token: string
  ): Promise<void> {
    await this.axios.put(
      `/v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
      manifest,
      {
        headers: {
          'content-type': contentType,
          Authorization: `Bearer ${token}`
        }
      }
    )
  }

  /**
   * Return the memoised push token if it's still valid, otherwise null.
   * A small safety buffer guards against clock skew between us and the
   * token service.
   */
  private getCachedPushToken(): string | null {
    if (!this.pushToken) return null
    if (Date.now() >= this.pushToken.expiresAt) {
      this.pushToken = null
      return null
    }
    return this.pushToken.value
  }

  /**
   * Memoise a freshly-issued push token. The Docker token spec defines
   * `expires_in` (seconds, optional, spec default 60) — we honor that
   * when present and otherwise fall back to a conservative 60s. A 10s
   * skew buffer trims the effective TTL so we re-auth slightly before
   * the server actually rejects.
   */
  private cachePushToken(token: string, expiresInSeconds?: number): void {
    const ttlSeconds =
      expiresInSeconds && expiresInSeconds > 0 ? expiresInSeconds : 60
    const skewBufferMs = 10_000
    this.pushToken = {
      value: token,
      expiresAt: Date.now() + ttlSeconds * 1000 - skewBufferMs
    }
  }
}
