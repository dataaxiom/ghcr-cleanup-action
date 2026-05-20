import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction
} from 'vitest'
import * as core from '@actions/core'
import { RequestError } from '@octokit/request-error'
import { PackageRepo, parseLastPageFromLinkHeader } from '../package-repo'
import { Config, LogLevel } from '../config'
import { OctokitClient } from '../octokit-client'

vi.mock('@actions/core')

interface MockPackages {
  getAllPackageVersionsForPackageOwnedByOrg: ReturnType<typeof vi.fn>
  getAllPackageVersionsForPackageOwnedByUser: ReturnType<typeof vi.fn>
  getAllPackageVersionsForPackageOwnedByAuthenticatedUser: ReturnType<
    typeof vi.fn
  >
  deletePackageVersionForOrg: ReturnType<typeof vi.fn>
  deletePackageVersionForUser: ReturnType<typeof vi.fn>
  deletePackageVersionForAuthenticatedUser: ReturnType<typeof vi.fn>
  listPackagesForOrganization: ReturnType<typeof vi.fn>
  listPackagesForUser: ReturnType<typeof vi.fn>
  listPackagesForAuthenticatedUser: ReturnType<typeof vi.fn>
}

interface MockOctokit {
  rest: { packages: MockPackages }
  paginate: { iterator: ReturnType<typeof vi.fn> }
}

const makeMockOctokit = (): MockOctokit => ({
  rest: {
    packages: {
      getAllPackageVersionsForPackageOwnedByOrg: vi.fn(),
      getAllPackageVersionsForPackageOwnedByUser: vi.fn(),
      getAllPackageVersionsForPackageOwnedByAuthenticatedUser: vi.fn(),
      deletePackageVersionForOrg: vi.fn().mockResolvedValue(undefined),
      deletePackageVersionForUser: vi.fn().mockResolvedValue(undefined),
      deletePackageVersionForAuthenticatedUser: vi
        .fn()
        .mockResolvedValue(undefined),
      listPackagesForOrganization: vi.fn(),
      listPackagesForUser: vi.fn(),
      listPackagesForAuthenticatedUser: vi.fn()
    }
  },
  paginate: { iterator: vi.fn() }
})

/**
 * Wraps an array of "pages" (each being a paginate response of shape {data: T[]})
 * as an async iterable that mirrors what octokit.paginate.iterator returns.
 */
const asAsyncIterable = <T>(
  pages: Array<{ data: T[] }>
): AsyncIterable<{ data: T[] }> => ({
  async *[Symbol.asyncIterator]() {
    for (const page of pages) {
      yield page
    }
  }
})

/**
 * Wire up a mocked getFunc to behave like the GitHub paginated API. Page
 * 1's response includes a Link header advertising the last page; the
 * production code reads that to fan out the remaining pages in parallel.
 */
const mockPaginatedPages = <T>(
  getFunc: ReturnType<typeof vi.fn>,
  pages: Array<{ data: T[] }>
): void => {
  const lastPage = pages.length
  getFunc.mockImplementation(async ({ page }: { page?: number } = {}) => {
    const idx = (page ?? 1) - 1
    const data = pages[idx]?.data ?? []
    const headers: Record<string, string> = {}
    if (lastPage > 1 && (page ?? 1) === 1) {
      headers.link = `<https://api.github.com/test?page=${lastPage}>; rel="last"`
    }
    return { data, headers }
  })
}

const buildConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    owner: 'test-owner',
    repository: 'test-repo',
    repoType: 'Organization',
    isPrivateRepo: false,
    dryRun: false,
    defaultPackageUsed: false,
    logLevel: LogLevel.INFO,
    ...overrides
  }) as Config

const buildPackageVersion = (
  id: number | string,
  digest: string,
  tags: string[] = []
): any => ({
  id,
  name: digest,
  metadata: { container: { tags } }
})

