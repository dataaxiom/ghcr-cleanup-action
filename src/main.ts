import * as core from '@actions/core'
import { Config, buildConfig } from './config.js'
import { PackageRepo } from './package-repo.js'
import { OctokitClient } from './octokit-client.js'
import wcmatch from 'wildcard-match'
import { CleanupOrchestrator } from './cleanup-orchestrator.js'
import { createTokenAuth } from '@octokit/auth-token'
import { CleanupTaskStatistics } from './utils.js'
import { ManifestCache } from './manifest-cache.js'

// SummaryTableRow lives in @actions/core's summary submodule but the
// package's exports field hides subpath imports — pull the type out of
// the addTable signature so it stays in sync with the runtime API.
type SummaryTableRow = Parameters<typeof core.summary.addTable>[0][number]

/*
 * Main program entrypoint
 */
export async function run(): Promise<void> {
  try {
    const config = await buildConfig()
    const octokitClient = new OctokitClient(
      config.token,
      config.githubApiUrl,
      config.logLevel
    )
    const action = new CleanupAction(config, octokitClient)
    await action.run()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

class CleanupAction {
  // The action configuration
  config: Config
  // The Octokit client for API calls
  octokitClient: OctokitClient

  constructor(config: Config, octokitClient: OctokitClient) {
    this.config = config
    this.octokitClient = octokitClient
  }

  async run(): Promise<void> {
    const startedAt = Date.now()

    let targetPackages: string[] = []
    if (this.config.expandPackages) {
      // first make sure sure we have PAT
      const auth = createTokenAuth(this.config.token)
      const authentication = await auth()
      if (authentication.tokenType !== 'oauth') {
        core.setFailed(
          'A Personal Access Token (PAT) is required when the expand-packages option is set to true'
        )
        return
      }
      // Fine-grained PATs (github_pat_*) do not currently support GitHub
      // Container Registry access (GitHub roadmap item #558 was removed in
      // 2024 without a replacement). They pass the tokenType=='oauth' check
      // above, so reject them up-front with a clear message instead of
      // letting them fail later with an opaque 403 from the API.
      if (authentication.token.startsWith('github_pat_')) {
        core.setFailed(
          'expand-packages requires a classic Personal Access Token. Fine-grained PATs do not currently support GitHub Container Registry access.'
        )
        return
      }

      // get the list of available packages in the repo
      const packageRepo = new PackageRepo(this.config, this.octokitClient)
      const packagesInUse: string[] = await packageRepo.getPackageList()

      if (this.config.useRegex) {
        const regex = new RegExp(this.config.package.trim())
        targetPackages = packagesInUse.filter(name => regex.test(name))
      } else {
        const patterns = this.config.package
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        const isTagMatch = wcmatch(patterns)
        targetPackages = packagesInUse.filter(name => isTagMatch(name))
      }
    } else {
      targetPackages = this.config.package
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    }

    if (targetPackages.length === 0) {
      core.setFailed('No packages selected to cleanup')
      return
    } else if (targetPackages.length > 1) {
      core.startGroup('Selected Packages')
      for (const name of targetPackages) {
        core.info(name)
      }
      core.endGroup()
    }

    let globalStatistics = new CleanupTaskStatistics('combined-action', 0, 0)
    const perPackageStats: CleanupTaskStatistics[] = []
    const cacheStats = { hits: 0, misses: 0 }
    for (const targetPackage of targetPackages) {
      // Manifest cache is keyed per (owner, package, GITHUB_RUN_ID).
      // Restore before reload() so analyzer manifest fetches see the
      // warm cache from prior workflow runs; save once after run() so
      // newly-fetched manifests are persisted for next time.
      const manifestCache = new ManifestCache(this.config.owner, targetPackage)
      await manifestCache.restore()

      const orchestrator = new CleanupOrchestrator(
        this.config,
        targetPackage,
        this.octokitClient,
        manifestCache
      )
      try {
        await orchestrator.init()
        await orchestrator.reload()
        const stats = await orchestrator.run()
        perPackageStats.push(stats)
        globalStatistics = globalStatistics.add(stats)
      } finally {
        await manifestCache.save()
        const s = manifestCache.getStats()
        cacheStats.hits += s.hits
        cacheStats.misses += s.misses
      }
    }

    if (targetPackages.length > 1) {
      globalStatistics.print()
    }

    const durationMs = Date.now() - startedAt
    await this.writeJobSummary(
      targetPackages,
      perPackageStats,
      globalStatistics,
      durationMs,
      cacheStats
    )
  }

  private async writeJobSummary(
    targetPackages: string[],
    perPackageStats: CleanupTaskStatistics[],
    globalStats: CleanupTaskStatistics,
    durationMs: number,
    cacheStats: { hits: number; misses: number }
  ): Promise<void> {
    const summary = core.summary

    // Header
    summary.addHeading('🧹 GHCR Cleanup Summary')

    // Mode/dry-run notice
    if (this.config.dryRun) {
      summary.addRaw(
        '> Dry run enabled: No packages were actually deleted.',
        true
      )
    }

    // Quick stats
    summary.addHeading('Overview', 2)
    const overviewRows: SummaryTableRow[] = [
      [
        { data: 'Metric', header: true },
        { data: 'Value', header: true }
      ],
      ['Packages processed', `${targetPackages.length}`],
      ['Total images deleted', `${globalStats.numberImagesDeleted}`],
      ['Multi-arch images deleted', `${globalStats.numberMultiImagesDeleted}`],
      ['Mode', this.config.dryRun ? 'Dry run' : 'Live'],
      ['Duration', `${Math.round(durationMs / 1000)}s`]
    ]
    // Only surface manifest-cache stats when the cache actually saw
    // traffic this run. A 0/0 row would be misleading noise — implies
    // a cache miss-rate of 0% when really nothing was looked up.
    const cacheTotal = cacheStats.hits + cacheStats.misses
    if (cacheTotal > 0) {
      const rate = Math.round((cacheStats.hits / cacheTotal) * 100)
      overviewRows.push([
        'Manifest cache hit rate',
        `${rate}% (${cacheStats.hits} hits / ${cacheTotal} lookups)`
      ])
    }
    summary.addTable(overviewRows)

    // Configuration overview
    const configPairs: Array<[string, string]> = []
    configPairs.push(['owner', `${this.config.owner}`])
    configPairs.push(['packages', `${targetPackages.join(', ')}`])
    if (this.config.deleteTags !== undefined) {
      configPairs.push(['delete-tags', `${this.config.deleteTags}`])
    }
    if (this.config.excludeTags) {
      configPairs.push(['exclude-tags', `${this.config.excludeTags}`])
    }
    if (this.config.olderThanReadable) {
      configPairs.push(['older-than', `${this.config.olderThanReadable}`])
    }
    if (this.config.keepNtagged !== undefined) {
      configPairs.push(['keep-n-tagged', `${this.config.keepNtagged}`])
    }
    if (this.config.keepNuntagged !== undefined) {
      configPairs.push(['keep-n-untagged', `${this.config.keepNuntagged}`])
    }
    if (this.config.deleteUntagged !== undefined) {
      configPairs.push(['delete-untagged', `${this.config.deleteUntagged}`])
    }
    if (this.config.deleteGhostImages !== undefined) {
      configPairs.push([
        'delete-ghost-images',
        `${this.config.deleteGhostImages}`
      ])
    }
    if (this.config.deletePartialImages !== undefined) {
      configPairs.push([
        'delete-partial-images',
        `${this.config.deletePartialImages}`
      ])
    }
    if (this.config.deleteOrphanedImages !== undefined) {
      configPairs.push([
        'delete-orphaned-images',
        `${this.config.deleteOrphanedImages}`
      ])
    }
    if (this.config.validate !== undefined) {
      configPairs.push(['validate', `${this.config.validate}`])
    }
    if (this.config.useRegex !== undefined) {
      configPairs.push(['use-regex', `${this.config.useRegex}`])
    }
    configPairs.push(['log-level', `${this.config.logLevel}`])

    // Build an HTML table so it renders correctly inside <details>
    const buildHtmlTable = (headers: string[], rows: string[][]): string => {
      const thead = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`
      const tbody = rows
        .map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`)
        .join('')
      return `<table>${thead}${tbody}</table>`
    }
    const configTableHtml = buildHtmlTable(
      ['Key', 'Value'],
      configPairs.map(([k, v]) => [k, v])
    )
    summary.addDetails('Configuration', configTableHtml)

    // Results per package
    summary.addHeading('Results', 2)
    const resultRows: SummaryTableRow[] = [
      [
        { data: 'Package', header: true },
        { data: 'Total Deleted', header: true },
        { data: 'Multi-arch Deleted', header: true }
      ]
    ]
    for (const stats of perPackageStats) {
      resultRows.push([
        stats.name,
        `${stats.numberImagesDeleted}`,
        `${stats.numberMultiImagesDeleted}`
      ])
    }
    // Totals row
    resultRows.push([
      { data: 'Total', header: true },
      `${globalStats.numberImagesDeleted}`,
      `${globalStats.numberMultiImagesDeleted}`
    ])
    summary.addTable(resultRows)

    await summary.write()
  }
}
