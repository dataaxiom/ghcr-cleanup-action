import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Manifest, digestMatches, parseManifest } from './utils.js'

// Schema version baked into cache keys. Bump when the on-disk record shape
// changes — old entries become unreadable and LRU out on their own.
// v2: each record holds the manifest's exact text, verified against its
// digest on restore (v1 held an unverifiable distilled summary).
const CACHE_SCHEMA_VERSION = 'v2'

/**
 * Cross-run cache of manifests, keyed by digest.
 *
 * Each entry is the manifest's exact text as the registry served it. A
 * manifest's digest (`sha256:<hex>`) is the hash of those exact bytes, so
 * every entry is checked against its digest on restore and on set().
 * set() refuses text that does not match; on restore, a single entry that
 * does not verify discards the whole restored cache, and every manifest
 * is fetched from the registry instead. Anything that can write to the
 * repository's Actions cache can therefore corrupt it, but cannot make
 * the action act on a manifest the registry would not serve — the
 * delete cascade (children, referrers, orphan checks) only ever sees
 * verified manifests. Mutable state (package list, tags, which digests
 * still exist) is *not* cached here; it comes from a fresh API call.
 *
 * Key scheme: `ghcr-manifest-v2-<owner>-<package>-<GITHUB_RUN_ID>`. One
 * key per workflow run, written once at the end via `save()`. Next run's
 * `restore()` finds the most-recent entry via the prefix restoreKey
 * fallback. @actions/cache entries are immutable once written, so we
 * can't update an existing key in-place — using the run id keeps each
 * write unique while the prefix lets every future run find the latest.
 *
 * Multi-invocation workflows (e.g. matrix jobs that all touch the same
 * package): they share one key, and a key can be written only once, so
 * the first invocation's save wins; later jobs restore from it but get
 * `-1` from saveCache on their own attempt — those invocations'
 * incremental fetches are not persisted, which is fine because the
 * typical workload invokes the action once per workflow. saveCache also
 * returns `-1` when the runner makes the cache read-only for the run
 * (ACTIONS_CACHE_MODE=read, e.g. on some pull request runs).
 *
 * No-op outside GitHub Actions runners (local dev, unit tests).
 */
export class ManifestCache {
  // digest -> the manifest's exact text, verified against the digest
  private map = new Map<string, string>()
  private packageName: string
  private cacheDir: string
  private cachePath: string
  private key: string
  private restoreKeys: string[]
  private enabled: boolean
  // Hit/miss counters for the cross-run cache. Only `get()` updates
  // these, so within-run reuse via Registry.manifestCache (in-memory
  // Map) doesn't skew the cross-run effectiveness signal logged at
  // save() time.
  private hits = 0
  private misses = 0
  // True iff the in-memory map has diverged from the on-disk snapshot
  // we restored (or from "empty" if there was no restore). Save() skips
  // the upload entirely when this is false — re-saving identical content
  // under a fresh run-id would just churn the repo's cache budget
  // without changing what the next run sees via the prefix restoreKey.
  // restore() leaves dirty=false; set()/prune() set it.
  private dirty = false

  constructor(owner: string, packageName: string) {
    // Per-package subdirectory under runner temp. The cache action
    // archives the directory contents, so isolating per-package keeps
    // tarballs small and parallel-safe if we ever run multiple packages
    // concurrently.
    this.packageName = packageName
    const root = process.env.RUNNER_TEMP || os.tmpdir()
    // Sanitize both: they form a path under RUNNER_TEMP and a cache key, so
    // a value like `../x` must not escape the cache root.
    const safePackage = packageName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeOwner = owner.replace(/[^a-zA-Z0-9._-]/g, '_')
    this.cacheDir = path.join(
      root,
      'ghcr-cleanup-manifest-cache',
      `${safeOwner}-${safePackage}`
    )
    this.cachePath = path.join(this.cacheDir, 'manifests.ndjson')

    const runId = process.env.GITHUB_RUN_ID || `${Date.now()}`
    const keyPrefix = `ghcr-manifest-${CACHE_SCHEMA_VERSION}-${safeOwner}-${safePackage}-`
    this.key = `${keyPrefix}${runId}`
    this.restoreKeys = [keyPrefix]

    this.enabled = cache.isFeatureAvailable()
  }

