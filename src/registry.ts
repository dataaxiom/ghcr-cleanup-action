import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import axios, { AxiosInstance, isAxiosError } from 'axios'
import { installRetry, REGISTRY_REQUEST_TIMEOUT_MS } from './http-retry.js'
import * as AxiosLogger from 'axios-logger'
import { createHash } from 'crypto'
import {
  buildTokenUrl,
  digestMatches,
  isValidChallenge,
  parseChallenge,
  parseManifest,
  Manifest
} from './utils.js'
import { setGlobalConfig } from 'axios-logger'
import { PackageRepo } from './package-repo.js'
import { ManifestCache } from './manifest-cache.js'

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

  // Cross-run manifest cache. Optional — null disables persistent caching
  // (e.g. when running outside a GitHub Actions runner).
  private crossRunCache: ManifestCache | null

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
   * @param crossRunCache Optional cross-run manifest cache
   */
  constructor(
    config: Config,
    githubPackageRepo: PackageRepo,
    crossRunCache: ManifestCache | null = null
  ) {
    this.config = config
    this.githubPackageRepo = githubPackageRepo
    this.crossRunCache = crossRunCache
    if (this.config.registryUrl) {
      this.baseUrl = this.config.registryUrl
    } else {
      this.baseUrl = 'https://ghcr.io/'
    }
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: REGISTRY_REQUEST_TIMEOUT_MS
    })
    // Retry 429 rate limits (which surface from ghcr.io under bursty
    // parallel reads: manifest fan-out, untag PUTs), plus transient
    // failures of idempotent requests, honouring Retry-After. See
    // http-retry.ts for the exact rules.
    installRetry(this.axios)
    // The token-exchange client gets the same retry posture: token
    // endpoint 429s would otherwise surface as bare failures under
    // parallel untag PUTs.
    this.authClient = axios.create({ timeout: REGISTRY_REQUEST_TIMEOUT_MS })
    installRetry(this.authClient)
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
          if (!challenge) {
            throw new Error(
              `${this.baseUrl} returned 401 without a www-authenticate challenge; cannot authenticate`,
              { cause: error }
            )
          }
          const attributes = parseChallenge(challenge)
          if (isValidChallenge(attributes)) {
            const tokenResponse = await this.fetchRegistryToken(attributes)
            const token = tokenResponse.token
            if (token) {
              // Mask the exchanged registry token like the input token: it
              // rides in the default Authorization header, so any error dump
              // that includes request config would otherwise print it.
              core.setSecret(token)
              this.axios.defaults.headers.common['Authorization'] =
                `Bearer ${token}`
              if (this.config.logLevel === LogLevel.DEBUG) {
                core.info('authentication challenge succeded')
              }
            } else {
              // Do not stringify tokenResponse into the message — an
              // auth-endpoint body can carry a credential, and this
              // reaches the (possibly public) job log via setFailed.
              throw new Error(
                `${this.baseUrl} login failed: token service returned no token`,
                { cause: error }
              )
            }
          } else {
            throw new Error(`invalid www-authenticate challenge ${challenge}`, {
              cause: error
            })
          }
        } else {
          // Report through the thrown error only: main's catch calls
          // setFailed once, with this message.
          throw new Error(
            `Error logging into registry API with package: ${targetPackage} (HTTP ${error.response.status})`,
            { cause: error }
          )
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
    // Validates the realm before the token is attached (see buildTokenUrl).
    const tokenUrl = buildTokenUrl(
      attributes,
      this.baseUrl,
      process.env.GITHUB_SERVER_URL
    )
    const response = await this.authClient.get(tokenUrl, {
      auth: {
        username: 'token',
        password: this.config.token
      }
    })
    return response.data
  }

  /**
   * Retrieves a manifest by its digest: from this run's in-memory cache,
   * else the cross-run cache, else the registry. Every source holds only
   * manifests verified against their digest, so the result is exactly the
   * manifest the digest names.
   *
   * @param digest - The digest of the manifest to retrieve
   */
  async getManifestByDigest(digest: string): Promise<Manifest> {
    const cached = this.manifestCache.get(digest)
    if (cached) {
      return cached
    }
    const persisted = this.crossRunCache?.get(digest)
    if (persisted) {
      this.manifestCache.set(digest, persisted)
      return persisted
    }
    return await this.fetchAndCacheManifest(digest)
  }

  /**
   * Always hits the registry and returns the full, unmodified manifest body.
   * Used by the untag flow, which clones the manifest and PUTs it back: a
   * fresh, verified copy from the registry, independent of any cache.
   */
  async getRawManifestByDigest(digest: string): Promise<Manifest> {
    return await this.fetchAndCacheManifest(digest)
  }

  /**
   * Fetch a manifest from the registry and verify it before anything uses
   * it: the exact bytes received must hash to the requested digest (the
   * digest comes from the package listing, or from a manifest that was
   * itself verified). A mismatch fails the run instead of acting on
   * content the digest does not name. Verified manifests go into both
   * caches.
   */
  private async fetchAndCacheManifest(digest: string): Promise<Manifest> {
    const response = await this.axios.get(
      `/v2/${this.config.owner}/${this.targetPackage}/manifests/${digest}`,
      {
        // The exact bytes, undecoded: a string response would have a
        // leading byte-order mark stripped, changing what is hashed.
        responseType: 'arraybuffer',
        transformResponse: [data => data]
      }
    )
    const bytes = responseBytes(response?.data)
    if (!digestMatches(digest, bytes)) {
      throw new Error(
        `the registry returned content for ${digest} that does not match that digest; refusing to use it`
      )
    }
    const text = bytes.toString('utf8')
    const obj = parseManifest(text)
    this.manifestCache.set(digest, obj)
    // set() re-checks the text against the digest, so bytes that are not
    // valid UTF-8 (and would not survive as text) are simply not cached.
    this.crossRunCache?.set(digest, text)
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
   * @returns The digest (`sha256:<hex>`) of the exact bytes sent — the
   *   digest of the version the registry creates for this PUT.
   */
  async putManifest(
    tag: string,
    manifest: Manifest,
    multiArch: boolean
  ): Promise<string> {
    // Serialize once and send exactly these bytes, so the returned digest
    // is the one the registry stores (a manifest's digest is the sha256 of
    // its exact bytes). Callers use it to identify the version this PUT
    // created without trusting whatever the tag later resolves to.
    const body = Buffer.from(JSON.stringify(manifest), 'utf8')
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
    if (this.config.dryRun) {
      return digest
    }

    const contentType = manifest.mediaType

    // Fast path: a cached push token from a previous PUT this run. Skip
    // the 401-challenge handshake entirely. On expiry we clear the cache
    // and fall through to the challenge path below.
    const cached = this.getCachedPushToken()
    if (cached) {
      try {
        await this.putManifestWithToken(tag, body, contentType, cached, digest)
        return digest
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
      const response = await this.authClient.put(
        `${this.baseUrl}v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
        body,
        { headers: { 'Content-Type': contentType } }
      )
      // No challenge issued — upload already succeeded
      this.assertStoredDigest(response, digest)
      return digest
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        const challenge = error.response.headers['www-authenticate']
        if (!challenge) {
          throw new Error(
            `${this.baseUrl} returned 401 without a www-authenticate challenge; cannot obtain a push token`,
            { cause: error }
          )
        }
        const attributes = parseChallenge(challenge)
        if (!isValidChallenge(attributes)) {
          throw new Error(`invalid www-authenticate challenge ${challenge}`, {
            cause: error
          })
        }
        const tokenResponse = await this.fetchRegistryToken(attributes)
        const token = tokenResponse.token
        if (!token) {
          throw new Error(
            'failed to obtain push token from authentication challenge',
            { cause: error }
          )
        }
        core.setSecret(token)
        this.cachePushToken(token, tokenResponse.expires_in)
        await this.putManifestWithToken(tag, body, contentType, token, digest)
      } else {
        throw error
      }
    }
    return digest
  }

  /**
   * PUT a manifest body to `<tag>` using the supplied bearer token.
   * Extracted so both the cached-token fast path and the
   * challenge-response cold path share the same call shape.
   */
  private async putManifestWithToken(
    tag: string,
    body: Buffer,
    contentType: string | undefined,
    token: string,
    expectedDigest: string
  ): Promise<void> {
    const response = await this.axios.put(
      `/v2/${this.config.owner}/${this.targetPackage}/manifests/${tag}`,
      body,
      {
        headers: {
          'content-type': contentType,
          Authorization: `Bearer ${token}`
        }
      }
    )
    this.assertStoredDigest(response, expectedDigest)
  }

  /**
   * The registry reports the digest it stored a manifest under in the
   * Docker-Content-Digest response header. Untag identifies the version
   * its PUT created by the digest putManifest computes, so a mismatch
   * (a registry that re-serialized the manifest) must stop the run rather
   * than leave untag looking for a version that will never appear.
   */
  private assertStoredDigest(
    response: { headers?: Record<string, unknown> } | undefined,
    expectedDigest: string
  ): void {
    const reported = response?.headers?.['docker-content-digest']
    if (typeof reported === 'string' && reported !== expectedDigest) {
      throw new Error(
        `${this.baseUrl} stored the manifest as ${reported}, not the expected ${expectedDigest}; stopping, since untag identifies the version it created by that digest`
      )
    }
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

/**
 * The response body as a Buffer. With responseType 'arraybuffer' the Node
 * adapter returns a Buffer; an ArrayBuffer or typed array is wrapped as
 * is, and a string (never sent by the adapter in this mode) is encoded as
 * UTF-8.
 */
function responseBytes(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  throw new Error('the registry returned a manifest with no body')
}
