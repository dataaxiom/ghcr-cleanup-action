/**
 * End-to-end untag flow through the real orchestrator, PackageRepo and
 * deletion pipeline, against a stateful fake of the Packages API and the
 * registry. Pins that a dry run previews exactly what a live run deletes
 * when an untag leaves a multi-tag image with only matched tags, and that
 * the second pass reuses the untag's own listing unless it is stale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { CleanupOrchestrator } from '../cleanup-orchestrator'
import { PackageRepo } from '../package-repo'
import { Config } from '../config'
import type { OctokitClient } from '../octokit-client'

vi.mock('@actions/core')

interface Version {
  id: number
  name: string
  tags: string[]
  updated_at: string
  manifest: Record<string, unknown>
}

// Shared fake world: the package versions the API lists and the registry
// serves. Hoisted so the registry mock factory can reach it.
const world = vi.hoisted(() => ({
  versions: [] as Version[],
  nextId: 1000,
  // Number of package listings served.
  listings: 0,
  // Each moved tag -> the version it was moved off, for stale listings.
  movedOff: new Map<string, string>(),
  // Serve the next N listings stale: moved tags still shown on their
  // source image too (as an eventually consistent API can).
  staleTagListings: 0,
  // Leave these versions out of the next listing only.
  hideOnce: [] as string[]
}))

vi.mock('../registry', () => ({
  Registry: class {
    config: Config
    constructor(config: Config) {
      this.config = config
    }
    async login(): Promise<void> {}
    async getManifestByDigest(digest: string): Promise<unknown> {
      return world.versions.find(v => v.name === digest)?.manifest
    }
    async getRawManifestByDigest(digest: string): Promise<unknown> {
      return structuredClone(await this.getManifestByDigest(digest))
    }
    async getManifestByTag(): Promise<undefined> {
      return undefined
    }
    // Like the real registry: the PUT moves the tag to a new version
    // whose digest is the sha256 of the exact bytes sent.
    async putManifest(tag: string, manifest: unknown): Promise<string> {
      const body = JSON.stringify(manifest)
      const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
      if (this.config.dryRun) return digest
      for (const v of world.versions) {
        if (v.tags.includes(tag)) world.movedOff.set(tag, v.name)
        v.tags = v.tags.filter(t => t !== tag)
      }
      world.versions.push({
        id: world.nextId++,
        name: digest,
        tags: [tag],
        updated_at: new Date().toISOString(),
        manifest: manifest as Record<string, unknown>
      })
      return digest
    }
  }
}))

const octokitClient = {
  getClient: () => ({
    rest: {
      packages: {
        getAllPackageVersionsForPackageOwnedByOrg: async () => {
          world.listings++
          const stale = world.staleTagListings > 0
          if (stale) world.staleTagListings--
          const hidden = world.hideOnce
          world.hideOnce = []
          return {
            data: world.versions
              .filter(v => !hidden.includes(v.name))
              .map(v => {
                const tags = [...v.tags]
                if (stale) {
                  for (const [tag, source] of world.movedOff) {
                    if (source === v.name) tags.push(tag)
                  }
                }
                return {
                  id: v.id,
                  name: v.name,
                  updated_at: v.updated_at,
                  metadata: { container: { tags } }
                }
              }),
            headers: {}
          }
        },
        deletePackageVersionForOrg: async ({
          package_version_id
        }: {
          package_version_id: number
        }) => {
          world.versions = world.versions.filter(
            v => v.id !== package_version_id
          )
        }
      }
    }
  })
} as unknown as OctokitClient

const image = (id: number, name: string, tags: string[]): Version => ({
  id,
  name,
  tags,
  updated_at: '2026-01-01T00:00:00Z',
  manifest: {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: `sha256:config${id}` },
    layers: [{ digest: `sha256:layer${id}` }]
  }
})

// Run one cleanup and return the digests the pipeline deleted (or, in a
// dry run, logged as deleting). `before` runs after the first listing,
// to make the untag's own listing stale.
async function cleanup(
  overrides: Partial<Config>,
  before?: () => void
): Promise<string[]> {
  world.versions = [
    image(1, 'sha256:multi', ['a', 'b']),
    image(2, 'sha256:other', ['c'])
  ]
  world.listings = 0
  world.movedOff.clear()
  world.staleTagListings = 0
  world.hideOnce = []
  const config = Object.assign(new Config(), {
    owner: 'o',
    package: 'p',
    ...overrides
  })
  const spy = vi.spyOn(PackageRepo.prototype, 'deletePackageVersion')
  const orchestrator = new CleanupOrchestrator(config, 'p', octokitClient)
  await orchestrator.init()
  await orchestrator.reload()
  before?.()
  await orchestrator.run()
  const digests = spy.mock.calls.map(call => call[2])
  spy.mockRestore()
  return digests
}

// Deletions with each run's placeholder (unique per run) normalised.
const shape = (ds: string[]): string[] =>
  ds
    .map(d =>
      d === 'sha256:multi' || d === 'sha256:other' ? d : 'placeholder'
    )
    .sort()

describe('untag flow (real pipeline)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a dry run previews the image a live run deletes after untagging all but one matched tag', async () => {
    // delete-tags matches both tags of sha256:multi. A live run untags one
    // (always leaving one tag), then the post-untag reload shows the image
    // with only the other matched tag, so the second pass deletes it.
    const live = await cleanup({ deleteTags: 'a,b' })
    expect(live).toContain('sha256:multi')
    expect(world.versions.map(v => v.name)).toEqual(['sha256:other'])

    // The dry run must preview that same deletion (it used to be omitted
    // because the reload still listed both tags).
    const dry = await cleanup({ deleteTags: 'a,b', dryRun: true })
    expect(dry).toContain('sha256:multi')
    expect(dry).not.toContain('sha256:other')
    // And it changed nothing.
    expect(world.versions.map(v => v.name)).toEqual([
      'sha256:multi',
      'sha256:other'
    ])

    // Apart from the placeholder (live only), both runs delete the same.
    const real = (ds: string[]): string[] =>
      ds.filter(d => world.versions.some(v => v.name === d)).sort()
    expect(real(dry)).toEqual(real(live))
  })

  it('reuses the untag listing instead of listing the package again', async () => {
    // Live: the initial load and the untag's placeholder poll; the old
    // third listing (a full reload) is gone.
    await cleanup({ deleteTags: 'a,b' })
    expect(world.listings).toBe(2)
    // Dry: only the initial load; the simulated untag needs no listing.
    await cleanup({ deleteTags: 'a,b', dryRun: true })
    expect(world.listings).toBe(1)
  })

  it('reloads when the untag listing still shows a moved tag on its source', async () => {
    const fresh = await cleanup({ deleteTags: 'a,b' })
    const stale = await cleanup({ deleteTags: 'a,b' }, () => {
      world.staleTagListings = 1
    })
    // The stale placeholder poll is rejected and a full reload follows.
    expect(world.listings).toBe(3)
    expect(shape(stale)).toEqual(shape(fresh))
    expect(world.versions.map(v => v.name)).toEqual(['sha256:other'])
  })

  it('reloads when the untag listing is missing a version', async () => {
    const fresh = await cleanup({ deleteTags: 'a,b' })
    const stale = await cleanup({ deleteTags: 'a,b' }, () => {
      world.hideOnce = ['sha256:other']
    })
    expect(world.listings).toBe(3)
    expect(shape(stale)).toEqual(shape(fresh))
    expect(world.versions.map(v => v.name)).toEqual(['sha256:other'])
  })
})
