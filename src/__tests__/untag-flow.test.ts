/**
 * End-to-end untag flow through the real orchestrator, PackageRepo and
 * deletion pipeline, against a stateful fake of the Packages API and the
 * registry. Pins that a dry run previews exactly what a live run deletes
 * when an untag leaves a multi-tag image with only matched tags.
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
  nextId: 1000
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
      for (const v of world.versions) v.tags = v.tags.filter(t => t !== tag)
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
        getAllPackageVersionsForPackageOwnedByOrg: async () => ({
          data: world.versions.map(v => ({
            id: v.id,
            name: v.name,
            updated_at: v.updated_at,
            metadata: { container: { tags: [...v.tags] } }
          })),
          headers: {}
        }),
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
// dry run, logged as deleting).
async function cleanup(overrides: Partial<Config>): Promise<string[]> {
  world.versions = [
    image(1, 'sha256:multi', ['a', 'b']),
    image(2, 'sha256:other', ['c'])
  ]
  const config = Object.assign(new Config(), {
    owner: 'o',
    package: 'p',
    ...overrides
  })
  const spy = vi.spyOn(PackageRepo.prototype, 'deletePackageVersion')
  const orchestrator = new CleanupOrchestrator(config, 'p', octokitClient)
  await orchestrator.init()
  await orchestrator.reload()
  await orchestrator.run()
  const digests = spy.mock.calls.map(call => call[2])
  spy.mockRestore()
  return digests
}

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
})
