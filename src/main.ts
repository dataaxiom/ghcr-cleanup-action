import * as core from '@actions/core'
import { Config, buildConfig } from './config.js'
import { PackageRepo } from './package-repo.js'
import wcmatch from 'wildcard-match'
import { CleanupTask } from './cleanup-task.js'
import { createTokenAuth } from '@octokit/auth-token'

/*
 * Main  program run function
 */
export async function run(): Promise<void> {
  try {
    const action = new CleanupAction()
    await action.run()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

class CleanupAction {
  // The action configuration
  config: Config

  constructor() {
    this.config = buildConfig()
  }

  async run(): Promise<void> {
    // post initialize configuration
    await this.config.init()

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
      const packageRepo = new PackageRepo(this.config)
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

    for (const targetPackage of targetPackages) {
      const cleanupTask = new CleanupTask(this.config, targetPackage)
      await cleanupTask.init()
      await cleanupTask.reload()
      await cleanupTask.run()
    }
  }
}
