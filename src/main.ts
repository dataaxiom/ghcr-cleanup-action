import * as core from '@actions/core'
import { Config, buildConfig } from './config.js'
import { PackageRepo } from './package-repo.js'
import { OctokitClient } from './octokit-client.js'
import wcmatch from 'wildcard-match'
import { CleanupOrchestrator } from './cleanup-orchestrator.js'
import { createTokenAuth } from '@octokit/auth-token'
import { CleanupTaskStatistics } from './utils.js'

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

    let targetPackages = []
    if (this.config.expandPackages) {
      // first make sure sure we have PAT
      const auth = createTokenAuth(this.config.token)
      const authentication = await auth()
      if (authentication.tokenType !== 'oauth') {
        core.setFailed(
          'A Personal Access Token (PAT) is required when the expand-packages option is set to true'
        )
        throw new Error()
      }

      // get the list of available packages in the repo
      const packageRepo = new PackageRepo(this.config, this.octokitClient)
      const packagesInUse: string[] = await packageRepo.getPackageList()

      if (this.config.useRegex) {
        const regex = new RegExp(this.config.package)
        targetPackages = packagesInUse.filter(name => regex.test(name))
      } else {
        const isTagMatch = wcmatch(this.config.package.split(','))
        targetPackages = packagesInUse.filter(name => isTagMatch(name))
      }
    } else {
      targetPackages = this.config.package.split(',')
    }

    if (targetPackages.length === 0) {
      core.setFailed('No packages selected to cleanup')
      throw new Error()
    } else if (targetPackages.length > 1) {
      core.startGroup('Selected Packages')
      for (const name of targetPackages) {
        core.info(name)
      }
      core.endGroup()
    }

    let globalStatistics = new CleanupTaskStatistics('combined-action', 0, 0)
    const perPackageStats: CleanupTaskStatistics[] = []
    for (const targetPackage of targetPackages) {
      const orchestrator = new CleanupOrchestrator(
        this.config,
        targetPackage,
        this.octokitClient
      )
      await orchestrator.init()
      await orchestrator.reload()
      const stats = await orchestrator.run()
      perPackageStats.push(stats)
      globalStatistics = globalStatistics.add(stats)
    }

    if (targetPackages.length > 1) {
      globalStatistics.print()
    }

    const durationMs = Date.now() - startedAt
    await this.writeJobSummary(
      targetPackages,
      perPackageStats,
      globalStatistics,
      durationMs
    )
  }

  private async writeJobSummary(
    targetPackages: string[],
    perPackageStats: CleanupTaskStatistics[],
    globalStats: CleanupTaskStatistics,
    durationMs: number
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
    summary.addTable([
      [
        { data: 'Metric', header: true },
        { data: 'Value', header: true }
      ],
      ['Packages processed', `${targetPackages.length}`],
      ['Total images deleted', `${globalStats.numberImagesDeleted}`],
      ['Multi-arch images deleted', `${globalStats.numberMultiImagesDeleted}`],
      ['Mode', this.config.dryRun ? 'Dry run' : 'Live'],
      ['Duration', `${Math.round(durationMs / 1000)}s`]
    ])

    // Configuration overview
    const configPairs: [string, string][] = []
    configPairs.push(['owner', `${this.config.owner}`])
    configPairs.push(['repository', `${this.config.repository}`])
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
    const resultRows: any[] = [
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
