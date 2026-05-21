import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Manifest, ManifestEntry } from './utils.js'

// Schema version baked into cache keys. Bump when the on-disk record shape
// changes — old entries become unreadable and LRU out on their own.
const CACHE_SCHEMA_VERSION = 'v1'

// Compact per-digest record persisted to disk. Only the fields the cleanup
// pipeline actually reads — full manifest bodies include blob descriptors,
// annotations, etc. that are pure cache bloat for our use case.
export interface DistilledManifest {
  mediaType?: string
  manifestEntries?: ManifestEntry[]
  subjectDigest?: string
  // Captured for the buildx attestation check in manifest-analyzer
  // (layers[0].mediaType === 'application/vnd.in-toto+json'). Only set for
  // image manifests that have a layers array.
  firstLayerMediaType?: string
}

/**
 * Cross-run cache of distilled manifest data, keyed by digest.
 *
 * Manifests are content-addressed (`sha256:<hash>` IS the SHA256 of the
 * manifest body), so cache hits are correct by construction — there is no
 * staleness possible for a given digest. Mutable state (package list,
 * tags, which digests still exist) is *not* cached here; it must come
 * from a fresh API call.
 *
 * Key scheme: `ghcr-manifest-v1-<owner>-<package>-<GITHUB_RUN_ID>`. One
 * key per workflow run, written once at the end via `save()`. Next run's
 * `restore()` finds the most-recent entry via the prefix restoreKey
 * fallback. @actions/cache entries are immutable once written, so we
 * can't update an existing key in-place — using the run id keeps each
 * write unique while the prefix lets every future run find the latest.
 *
 * Multi-invocation workflows (e.g. matrix jobs that all touch the same
 * package): the first invocation's save wins; later jobs restore from
 * it but hit a `-1` from saveCache on their own attempt — those
 * invocations' incremental fetches are not persisted, which is fine
 * because the typical workload invokes the action once per workflow.
 *
 * No-op outside GitHub Actions runners (local dev, unit tests).
 */
export class ManifestCache {
  private map = new Map<string, DistilledManifest>()
  private packageName: string
  private cacheDir: string
  private cachePath: string
  private key: string
  private restoreKeys: string[]
  private enabled: boolean
  // Hit/miss counters for the distilled cache. Only `get()` updates
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
    const safePackage = packageName.replace(/[^a-zA-Z0-9._-]/g, '_')
    this.cacheDir = path.join(
      root,
      'ghcr-cleanup-manifest-cache',
      `${owner}-${safePackage}`
    )
    this.cachePath = path.join(this.cacheDir, 'manifests.ndjson')

