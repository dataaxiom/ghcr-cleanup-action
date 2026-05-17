/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest'
import * as core from '@actions/core'
import { run } from '../main'
import { Config, buildConfig } from '../config'
import { OctokitClient } from '../octokit-client'
import { PackageRepo } from '../package-repo'
import { CleanupOrchestrator } from '../cleanup-orchestrator'
import { createTokenAuth } from '@octokit/auth-token'
import { CleanupTaskStatistics } from '../utils'

vi.mock('@actions/core', async () => {
  // Provide a real chainable summary object - the production code calls
  // summary.addHeading(...).addRaw(...)... and we want to record those calls
  // without crashing the chain.
  const mkSummary = (): any => {
    const s: any = {
      addHeading: vi.fn(() => s),
      addRaw: vi.fn(() => s),
      addTable: vi.fn(() => s),
      addDetails: vi.fn(() => s),
      addBreak: vi.fn(() => s),
      write: vi.fn().mockResolvedValue(undefined)
    }
    return s
  }
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setFailed: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    getInput: vi.fn(),
    getBooleanInput: vi.fn(),
    summary: mkSummary()
  }
})

vi.mock('../config')
vi.mock('../octokit-client')
vi.mock('../package-repo')
vi.mock('../cleanup-orchestrator')
vi.mock('@octokit/auth-token')
vi.mock('../utils')

const defaultConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    owner: 'test-owner',
    repository: 'test-repo',
    package: 'pkg-a',
    packageQueryLimit: 100,
    expandPackages: false,
    useRegex: false,
    token: 'gh-token',
    dryRun: false,
    repoType: 'Organization',
    isPrivateRepo: false,
    defaultPackageUsed: false,
    logLevel: 1,
    ...overrides
  }) as Config

