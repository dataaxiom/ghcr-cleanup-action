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
 * suspiciously long or that safe-regex2 flags as ReDoS-prone (nested
 * quantifiers, ambiguous alternation, etc.) before they reach
 * `new RegExp(...)` and run against tag/digest/package strings.
 *
 * Workflow authors are the effective trust boundary, so the primary
 * goal here is preventing self-foot-shooting (a copy-pasted pattern
 * that hangs the cleanup job) rather than defending against an
 * external attacker.
 *
 * Throws an Error with a clear message identifying which input
 * failed; otherwise returns silently.
 */
export function validateUserRegex(pattern: string, source: string): void {
  if (pattern.length > MAX_USER_REGEX_LENGTH) {
    throw new Error(
      `${source}: regex pattern exceeds maximum length of ${MAX_USER_REGEX_LENGTH} characters (got ${pattern.length})`
    )
  }
  if (!safeRegex(pattern)) {
    throw new Error(
      `${source}: regex pattern rejected as ReDoS-prone (nested quantifiers or ambiguous alternation). Simplify the pattern or pre-process the input.`
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

export function parseChallenge(challenge: string): Map<string, string> {
  const attributes = new Map<string, string>()
  if (challenge.startsWith('Bearer ')) {
    challenge = challenge.replace('Bearer ', '')
    const parts = challenge.split(',')
    for (const part of parts) {
      // Split on the first '=' only — values may legitimately contain '='
      // (e.g. base64-encoded scopes from some token services).
      const idx = part.indexOf('=')
      if (idx > 0) {
        const key = part.substring(0, idx)
        let value = part.substring(idx + 1)
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1)
        }
        attributes.set(key, value)
      }
    }
  }
  return attributes
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
    return new CleanupTaskStatistics(
      this.name,
      this.numberMultiImagesDeleted + other.numberMultiImagesDeleted,
      this.numberImagesDeleted + other.numberImagesDeleted
    )
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
 * shared index; ordering of completion is unspecified. Errors propagate.
 *
 * Used to parallelize registry manifest fetches — the registry is on
 * ghcr.io, separate rate budget from api.github.com, and axios-retry
 * already covers transient 429s, so a small fan-out (default ~10) is a big
 * win on cold caches without risking secondary rate-limit hits.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length))
  let next = 0
  const launchOne = async (): Promise<void> => {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      await worker(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: limit }, launchOne))
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