describe('PackageRepo', () => {
  let mockOctokit: MockOctokit
  let octokitClient: OctokitClient
  let mockGetClient: MockedFunction<OctokitClient['getClient']>

  beforeEach(() => {
    vi.clearAllMocks()
    mockOctokit = makeMockOctokit()
    mockGetClient = vi.fn().mockReturnValue(mockOctokit) as MockedFunction<
      OctokitClient['getClient']
    >
    octokitClient = { getClient: mockGetClient }
  })

  describe('loadPackages', () => {
    it('builds digest2Id, id2Package, and tag2Digest from paginated response', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      const v1 = buildPackageVersion(101, 'sha256:aaa', ['v1', 'latest'])
      const v2 = buildPackageVersion(102, 'sha256:bbb', ['v2'])
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [{ data: [v1, v2] }]
      )

      await repo.loadPackages('pkg', false)

      expect(repo.digest2Id.get('sha256:aaa')).toBe(101)
      expect(repo.digest2Id.get('sha256:bbb')).toBe(102)
      expect(repo.id2Package.get(101)).toBe(v1)
      expect(repo.id2Package.get(102)).toBe(v2)
      expect(repo.tag2Digest.get('v1')).toBe('sha256:aaa')
      expect(repo.tag2Digest.get('latest')).toBe('sha256:aaa')
      expect(repo.tag2Digest.get('v2')).toBe('sha256:bbb')
    })

    it('clears existing maps before loading (re-entrant safe)', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      // Pre-populate with stale data
      repo.digest2Id.set('stale', 999)
      repo.id2Package.set(999, { stale: true })
      repo.tag2Digest.set('stale-tag', 'stale')

      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [{ data: [buildPackageVersion(1, 'sha256:new', ['v1'])] }]
      )

      await repo.loadPackages('pkg', false)

      expect(repo.digest2Id.has('stale')).toBe(false)
      expect(repo.id2Package.has(999)).toBe(false)
      expect(repo.tag2Digest.has('stale-tag')).toBe(false)
      expect(repo.digest2Id.size).toBe(1)
    })

    it('uses Org endpoint with org params when repoType=Organization', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        []
      )

      await repo.loadPackages('pkg', false)

      expect(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          package_type: 'container',
          package_name: 'pkg',
          org: 'test-owner',
          state: 'active',
          per_page: 100,
          page: 1
        })
      )
    })

    it('uses public-User endpoint when repoType=User, !isPrivate', async () => {
      const repo = new PackageRepo(
        buildConfig({ repoType: 'User', isPrivateRepo: false }),
        octokitClient
      )
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser,
        []
      )

      await repo.loadPackages('pkg', false)

      expect(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'test-owner',
          package_name: 'pkg',
          page: 1
        })
      )
    })

    it('uses authenticated-User endpoint when repoType=User, isPrivate', async () => {
      const repo = new PackageRepo(
        buildConfig({ repoType: 'User', isPrivateRepo: true }),
        octokitClient
      )
      mockPaginatedPages(
        mockOctokit.rest.packages
          .getAllPackageVersionsForPackageOwnedByAuthenticatedUser,
        []
      )

      await repo.loadPackages('pkg', false)

      expect(
        mockOctokit.rest.packages
          .getAllPackageVersionsForPackageOwnedByAuthenticatedUser
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'test-owner',
          package_name: 'pkg',
          page: 1
        })
      )
    })

    it('logs a group of package data when output=true and INFO level', async () => {
      const repo = new PackageRepo(
        buildConfig({ logLevel: LogLevel.INFO }),
        octokitClient
      )
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [{ data: [buildPackageVersion(1, 'sha256:a', ['v1', 'latest'])] }]
      )

      await repo.loadPackages('pkg', true)

      expect(core.startGroup).toHaveBeenCalledWith(
        expect.stringContaining('[pkg] Loaded package data')
      )
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('sha256:a')
      )
      expect(core.endGroup).toHaveBeenCalled()
    })

    it('logs full payloads when output=true and DEBUG level', async () => {
      const repo = new PackageRepo(
        buildConfig({ logLevel: LogLevel.DEBUG }),
        octokitClient
      )
      const pkg = buildPackageVersion(1, 'sha256:a', ['v1'])
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [{ data: [pkg] }]
      )

      await repo.loadPackages('pkg', true)

      expect(core.startGroup).toHaveBeenCalledWith(
        expect.stringContaining('[pkg] Loaded package payloads')
      )
      // JSON.stringify of the package should appear somewhere
      const allInfoCalls = (
        core.info as MockedFunction<typeof core.info>
      ).mock.calls
        .flat()
        .join('\n')
      expect(allInfoCalls).toContain('"id": 1')
    })

    it('stays silent when output=false even at INFO level', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [{ data: [buildPackageVersion(1, 'sha256:a', ['v1'])] }]
      )

      await repo.loadPackages('pkg', false)

      expect(core.startGroup).not.toHaveBeenCalled()
      expect(core.info).not.toHaveBeenCalled()
    })

    it('warns with defaultPackageUsed message on 404 when default package', async () => {
      const repo = new PackageRepo(
        buildConfig({ defaultPackageUsed: true }),
        octokitClient
      )
      const err = new RequestError('Not Found', 404, {
        request: { method: 'GET', url: 'x', headers: {} },
        response: {
          status: 404,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      // Iterator throws when iterated
      mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg.mockRejectedValueOnce(
        err
      )

      await expect(repo.loadPackages('missing', false)).rejects.toBe(err)
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('using a generated value')
      )
    })

    it('warns with explicit-package message on 404 when not default', async () => {
      const repo = new PackageRepo(
        buildConfig({ defaultPackageUsed: false }),
        octokitClient
      )
      const err = new RequestError('Not Found', 404, {
        request: { method: 'GET', url: 'x', headers: {} },
        response: {
          status: 404,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg.mockRejectedValueOnce(
        err
      )

      await expect(repo.loadPackages('missing', false)).rejects.toBe(err)
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('check the package value is correctly set')
      )
    })

    it('rethrows non-404 RequestErrors without warning', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      const err = new RequestError('Server Error', 500, {
        request: { method: 'GET', url: 'x', headers: {} },
        response: {
          status: 500,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg.mockRejectedValueOnce(
        err
      )

      await expect(repo.loadPackages('pkg', false)).rejects.toBe(err)
      expect(core.warning).not.toHaveBeenCalled()
    })

    it('rethrows non-RequestError errors', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      const err = new Error('network blip')
      mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg.mockRejectedValueOnce(
        err
      )

      await expect(repo.loadPackages('pkg', false)).rejects.toBe(err)
      expect(core.warning).not.toHaveBeenCalled()
    })

    it('fans out remaining pages in parallel and merges all results', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      const v1 = buildPackageVersion(1, 'sha256:a', ['v1'])
      const v2 = buildPackageVersion(2, 'sha256:b', ['v2'])
      const v3 = buildPackageVersion(3, 'sha256:c', ['v3'])
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [{ data: [v1] }, { data: [v2] }, { data: [v3] }]
      )

      await repo.loadPackages('pkg', false)

      // All three pages' contents must be present.
      expect(repo.digest2Id.size).toBe(3)
      expect(repo.tag2Digest.get('v1')).toBe('sha256:a')
      expect(repo.tag2Digest.get('v2')).toBe('sha256:b')
      expect(repo.tag2Digest.get('v3')).toBe('sha256:c')
      // Three direct calls to getFunc, not one + iterator.
      expect(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg
      ).toHaveBeenCalledTimes(3)
    })

    // The lastDeleteResult flag tolerates a single 404 after a real delete.
    // If a PackageRepo is ever reused across packages, a stale `false` left
    // from a prior cycle would cause the next package's first 404 to fail
    // instead of being tolerated. loadPackages() acts as the cycle boundary
    // and should reset the flag.
    it('resets lastDeleteResult on each fresh load', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        []
      )

      // Simulate a tolerated 404 from a previous delete operation
      repo.lastDeleteResult = false

      await repo.loadPackages('pkg', false)

      expect(repo.lastDeleteResult).toBe(true)
    })
  })

  describe('lookup methods', () => {
    let repo: PackageRepo

    beforeEach(async () => {
      repo = new PackageRepo(buildConfig(), octokitClient)
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [
          {
            data: [
              buildPackageVersion(1, 'sha256:a', ['v1', 'latest']),
              buildPackageVersion(2, 'sha256:b', ['v2'])
            ]
          }
        ]
      )
      await repo.loadPackages('pkg', false)
    })

    it('getTags returns Set of all tags', () => {
      const tags = repo.getTags()
      expect(tags).toBeInstanceOf(Set)
      expect(tags).toEqual(new Set(['v1', 'latest', 'v2']))
    })

    it('getDigests returns Set of all digests', () => {
      const digests = repo.getDigests()
      expect(digests).toBeInstanceOf(Set)
      expect(digests).toEqual(new Set(['sha256:a', 'sha256:b']))
    })

    it('getDigestByTag returns the matching digest', () => {
      expect(repo.getDigestByTag('v1')).toBe('sha256:a')
      expect(repo.getDigestByTag('latest')).toBe('sha256:a')
      expect(repo.getDigestByTag('v2')).toBe('sha256:b')
    })

    it('getDigestByTag returns undefined for unknown tag', () => {
      expect(repo.getDigestByTag('does-not-exist')).toBeUndefined()
    })

    it('getIdByDigest returns the matching id', () => {
      expect(repo.getIdByDigest('sha256:a')).toBe(1)
      expect(repo.getIdByDigest('sha256:b')).toBe(2)
    })

    it('getIdByDigest returns undefined for unknown digest', () => {
      expect(repo.getIdByDigest('sha256:nope')).toBeUndefined()
    })

    it('getPackageByDigest returns the package descriptor for known digest', () => {
      const pkg = repo.getPackageByDigest('sha256:a')
      expect(pkg).toBeDefined()
      expect(pkg.id).toBe(1)
      expect(pkg.metadata.container.tags).toEqual(['v1', 'latest'])
    })

    it('getPackageByDigest returns undefined for unknown digest', () => {
      expect(repo.getPackageByDigest('sha256:nope')).toBeUndefined()
    })

    it('getReferrerTagsForDigest indexes sha256-* fallback tags by parent', async () => {
      // Rebuild the repo with a fixture that includes referrer tags.
      const parentDigest = `sha256:${'a'.repeat(64)}`
      const referrerTagSig = `sha256-${'a'.repeat(64)}.sig`
      const referrerTagAtt = `sha256-${'a'.repeat(64)}.att`
      const otherParent = `sha256:${'b'.repeat(64)}`

      repo = new PackageRepo(buildConfig(), octokitClient)
      mockPaginatedPages(
        mockOctokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
        [
          {
            data: [
              buildPackageVersion(10, parentDigest, ['v1']),
              buildPackageVersion(11, 'sha256:ref1', [referrerTagSig]),
              buildPackageVersion(12, 'sha256:ref2', [referrerTagAtt]),
              buildPackageVersion(13, otherParent, ['v2', 'plain-tag'])
            ]
          }
        ]
      )
      await repo.loadPackages('pkg', false)

      expect(repo.getReferrerTagsForDigest(parentDigest).sort()).toEqual(
        [referrerTagSig, referrerTagAtt].sort()
      )
      expect(repo.getReferrerTagsForDigest(otherParent)).toEqual([])
      expect(repo.getReferrerTagsForDigest('sha256:nope')).toEqual([])
    })
  })

  describe('deletePackageVersion', () => {
    let repo: PackageRepo

    beforeEach(() => {
      repo = new PackageRepo(buildConfig(), octokitClient)
    })

    it('logs intent with tags when tags are provided', async () => {
      await repo.deletePackageVersion('pkg', 42, 'sha256:a', ['v1', 'latest'])
      expect(core.info).toHaveBeenCalledWith(
        expect.stringMatching(/deleting package id: 42.*tag: v1,latest/)
      )
    })

    it('logs intent with label when label provided (and no tags)', async () => {
      await repo.deletePackageVersion('pkg', 42, 'sha256:a', [], 'my-label')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringMatching(/deleting package id: 42.*my-label/)
      )
    })

    it('logs intent plainly when neither tags nor label', async () => {
      await repo.deletePackageVersion('pkg', 42, 'sha256:a')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringMatching(/^ deleting package id: 42 digest: sha256:a$/)
      )
    })

    it('skips API call when dryRun=true (still logs)', async () => {
      repo = new PackageRepo(buildConfig({ dryRun: true }), octokitClient)
      await repo.deletePackageVersion('pkg', 42, 'sha256:a')
      expect(core.info).toHaveBeenCalled()
      expect(
        mockOctokit.rest.packages.deletePackageVersionForOrg
      ).not.toHaveBeenCalled()
      expect(
        mockOctokit.rest.packages.deletePackageVersionForUser
      ).not.toHaveBeenCalled()
      expect(
        mockOctokit.rest.packages.deletePackageVersionForAuthenticatedUser
      ).not.toHaveBeenCalled()
    })

    it('uses Org delete endpoint when repoType=Organization', async () => {
      await repo.deletePackageVersion('pkg', 42, 'sha256:a')
      expect(
        mockOctokit.rest.packages.deletePackageVersionForOrg
      ).toHaveBeenCalledWith({
        package_type: 'container',
        package_name: 'pkg',
        org: 'test-owner',
        package_version_id: 42
      })
    })

    it('uses public-User delete endpoint when repoType=User, !isPrivate', async () => {
      repo = new PackageRepo(
        buildConfig({ repoType: 'User', isPrivateRepo: false }),
        octokitClient
      )
      await repo.deletePackageVersion('pkg', 42, 'sha256:a')
      expect(
        mockOctokit.rest.packages.deletePackageVersionForUser
      ).toHaveBeenCalledWith({
        package_type: 'container',
        package_name: 'pkg',
        username: 'test-owner',
        package_version_id: 42
      })
    })

    it('uses authenticated-User delete endpoint when repoType=User, isPrivate', async () => {
      repo = new PackageRepo(
        buildConfig({ repoType: 'User', isPrivateRepo: true }),
        octokitClient
      )
      await repo.deletePackageVersion('pkg', 42, 'sha256:a')
      expect(
        mockOctokit.rest.packages.deletePackageVersionForAuthenticatedUser
      ).toHaveBeenCalledWith({
        package_type: 'container',
        package_name: 'pkg',
        package_version_id: 42
      })
    })

    it('ignores a single 404 after a successful delete', async () => {
      const err = new RequestError('Not Found', 404, {
        request: { method: 'DELETE', url: 'x', headers: {} },
        response: {
          status: 404,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockOctokit.rest.packages.deletePackageVersionForOrg.mockRejectedValueOnce(
        err
      )

      // First call should be swallowed
      await expect(
        repo.deletePackageVersion('pkg', 42, 'sha256:a')
      ).resolves.toBeUndefined()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("wasn't found while trying to delete it")
      )
    })

    it('rethrows on repeated 404 (consecutive failures)', async () => {
      const err = new RequestError('Not Found', 404, {
        request: { method: 'DELETE', url: 'x', headers: {} },
        response: {
          status: 404,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockOctokit.rest.packages.deletePackageVersionForOrg
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)

      // First swallowed
      await repo.deletePackageVersion('pkg', 42, 'sha256:a')
      // Second propagates
      await expect(
        repo.deletePackageVersion('pkg', 43, 'sha256:b')
      ).rejects.toBe(err)
      expect(core.warning).toHaveBeenLastCalledWith(
        expect.stringContaining('Multiple 404 errors')
      )
    })

    it('rethrows non-404 RequestError', async () => {
      const err = new RequestError('Forbidden', 403, {
        request: { method: 'DELETE', url: 'x', headers: {} },
        response: {
          status: 403,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockOctokit.rest.packages.deletePackageVersionForOrg.mockRejectedValueOnce(
        err
      )
      await expect(
        repo.deletePackageVersion('pkg', 42, 'sha256:a')
      ).rejects.toBe(err)
    })

    it('rethrows non-RequestError errors', async () => {
      const err = new Error('network blip')
      mockOctokit.rest.packages.deletePackageVersionForOrg.mockRejectedValueOnce(
        err
      )
      await expect(
        repo.deletePackageVersion('pkg', 42, 'sha256:a')
      ).rejects.toBe(err)
    })
  })

  describe('getPackageList', () => {
    it('lists from Org endpoint when repoType=Organization', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockOctokit.paginate.iterator.mockReturnValue(
        asAsyncIterable([{ data: [{ name: 'pkg-a' }, { name: 'pkg-b' }] }])
      )

      const result = await repo.getPackageList()

      expect(result).toEqual(['pkg-a', 'pkg-b'])
      expect(mockOctokit.paginate.iterator).toHaveBeenCalledWith(
        mockOctokit.rest.packages.listPackagesForOrganization,
        expect.objectContaining({
          package_type: 'container',
          org: 'test-owner',
          per_page: 100
        })
      )
    })

    it('lists from public-User endpoint when repoType=User, !isPrivate', async () => {
      const repo = new PackageRepo(
        buildConfig({ repoType: 'User', isPrivateRepo: false }),
        octokitClient
      )
      mockOctokit.paginate.iterator.mockReturnValue(
        asAsyncIterable([{ data: [{ name: 'pkg-a' }] }])
      )

      await repo.getPackageList()

      expect(mockOctokit.paginate.iterator).toHaveBeenCalledWith(
        mockOctokit.rest.packages.listPackagesForUser,
        expect.objectContaining({
          username: 'test-owner'
        })
      )
    })

    it('lists from authenticated-User endpoint when repoType=User, isPrivate', async () => {
      const repo = new PackageRepo(
        buildConfig({ repoType: 'User', isPrivateRepo: true }),
        octokitClient
      )
      mockOctokit.paginate.iterator.mockReturnValue(
        asAsyncIterable([{ data: [{ name: 'pkg-a' }] }])
      )

      await repo.getPackageList()

      expect(mockOctokit.paginate.iterator).toHaveBeenCalledWith(
        mockOctokit.rest.packages.listPackagesForAuthenticatedUser,
        expect.objectContaining({
          username: 'test-owner'
        })
      )
    })

    it('logs each discovered package under a group', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockOctokit.paginate.iterator.mockReturnValue(
        asAsyncIterable([{ data: [{ name: 'alpha' }, { name: 'beta' }] }])
      )

      await repo.getPackageList()

      expect(core.startGroup).toHaveBeenCalledWith(
        expect.stringContaining('Available packages in repository: test-repo')
      )
      expect(core.info).toHaveBeenCalledWith('alpha')
      expect(core.info).toHaveBeenCalledWith('beta')
      expect(core.endGroup).toHaveBeenCalled()
    })

    it('returns empty array when no packages exist', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockOctokit.paginate.iterator.mockReturnValue(asAsyncIterable([]))

      const result = await repo.getPackageList()

      expect(result).toEqual([])
    })

    it('flattens multiple pages of results', async () => {
      const repo = new PackageRepo(buildConfig(), octokitClient)
      mockOctokit.paginate.iterator.mockReturnValue(
        asAsyncIterable([
          { data: [{ name: 'p1' }, { name: 'p2' }] },
          { data: [{ name: 'p3' }] }
        ])
      )

      const result = await repo.getPackageList()

      expect(result).toEqual(['p1', 'p2', 'p3'])
    })
  })
})