describe('main.run()', () => {
  let mockBuildConfig: ReturnType<typeof vi.mocked<typeof buildConfig>>
  let mockOctokitClient: Mocked<OctokitClient>
  let mockPackageRepo: Mocked<PackageRepo>
  let mockOrchestrator: Mocked<CleanupOrchestrator>
  let mockStats: Mocked<CleanupTaskStatistics>
  let globalStats: Mocked<CleanupTaskStatistics>
  let mockAuth: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    mockBuildConfig = vi.mocked(buildConfig)
    mockBuildConfig.mockResolvedValue(defaultConfig())

    mockOctokitClient = { getClient: vi.fn() }
    vi.mocked(OctokitClient).mockImplementation(function () {
      return mockOctokitClient
    } as any)

    mockPackageRepo = {
      getPackageList: vi.fn().mockResolvedValue(['pkg-a', 'pkg-b', 'pkg-c'])
    }
    vi.mocked(PackageRepo).mockImplementation(function () {
      return mockPackageRepo
    } as any)

    // Per-package stats returned from orchestrator.run()
    mockStats = {
      name: 'pkg-a',
      numberImagesDeleted: 5,
      numberMultiImagesDeleted: 2,
      print: vi.fn(),
      add: vi.fn().mockReturnThis()
    }

    mockOrchestrator = {
      init: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(mockStats)
    }
    vi.mocked(CleanupOrchestrator).mockImplementation(function () {
      return mockOrchestrator
    } as any)

    // Global accumulator stats - tracks via add()
    globalStats = {
      name: 'combined-action',
      numberImagesDeleted: 0,
      numberMultiImagesDeleted: 0,
      print: vi.fn(),
      add: vi.fn().mockReturnThis()
    }
    vi.mocked(CleanupTaskStatistics).mockImplementation(function () {
      return globalStats
    } as any)

    // Auth: by default behave as a valid PAT (oauth token type)
    mockAuth = vi.fn().mockResolvedValue({ tokenType: 'oauth', token: 'pat' })
    vi.mocked(createTokenAuth).mockReturnValue(mockAuth as any)
  })

  describe('error wrapping', () => {
    it('reports thrown Errors via core.setFailed and swallows them', async () => {
      mockBuildConfig.mockRejectedValueOnce(new Error('config blew up'))

      await expect(run()).resolves.toBeUndefined()
      expect(core.setFailed).toHaveBeenCalledWith('config blew up')
    })

    it('does not call setFailed on success', async () => {
      await run()
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    it('does not call setFailed for non-Error throws', async () => {
      mockBuildConfig.mockRejectedValueOnce('a string, not an Error')
      await run()
      expect(core.setFailed).not.toHaveBeenCalled()
    })
  })

  describe('package selection', () => {
    it('splits comma-separated package list when expandPackages=false', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({ expandPackages: false, package: 'a,b,c' })
      )

      await run()

      expect(mockPackageRepo.getPackageList).not.toHaveBeenCalled()
      // Three orchestrators built, one per package
      expect(vi.mocked(CleanupOrchestrator)).toHaveBeenCalledTimes(3)
      expect(vi.mocked(CleanupOrchestrator).mock.calls.map(c => c[1])).toEqual([
        'a',
        'b',
        'c'
      ])
    })

    // Regression: issue #103 - YAML folding (`>-`) preserves whitespace
    // between comma-separated package names. Make sure we trim it off and
    // drop any empty entries from stray commas.
    it('trims whitespace and skips empty entries when splitting (issue #103)', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({
          expandPackages: false,
          package: ' a , b ,, c, '
        })
      )

      await run()

      expect(vi.mocked(CleanupOrchestrator).mock.calls.map(c => c[1])).toEqual([
        'a',
        'b',
        'c'
      ])
    })

    it('trims whitespace in wildcard patterns when expandPackages=true', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({
          expandPackages: true,
          useRegex: false,
          package: 'pkg-*, other-*'
        })
      )
      mockPackageRepo.getPackageList.mockResolvedValue([
        'pkg-a',
        'other-b',
        'unrelated'
      ])

      await run()

      // Both wildcard patterns should match after trim - if the leading
      // space was kept on `other-*`, wcmatch would never match `other-b`.
      expect(vi.mocked(CleanupOrchestrator).mock.calls.map(c => c[1])).toEqual([
        'pkg-a',
        'other-b'
      ])
    })

    it('uses wildcard match when expandPackages=true and useRegex=false', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({
          expandPackages: true,
          useRegex: false,
          package: 'pkg-*'
        })
      )
      mockPackageRepo.getPackageList.mockResolvedValue([
        'pkg-a',
        'pkg-b',
        'other-c'
      ])

      await run()

      expect(mockPackageRepo.getPackageList).toHaveBeenCalled()
      expect(vi.mocked(CleanupOrchestrator).mock.calls.map(c => c[1])).toEqual([
        'pkg-a',
        'pkg-b'
      ])
    })

    it('uses regex when expandPackages=true and useRegex=true', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({
          expandPackages: true,
          useRegex: true,
          package: '^pkg-[ab]$'
        })
      )
      mockPackageRepo.getPackageList.mockResolvedValue([
        'pkg-a',
        'pkg-b',
        'pkg-cc',
        'other'
      ])

      await run()

      expect(vi.mocked(CleanupOrchestrator).mock.calls.map(c => c[1])).toEqual([
        'pkg-a',
        'pkg-b'
      ])
    })

    it('fails when expandPackages=true but token is not a PAT', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ expandPackages: true }))
      mockAuth.mockResolvedValueOnce({
        tokenType: 'installation',
        token: 'ghs_x'
      })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Personal Access Token')
      )
      expect(mockPackageRepo.getPackageList).not.toHaveBeenCalled()
      expect(vi.mocked(CleanupOrchestrator)).not.toHaveBeenCalled()
    })

    // Fine-grained PATs return tokenType='oauth' so they pass the first gate.
    // ghcr.io doesn't currently support them, so reject up-front to give a
    // clear error instead of letting the user hit an opaque 403 later.
    it('fails when expandPackages=true and token is a fine-grained PAT', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ expandPackages: true }))
      mockAuth.mockResolvedValueOnce({
        tokenType: 'oauth',
        token: 'github_pat_AAAAAAAAAAAAAAAAAAAAAA_xxxxx'
      })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('classic Personal Access Token')
      )
      expect(mockPackageRepo.getPackageList).not.toHaveBeenCalled()
      expect(vi.mocked(CleanupOrchestrator)).not.toHaveBeenCalled()
    })

    it('allows classic PATs (ghp_*) when expandPackages=true', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ expandPackages: true }))
      mockAuth.mockResolvedValueOnce({
        tokenType: 'oauth',
        token: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
      })
      mockPackageRepo.getPackageList.mockResolvedValue(['pkg-a'])

      await run()

      expect(core.setFailed).not.toHaveBeenCalled()
      expect(mockPackageRepo.getPackageList).toHaveBeenCalled()
    })

    it('fails when zero packages match the filter', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({
          expandPackages: true,
          useRegex: false,
          package: 'nothing-*'
        })
      )
      mockPackageRepo.getPackageList.mockResolvedValue(['pkg-a', 'pkg-b'])

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('No packages selected')
      )
      expect(vi.mocked(CleanupOrchestrator)).not.toHaveBeenCalled()
    })

    it('logs a "Selected Packages" group only for multi-package runs', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'a,b' }))
      await run()
      expect(core.startGroup).toHaveBeenCalledWith('Selected Packages')
      expect(core.info).toHaveBeenCalledWith('a')
      expect(core.info).toHaveBeenCalledWith('b')
    })

    it('omits the "Selected Packages" group for single-package runs', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'only-one' }))
      await run()
      expect(core.startGroup).not.toHaveBeenCalledWith('Selected Packages')
    })
  })

  describe('orchestration loop', () => {
    it('runs init → reload → run for each target package', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'p1,p2' }))

      await run()

      expect(mockOrchestrator.init).toHaveBeenCalledTimes(2)
      expect(mockOrchestrator.reload).toHaveBeenCalledTimes(2)
      expect(mockOrchestrator.run).toHaveBeenCalledTimes(2)
    })

    it('accumulates per-package stats into a global stats object', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'a,b,c' }))

      await run()

      // globalStats.add should be called once per package
      expect(globalStats.add).toHaveBeenCalledTimes(3)
    })

    it('prints global stats only when more than one package was processed', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'a,b' }))
      await run()
      expect(globalStats.print).toHaveBeenCalled()
    })

    it('does not print global stats for a single package run', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'only-one' }))
      await run()
      expect(globalStats.print).not.toHaveBeenCalled()
    })
  })

  describe('writeJobSummary', () => {
    it('renders the summary even for a single package', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'only-one' }))
      await run()
      expect(core.summary.write).toHaveBeenCalled()
      expect(core.summary.addHeading).toHaveBeenCalledWith(
        expect.stringContaining('GHCR Cleanup Summary')
      )
    })

    it('emits a Dry run notice when dryRun=true', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ dryRun: true }))
      await run()
      expect(core.summary.addRaw).toHaveBeenCalledWith(
        expect.stringContaining('Dry run enabled'),
        true
      )
    })

    it('omits the Dry run notice when dryRun=false', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ dryRun: false }))
      await run()
      const addRawCalls = vi
        .mocked(core.summary.addRaw)
        .mock.calls.map(c => c[0])
      const anyMentionsDryRun = addRawCalls.some(
        (s: unknown) => typeof s === 'string' && s.includes('Dry run enabled')
      )
      expect(anyMentionsDryRun).toBe(false)
    })

    it('includes set config options in the config details block', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({
          deleteTags: 'v1.*',
          excludeTags: 'keep-this',
          olderThanReadable: '7 days',
          keepNtagged: 3,
          keepNuntagged: 2,
          deleteUntagged: true,
          deleteGhostImages: true,
          deletePartialImages: true,
          deleteOrphanedImages: true,
          validate: true,
          useRegex: false
        })
      )
      await run()

      const detailsCall = vi
        .mocked(core.summary.addDetails)
        .mock.calls.find(c => c[0] === 'Configuration')
      expect(detailsCall).toBeDefined()
      const html = detailsCall![1]
      expect(html).toContain('delete-tags')
      expect(html).toContain('v1.*')
      expect(html).toContain('exclude-tags')
      expect(html).toContain('keep-this')
      expect(html).toContain('older-than')
      expect(html).toContain('7 days')
      expect(html).toContain('keep-n-tagged')
      expect(html).toContain('keep-n-untagged')
      expect(html).toContain('delete-untagged')
      expect(html).toContain('delete-ghost-images')
      expect(html).toContain('delete-partial-images')
      expect(html).toContain('delete-orphaned-images')
      expect(html).toContain('validate')
    })

    it('omits undefined config options from the config block', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig())
      await run()

      const detailsCall = vi
        .mocked(core.summary.addDetails)
        .mock.calls.find(c => c[0] === 'Configuration')
      const html = detailsCall![1]
      expect(html).not.toContain('delete-tags')
      expect(html).not.toContain('older-than')
      expect(html).not.toContain('keep-n-tagged')
      // Always-set options should still be there
      expect(html).toContain('owner')
      expect(html).toContain('repository')
      expect(html).toContain('log-level')
    })

    it('builds the Overview table with derived values', async () => {
      mockBuildConfig.mockResolvedValue(
        defaultConfig({ dryRun: true, package: 'a,b' })
      )
      // Make global stats reflect totals so we can assert them
      ;(globalStats as any).numberImagesDeleted = 11
      ;(globalStats as any).numberMultiImagesDeleted = 4
      await run()

      const tableCalls = vi.mocked(core.summary.addTable).mock.calls
      // Two tables total: Overview + Results
      expect(tableCalls.length).toBeGreaterThanOrEqual(2)
      const overview = tableCalls[0][0] as unknown[][]
      const flat = JSON.stringify(overview)
      expect(flat).toContain('Packages processed')
      expect(flat).toContain('Total images deleted')
      expect(flat).toContain('Multi-arch images deleted')
      expect(flat).toContain('Dry run')
      // The "2" packages count appears, and so do the totals 11 and 4
      expect(flat).toContain('"2"')
      expect(flat).toContain('"11"')
      expect(flat).toContain('"4"')
    })

    it('emits one Results row per package plus a Totals row', async () => {
      mockBuildConfig.mockResolvedValue(defaultConfig({ package: 'p1,p2,p3' }))
      await run()

      const tableCalls = vi.mocked(core.summary.addTable).mock.calls
      // Results table is the second addTable call
      const results = tableCalls[1][0] as unknown[][]
      // header row + 3 packages + total row = 5 rows
      expect(results.length).toBe(5)
    })
  })
})
