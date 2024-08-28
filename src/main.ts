import * as core from '@actions/core'
import { Config, buildConfig } from './config.js'
import { Registry } from './registry.js'
import { PackageRepo } from './package-repo.js'
import wcmatch from 'wildcard-match'
import { CleanupTask } from './cleanup-task.js'
import { createTokenAuth } from '@octokit/auth-token'

export async function run(): Promise<void> {
  try {
    const action = new CleanupAction()
    await action.init()
    await action.run()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

class CleanupAction {
  // The action configuration
  config: Config

  // used to interact with the container registry api
  registry: Registry

  // used to interact with the github package api
  packageRepo: PackageRepo

  constructor() {
    this.config = buildConfig()
    this.packageRepo = new PackageRepo(this.config)
    this.registry = new Registry(this.config, this.packageRepo)
  }

  /*
   * Post initialization for async functions
   */
  async init(): Promise<void> {
    await this.config.init()
  }

  async run(): Promise<void> {
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
      const packagesInUse: string[] = await this.packageRepo.getPackageList()

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
      await this.registry.login(targetPackage)

      const cleanupTask = new CleanupTask(
        this.config,
        this.packageRepo,
        this.registry,
        targetPackage
      )
      await cleanupTask.reload()
      await cleanupTask.run()
    }
  }
}