describe('parseLastPageFromLinkHeader', () => {
  it('returns 1 when no header is present', () => {
    expect(parseLastPageFromLinkHeader(undefined)).toBe(1)
    expect(parseLastPageFromLinkHeader('')).toBe(1)
  })

  it('returns 1 when no rel="last" link is in the header', () => {
    // Single-page responses include only rel="next" / rel="prev" or
    // (more commonly) no Link header at all.
    expect(
      parseLastPageFromLinkHeader(
        '<https://api.github.com/r?page=2>; rel="next"'
      )
    ).toBe(1)
  })

  it('extracts the last page number from a real-shaped header', () => {
    const header =
      '<https://api.github.com/r?page=2&per_page=100>; rel="next", ' +
      '<https://api.github.com/r?page=42&per_page=100>; rel="last"'
    expect(parseLastPageFromLinkHeader(header)).toBe(42)
  })

  it('handles page= as the only query param', () => {
    expect(
      parseLastPageFromLinkHeader(
        '<https://api.github.com/r?page=7>; rel="last"'
      )
    ).toBe(7)
  })

  it('falls back to 1 on malformed link headers', () => {
    expect(parseLastPageFromLinkHeader('garbage')).toBe(1)
    expect(
      parseLastPageFromLinkHeader('<https://x?page=abc>; rel="last"')
    ).toBe(1)
  })
})
