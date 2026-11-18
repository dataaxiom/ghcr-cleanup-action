import * as core from '@actions/core'
import safeRegex from 'safe-regex2'

// A sha256 digest is 'sha256:' (7) + 64 hex chars = 71 chars total.
export const SHA256_DIGEST_LENGTH = 'sha256:'.length + 64

// Cap user-supplied regex patterns at this length. Real-world tag /
// package name patterns are tiny; anything longer is almost certainly a
// mistake or an attempt to wedge the action.
export const MAX_USER_REGEX_LENGTH = 1000

/**
 * Validate a user-supplied regex pattern. Reject patterns that are
 * suspiciously long or that safe-regex2 flags as ReDoS-prone before
 * they reach `new RegExp(...)` and run against tag/digest/package
 * strings. safe-regex2 only analyses star height (nested quantifiers
 * like `(a+)+`); it does not catch every dangerous pattern — e.g.
 * ambiguous alternation such as `(a|a)*` passes.
 *
 * Workflow authors are the effective trust boundary, so the primary
 * goal here is preventing self-foot-shooting (a copy-pasted pattern
 * that hangs the cleanup job) rather than defending against an
 * external attacker.
 *
 * Throws an Error with a clear message identifying which input
 * failed; otherwise returns silently.
 */
/**
 * Fail if `pattern` is not a valid regular expression, naming the input
 * and the parser's reason. Run before the safety checks (and even with
 * skip-regex-checks), so a typo is reported as a syntax error rather than
 * surfacing as a raw SyntaxError mid-run, or as "ReDoS-prone" (safe-regex2
 * also rejects anything it cannot parse).
 */