    const runId = process.env.GITHUB_RUN_ID || `${Date.now()}`
    const keyPrefix = `ghcr-manifest-${CACHE_SCHEMA_VERSION}-${owner}-${safePackage}-`
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
      if (stats.skipped > 0) {
        core.warning(
          `manifest cache: skipped ${stats.skipped} malformed entries from ${hitKey}`
        )
      }
      // The file was reachable but unsalvageable (e.g. truncated upload,
      // partial write from an earlier crash). Treat it as a cold start —
      // the next save() will overwrite with a clean copy. Entries are
      // content-addressed so the "lost" data costs only a refetch.
      if (stats.loaded === 0 && stats.skipped > 0) {
        this.map.clear()
        core.warning(
          'manifest cache: file appears corrupt, discarding and starting cold'
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
      // measured. Whether we loaded entries, started cold, or recovered
      // from corruption, what's in `map` right now matches what we'd
      // want to save — nothing to upload until something changes.
      this.dirty = false
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
    if (this.map.size === 0) {
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
      // saveCache returns the cacheId on success, or -1 when the
      // reserve step fails (e.g. an earlier job in this same workflow
      // already wrote this key). The library logs its own
      // "Failed to save: ..." line without throwing, so the return
      // value is the only honest signal of success.
      const cacheId = await cache.saveCache([this.cacheDir], this.key)
      if (cacheId === -1) {
        core.info(
          `manifest cache: ${this.key} already saved by an earlier job in this workflow; skipping`
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

  get(digest: string): DistilledManifest | undefined {
    const value = this.map.get(digest)
    if (value) {
      this.hits++
    } else {
      this.misses++
    }
    return value
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses }
  }

  set(digest: string, distilled: DistilledManifest): void {
    this.map.set(digest, distilled)
    this.dirty = true
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
   * Single-line summary of how often the distilled cache short-
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

  private async loadFromDisk(): Promise<{ loaded: number; skipped: number }> {
    let raw: string
    try {
      raw = await fs.promises.readFile(this.cachePath, 'utf8')
    } catch {
      // File missing means the cache key existed but the archive was
      // empty or had unexpected contents — treat as a cold start.
      return { loaded: 0, skipped: 0 }
    }
    let loaded = 0
    let skipped = 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as {
          digest: string
        } & DistilledManifest
        const { digest, ...rest } = parsed
        if (typeof digest === 'string' && digest.length > 0) {
          // set the map directly rather than going through `this.set`,
          // which would flip the dirty flag — loading from disk is the
          // baseline, not a change.
          this.map.set(digest, rest)
          loaded++
        } else {
          // Parsed JSON but the digest field is missing/blank. Treat as
          // structurally invalid — equivalent to a JSON.parse failure.
          skipped++
        }
      } catch {
        // Malformed line — drop it. The digest's content is recoverable
        // by refetching, so per-line corruption never blocks a load.
        skipped++
      }
    }
    return { loaded, skipped }
  }

  private async writeToDisk(): Promise<void> {
    const lines: string[] = []
    for (const [digest, distilled] of this.map) {
      lines.push(JSON.stringify({ digest, ...distilled }))
    }
    await fs.promises.writeFile(this.cachePath, `${lines.join('\n')}\n`)
  }
}

/**
 * Extract the subset of a registry manifest we want to persist across runs.
 */
export function distillManifest(manifest: Manifest): DistilledManifest {
  const distilled: DistilledManifest = {}
  if (manifest.mediaType) {
    distilled.mediaType = manifest.mediaType
  }
  if (manifest.manifests && manifest.manifests.length > 0) {
    distilled.manifestEntries = manifest.manifests.map(entry => ({
      digest: entry.digest,
      mediaType: entry.mediaType,
      artifactType: entry.artifactType,
      platform: entry.platform,
      size: entry.size
    }))
  }
  if (manifest.subject?.digest) {
    distilled.subjectDigest = manifest.subject.digest
  }
  if (manifest.layers && manifest.layers.length > 0) {
    distilled.firstLayerMediaType = manifest.layers[0].mediaType
  }
  return distilled
}

/**
 * Rebuild a Manifest-shaped object from a distilled record so existing
 * callers can read it the same way they read a registry response.
 *
 * Only the fields used by the cleanup pipeline (analyzer, deleter
 * cascade, validator) are populated. In particular `layers[0]` carries
 * the original mediaType but its `digest`/`size` are placeholders —
 * never trust them. The untag-PUT path must use
 * Registry.getRawManifestByDigest, which always fetches the full body
 * from the registry.
 */
export function reconstituteManifest(distilled: DistilledManifest): Manifest {
  const manifest: Manifest = {}
  if (distilled.mediaType) {
    manifest.mediaType = distilled.mediaType
  }
  if (distilled.manifestEntries) {
    manifest.manifests = distilled.manifestEntries
  }
  if (distilled.subjectDigest) {
    manifest.subject = { digest: distilled.subjectDigest }
  }
  if (distilled.firstLayerMediaType) {
    manifest.layers = [
      {
        mediaType: distilled.firstLayerMediaType,
        digest: '',
        size: 0
      }
    ]
  }
  return manifest
}