  /**
   * Pull the most-recent matching cache (if any) and load it into the
   * in-memory map. Restore is by prefix, so it picks up the latest
   * entry from any prior workflow run.
   */
  async restore(): Promise<void> {
    if (!this.enabled) {
      core.info('manifest cache: @actions/cache unavailable, running uncached')
      return
    }

    // Wrap in a log group so @actions/cache's own info output (Cache
    // hit for X, tar -xf ..., Cache restored successfully) is captured
    // under a single collapsible section.
    core.startGroup(`[${this.packageName}] Restoring manifest cache`)
    // Set when the restored file is discarded as untrustworthy: the next
    // save() must then replace it, even with an empty cache, so the bad
    // file stops being the newest entry future runs restore.
    let discarded = false
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true })
      const hitKey = await cache.restoreCache(
        [this.cacheDir],
        this.key,
        this.restoreKeys
      )
      if (!hitKey) {
        core.info('manifest cache: no prior cache found, cold start')
        return
      }
      const stats = await this.loadFromDisk()
      // The cache is used only if every record in it verifies. This
      // action writes every record, so one that does not verify, or is
      // not a record at all, means the file was corrupted or tampered
      // with, and nothing else in it can be trusted either: discard the
      // whole file and start cold. That costs only refetches.
      if (stats.skipped + stats.rejected > 0) {
        const bad = stats.skipped + stats.rejected
        const total = stats.loaded + bad
        this.map.clear()
        discarded = true
        core.warning(
          `manifest cache: ${bad} of ${total} entries in ${hitKey} failed verification (${stats.rejected} not matching their digest, ${stats.skipped} malformed); the cache may have been corrupted or tampered with, so the whole cache is discarded and every manifest will be fetched from the registry`
        )
        return
      }
      core.info(
        `manifest cache: restored ${this.map.size} entries from ${hitKey}`
      )
    } catch (error) {
      // Catastrophic failure mid-load can leave the in-memory map
      // half-populated. Wipe it so the rest of the run treats this as a
      // clean cold start rather than acting on partial data.
      this.map.clear()
      const message = error instanceof Error ? error.message : String(error)
      core.warning(`manifest cache: restore failed (${message}); continuing`)
    } finally {
      // restore() established the baseline against which dirty is
      // measured: what's in `map` now matches what we'd want to save, so
      // there is nothing to upload until something changes — except
      // after a discard, when the bad file must be replaced.
      this.dirty = discarded
      core.endGroup()
    }
  }

  /**
   * Persist the in-memory map and upload it as a cache entry under this
   * run's key. Called once per ManifestCache instance from the
   * per-package finally block in main.ts.
   */
  async save(): Promise<void> {
    if (!this.enabled) {
      this.logEffectiveness()
      return
    }
    if (this.map.size === 0 && !this.dirty) {
      this.logEffectiveness()
      return
    }
    if (!this.dirty) {
      // Steady-state no-op run: every digest we needed was already in
      // the restored cache, nothing got pruned. Re-uploading the same
      // bytes under a fresh run-id key would just consume the repo's
      // cache budget without changing the next run's restore — that
      // run will find this same untouched entry via the prefix
      // restoreKey, which is exactly what we want.
      core.info(
        `manifest cache: ${this.map.size} entries unchanged since restore; skipping upload`
      )
      this.logEffectiveness()
      return
    }

    core.startGroup(`[${this.packageName}] Saving manifest cache`)
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true })
      await this.writeToDisk()
      // saveCache returns the cacheId on success, or -1 when it did not
      // save: the runner made the cache read-only for this run, an
      // earlier job in this workflow already wrote this key, or the
      // upload failed. The library logs the actual reason itself without
      // throwing, so the return value is the only honest signal, and
      // this message must not guess which reason it was.
      const cacheId = await cache.saveCache([this.cacheDir], this.key)
      if (cacheId === -1) {
        core.info(
          `manifest cache: not saved as ${this.key} (reason logged above); the next run restores the newest saved cache`
        )
      } else {
        core.info(
          `manifest cache: saved ${this.map.size} entries as ${this.key}`
        )
      }
      this.logEffectiveness()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      core.warning(`manifest cache: save failed (${message}); continuing`)
      this.logEffectiveness()
    } finally {
      core.endGroup()
    }
  }

  /**
   * The cached manifest for `digest`, parsed from its verified text, or
   * undefined on a miss. An entry that does not parse is dropped and
   * counted as a miss, so the caller fetches it from the registry.
   */
  get(digest: string): Manifest | undefined {
    const text = this.map.get(digest)
    if (text !== undefined) {
      try {
        const manifest = parseManifest(text)
        this.hits++
        return manifest
      } catch {
        this.map.delete(digest)
        this.dirty = true
      }
    }
    this.misses++
    return undefined
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses }
  }

  /**
   * Cache a manifest's exact text under its digest. The text is checked
   * against the digest here too, so nothing unverified can enter the
   * cache (see {@link textMatchesDigest}).
   *
   * @returns true if the entry was cached
   */
  set(digest: string, text: string): boolean {
    if (!textMatchesDigest(digest, text)) {
      return false
    }
    this.map.set(digest, text)
    this.dirty = true
    return true
  }

  size(): number {
    return this.map.size
  }

  /**
   * Drop in-memory entries whose digest is not in {@link liveDigests}.
   * Call after `loadPackages` so the saved cache stays bounded to
   * currently-existing package versions — entries for deleted digests
   * would otherwise accumulate forever (content-addressed, so they'll
   * never come back).
   *
   * Returns the number of entries removed.
   */
  prune(liveDigests: Set<string>): number {
    let dropped = 0
    for (const digest of this.map.keys()) {
      if (!liveDigests.has(digest)) {
        this.map.delete(digest)
        dropped++
      }
    }
    if (dropped > 0) {
      core.info(`manifest cache: pruned ${dropped} stale entries`)
      this.dirty = true
    }
    return dropped
  }

  /**
   * Single-line summary of how often the cross-run cache short-
   * circuited a registry fetch this run. Surfaces in the workflow log
   * so users can see the cache is actually doing something.
   */
  private logEffectiveness(): void {
    const total = this.hits + this.misses
    if (total === 0) return
    const rate = Math.round((this.hits / total) * 100)
    if (this.enabled) {
      core.info(
        `manifest cache: ${this.hits}/${total} digests served from cache (${rate}%), ${this.misses} fetched from registry`
      )
    } else {
      core.info(
        `manifest cache: ${total} manifests fetched from registry (cache disabled — running outside GitHub Actions)`
      )
    }
  }

  private async loadFromDisk(): Promise<{
    loaded: number
    skipped: number
    rejected: number
  }> {
    let raw: string
    try {
      raw = await fs.promises.readFile(this.cachePath, 'utf8')
    } catch {
      // File missing means the cache key existed but the archive was
      // empty or had unexpected contents — treat as a cold start.
      return { loaded: 0, skipped: 0, rejected: 0 }
    }
    let loaded = 0
    let skipped = 0
    let rejected = 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        const { digest, manifest } = (parsed ?? {}) as {
          digest?: unknown
          manifest?: unknown
        }
        if (typeof digest !== 'string' || typeof manifest !== 'string') {
          // Parsed JSON but not a record. Treat as structurally invalid —
          // equivalent to a JSON.parse failure.
          skipped++
        } else if (!textMatchesDigest(digest, manifest)) {
          // The text is not the manifest this digest names. Never use it.
          rejected++
        } else {
          // set the map directly rather than going through `this.set`,
          // which would flip the dirty flag — loading from disk is the
          // baseline, not a change.
          this.map.set(digest, manifest)
          loaded++
        }
      } catch {
        // Malformed line — drop it. The digest's content is recoverable
        // by refetching, so per-line corruption never blocks a load.
        skipped++
      }
    }
    return { loaded, skipped, rejected }
  }

  private async writeToDisk(): Promise<void> {
    const lines: string[] = []
    for (const [digest, manifest] of this.map) {
      lines.push(JSON.stringify({ digest, manifest }))
    }
    await fs.promises.writeFile(this.cachePath, `${lines.join('\n')}\n`)
  }
}

/**
 * True when `text` is exactly the manifest `digest` names. The text must
 * be well-formed: UTF-8 encoding turns a lone surrogate into the bytes of
 * U+FFFD, so without this check a different string could encode to the
 * verified bytes. Text from bytes that were not valid UTF-8 fails too,
 * since its encoding is not the bytes the digest covers.
 */
export function textMatchesDigest(digest: string, text: string): boolean {
  const bytes = Buffer.from(text, 'utf8')
  return bytes.toString('utf8') === text && digestMatches(digest, bytes)
}