export function assertValidRegex(pattern: string, source: string): void {
  try {
    new RegExp(pattern)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${source}: invalid regular expression: ${reason}`, {
      cause: error
    })
  }
}

export function validateUserRegex(pattern: string, source: string): void {
  if (pattern.length > MAX_USER_REGEX_LENGTH) {
    throw new Error(
      `${source}: regex pattern exceeds maximum length of ${MAX_USER_REGEX_LENGTH} characters (got ${pattern.length})`
    )
  }
  if (!safeRegex(pattern)) {
    throw new Error(
      `${source}: regex pattern rejected as ReDoS-prone (nested quantifiers). Simplify the pattern or pre-process the input.`
    )
  }
}

/**
 * Warn when a regex-mode pattern is unanchored. Regex patterns are
 * applied with `.test()`, which matches anywhere in the value (`1.0`
 * also matches `21.0.5`) — unlike wildcard mode, which always matches
 * the whole string. Warn rather than fail: existing workflows may rely
 * on substring matching deliberately.
 *
 * The check is a heuristic (a pattern ending in an escaped `\$` reads
 * as anchored, `^a|b` anchors only one alternative) — acceptable for
 * an advisory warning.
 */
export function warnIfUnanchoredRegex(pattern: string, source: string): void {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
    core.warning(
      `${source}: regex pattern "${pattern}" is unanchored, so it matches anywhere in the value (e.g. "1.0" also matches "21.0.5"). Use ^...$ to match the whole tag or package name.`
    )
  }
}

/**
 * Recover the parent image digest from a cosign/sigstore referrer tag.
 *
 * Referrer tags follow the convention `sha256-<64 hex>.<suffix>` where the
 * suffix is `.sig`, `.att`, `.sbom`, etc. The parent digest is the 71-char
 * `sha256:<64 hex>` string after replacing the `sha256-` prefix and stripping
 * the suffix.
 *
 * Returns null if the tag doesn't match the expected referrer format.
 */
export function parentDigestFromReferrerTag(tag: string): string | null {
  if (!tag.startsWith('sha256-')) return null
  const digest = `sha256:${tag.slice('sha256-'.length)}`
  if (digest.length < SHA256_DIGEST_LENGTH) return null
  return digest.slice(0, SHA256_DIGEST_LENGTH)
}

/**
 * Parse a `WWW-Authenticate: Bearer ...` challenge into its parameters
 * (RFC 7235 auth-params). Quoted values may contain commas (a scope such
 * as "repository:o/p:pull,push") and backslash escapes; unquoted values
 * end at the next comma. Parameter names are case-insensitive and are
 * returned lower-cased. Anything that is not a Bearer challenge yields an
 * empty map.
 */
export function parseChallenge(
  challenge: string | undefined
): Map<string, string> {
  const attributes = new Map<string, string>()
  const scheme = challenge ? /^Bearer\s+/i.exec(challenge) : null
  if (!challenge || !scheme) {
    return attributes
  }
  const s = challenge.slice(scheme[0].length)
  let i = 0
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++
    if (i >= s.length) break
    const eq = s.indexOf('=', i)
    const comma = s.indexOf(',', i)
    if (eq === -1 || (comma !== -1 && comma < eq)) {
      // A parameter without '=' is malformed: skip it.
      if (comma === -1) break
      i = comma + 1
      continue
    }
    const key = s.slice(i, eq).trim().toLowerCase()
    i = eq + 1
    let value = ''
    if (s[i] === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++
        value += s[i]
        i++
      }
      i++ // the closing quote
    } else {
      const end = s.indexOf(',', i)
      value = (end === -1 ? s.slice(i) : s.slice(i, end)).trim()
      i = end === -1 ? s.length : end
    }
    if (key) {
      attributes.set(key, value)
    }
  }
  return attributes
}

/**
 * Build the token-service URL for a parsed challenge, refusing any realm
 * the token should not be sent to. The token goes to the realm as
 * basic-auth, so a challenge from a hostile registry-url could otherwise
 * name its own server and collect it. The realm must be https (or plain
 * http only on the registry's own http host) and on the registry's host
 * or the GitHub server's host. service and scope are URL-encoded.
 *
 * @param attributes A parsed challenge (see {@link isValidChallenge})
 * @param registryUrl The registry base URL the challenge came from
 * @param serverUrl The GitHub server URL (GITHUB_SERVER_URL), if known
 */
export function buildTokenUrl(
  attributes: Map<string, string>,
  registryUrl: string,
  serverUrl?: string
): string {
  const realm = attributes.get('realm') ?? ''
  let url: URL
  try {
    url = new URL(realm)
  } catch {
    throw new Error(
      `the registry's auth challenge names an invalid token service URL "${realm}"`
    )
  }
  const registry = new URL(registryUrl)
  const hosts = [registry.hostname]
  if (serverUrl) {
    try {
      const server = new URL(serverUrl).hostname
      if (!hosts.includes(server)) hosts.push(server)
    } catch {
      // An unparsable server URL adds no host.
    }
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      registry.protocol === 'http:' &&
      url.host === registry.host)
  if (!secure || !hosts.includes(url.hostname)) {
    throw new Error(
      `refusing to send the token to ${url.origin}: the registry's auth challenge must name an https token service on ${hosts.join(' or ')}`
    )
  }
  url.searchParams.set('service', attributes.get('service') ?? '')
  url.searchParams.set('scope', attributes.get('scope') ?? '')
  return url.toString()
}

export function isValidChallenge(attributes: Map<string, string>): boolean {
  let valid = false
  if (
    attributes.has('realm') &&
    attributes.has('service') &&
    attributes.has('scope')
  ) {
    valid = true
  }
  return valid
}

/**
 * Minimal log sink for the cleanup path. The default {@link consoleLogger}
 * just forwards to `core.info` / `core.warning`, preserving current behaviour
 * everywhere a logger isn't passed. The deleteImage flow swaps in a
 * {@link BufferedLogger} per top-level image so a parent and its entire
 * descendant tree (children, referrers, recursive sub-deletes) emit as a
 * single contiguous block once the tree completes — keeps logs readable
 * under bounded-concurrency child fan-out.
 */
export interface Logger {
  info(message: string): void
  warning(message: string): void
}

export const consoleLogger: Logger = {
  info: (message: string) => core.info(message),
  warning: (message: string) => core.warning(message)
}

/**
 * Captures log entries in memory until {@link flush} is called. Entries
 * keep their level so warnings still surface as warnings (yellow badge in
 * the Actions UI) when flushed, just deferred.
 */
export class BufferedLogger implements Logger {
  private entries: Array<{ level: 'info' | 'warning'; message: string }> = []

  info(message: string): void {
    this.entries.push({ level: 'info', message })
  }

  warning(message: string): void {
    this.entries.push({ level: 'warning', message })
  }

  flush(target: Logger = consoleLogger): void {
    for (const e of this.entries) {
      target[e.level](e.message)
    }
    this.entries = []
  }
}

/**
 * Default cap for {@link logListing} truncation. At INFO level, listings
 * larger than this emit the first N entries plus a "more entries truncated"
 * marker; DEBUG always emits the full listing. 1000 keeps log files under
 * the GitHub UI's render cliff (~4 MB at typical line widths) without
 * losing useful detail on the moderately-active repos that cluster around
 * the lower hundreds.
 */
export const DEFAULT_LISTING_LIMIT = 1000

/**
 * Emit an itemised list under a `core.startGroup` block, with INFO-level
 * truncation above `verboseLimit` to keep large-repo runs from blowing
 * past the Actions UI render cliff. DEBUG bypasses truncation.
 *
 * The group title is suffixed with `(N)` so the size is visible from
 * the collapsed view — useful for sanity-checking without expanding.
 *
 * Designed to replace the "open group, loop-and-emit, close group"
 * pattern across the cleanup pipeline. Callers build an array of
 * pre-formatted lines and hand it over; the helper handles group
 * bracketing, truncation, and the empty-listing fallback.
 *
 * @param title - The group title (count is appended automatically).
 * @param items - The pre-formatted lines to emit.
 * @param options.debug - When true, emit the full listing regardless of
 *   size. Pass `config.logLevel >= LogLevel.DEBUG` from the caller.
 * @param options.verboseLimit - Truncation threshold at INFO. Defaults
 *   to {@link DEFAULT_LISTING_LIMIT}.
 * @param options.emptyMessage - Single line emitted inside the group
 *   when `items` is empty (e.g. "no ghost images found"). Omit to leave
 *   the group body silent on empty.
 * @param options.afterEmit - Hook fired inside the group, after the
 *   listing but before `endGroup`. Lets a caller emit related
 *   diagnostic lines under the same collapsible section.
 */
export function logListing(
  title: string,
  items: readonly string[],
  options: {
    debug?: boolean
    verboseLimit?: number
    emptyMessage?: string
    afterEmit?: () => void
  }
): void {
  const limit = options.verboseLimit ?? DEFAULT_LISTING_LIMIT
  core.startGroup(`${title} (${items.length})`)
  try {
    if (items.length === 0) {
      if (options.emptyMessage) {
        core.info(options.emptyMessage)
      }
    } else if (options.debug || items.length <= limit) {
      for (const item of items) {
        core.info(item)
      }
    } else {
      for (let i = 0; i < limit; i++) {
        core.info(items[i])
      }
      core.info(
        `... ${items.length - limit} more entries truncated (set log-level: debug for the full listing)`
      )
    }
    options.afterEmit?.()
  } finally {
    core.endGroup()
  }
}

export class MapPrinter {
  entries: Map<string, string> = new Map<string, string>()
  maxLength = 1

  add(entry: string, defaultValue: string): void {
    if (entry.length > this.maxLength) {
      this.maxLength = entry.length
    }
    this.entries.set(entry, defaultValue)
  }

  print(): void {
    const column = this.maxLength + 10
    for (const [key, value] of this.entries) {
      const spacer = ''.padEnd(column - key.length, ' ')
      core.info(`${key}${spacer}${value}`)
    }
  }
}

export class CleanupTaskStatistics {
  // action stats
  name: string
  numberMultiImagesDeleted: number
  numberImagesDeleted: number
  // Digests of the package versions deleted (or, in a dry run, that would be).
  deletedDigests: string[] = []

  constructor(
    name: string,
    numberMultiImagesDeleted: number,
    numberImagesDeleted: number
  ) {
    this.name = name
    this.numberMultiImagesDeleted = numberMultiImagesDeleted
    this.numberImagesDeleted = numberImagesDeleted
  }

  add(other: CleanupTaskStatistics): CleanupTaskStatistics {
    const combined = new CleanupTaskStatistics(
      this.name,
      this.numberMultiImagesDeleted + other.numberMultiImagesDeleted,
      this.numberImagesDeleted + other.numberImagesDeleted
    )
    combined.deletedDigests = [...this.deletedDigests, ...other.deletedDigests]
    return combined
  }

  print(): void {
    core.startGroup(`[${this.name}] Cleanup statistics`)
    // print action statistics
    if (this.numberMultiImagesDeleted > 0) {
      core.info(
        `multi architecture images deleted = ${this.numberMultiImagesDeleted}`
      )
    }
    core.info(`total images deleted = ${this.numberImagesDeleted}`)
    core.endGroup()
  }
}

// Minimal projection over the GitHub Packages "package version" response
// shape — only the fields this action actually reads. Octokit's full type
// has many more fields, but committing to those would couple us to a
// specific Octokit version unnecessarily.
export interface GhPackage {
  id: number
  name: string
  updated_at: string
  metadata: {
    container: {
      tags: string[]
    }
  }
}

// Container manifest shapes consumed across registry.ts and the cleanup
// pipeline. Field availability mirrors the OCI image spec but is kept
// permissive (most fields optional) so callers can `if (manifest.x)`
// rather than runtime-validate.

// OCI Content Descriptor — used for both `config` and entries in `layers[]`.
// Naming follows the OCI spec rather than calling it a "Layer" specifically.
export interface ManifestDescriptor {
  mediaType: string
  digest: string
  size: number
}

export interface ManifestPlatform {
  architecture: string
  variant?: string
  os?: string
}

export interface ManifestEntry {
  digest: string
  mediaType?: string
  size?: number
  platform?: ManifestPlatform
  artifactType?: string
}

// OCI 1.1 subject descriptor — present on referrer manifests that point
// back at the digest they describe (sigstore bundles, attestations, etc.)
export interface ManifestSubject {
  mediaType?: string
  digest: string
  size?: number
}

/**
 * Run `worker` over `items` with bounded concurrency. Workers pull from a
 * shared index; ordering of completion is unspecified.
 *
 * Fail-fast semantics: on the first worker error no new items are started
 * (in-flight workers finish their current item), the whole batch is drained
 * before returning, and the first error is rethrown. This matters because
 * callers here delete images and flush a per-tree audit log in a `finally`
 * — letting stray workers keep deleting/logging after the caller has moved
 * on would corrupt that log and hide later failures.
 *
 * Used to parallelize registry manifest fetches — the registry is on
 * ghcr.io, separate rate budget from api.github.com, and the registry
 * client's retry (http-retry.ts) already covers transient 429s, so a small fan-out (default ~10) is a big
 * win on cold caches without risking secondary rate-limit hits.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length))
  let next = 0
  let failed = false
  let firstError: unknown
  const launchOne = async (): Promise<void> => {
    while (!failed) {
      const idx = next++
      if (idx >= items.length) return
      try {
        await worker(items[idx], idx)
      } catch (err) {
        // Record the first error and stop this worker. Peers finish
        // their current in-flight item, then see the flag and return —
        // so no new work starts, but nothing is left detached.
        if (!failed) {
          failed = true
          firstError = err
        }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, launchOne))
  if (failed) {
    throw firstError
  }
}

/** Resolve after `ms` milliseconds. */
export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export interface Manifest {
  mediaType?: string
  schemaVersion?: number
  // Present on referrer manifests (sigstore bundles etc.); image-validator
  // and manifest-analyzer use it to identify the artifact shape.
  artifactType?: string
  manifests?: ManifestEntry[]
  layers?: ManifestDescriptor[]
  config?: ManifestDescriptor
  // OCI 1.1 referrer link — read by manifest-analyzer.loadDigestUsedByMap
  // to build the subjectReferrers reverse index.
  subject?: ManifestSubject
  // OCI 1.0+ free-form annotations. The cleanup pipeline doesn't read
  // these for any logic, but performUntagging adds a unique annotation
  // to each empty-manifest PUT so the resulting digests differ — without
  // that, byte-identical empty manifests collide on the same digest.
  annotations?: Record<string, string>
}
