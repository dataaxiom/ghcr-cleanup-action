/**
 * A utility to prime, setup and test CI use cases
 */

import stdio from 'stdio'
import fs from 'fs'
import * as core from '@actions/core'
import { Config } from './config'
import { GithubPackageRepo } from './github-package'
import { Registry } from './registry'
import { SpawnSyncOptionsWithBufferEncoding, spawnSync } from 'child_process'

function assertString(input: unknown): asserts input is string {
  if (typeof input !== 'string') {
    throw new Error('Input is not a string.')
  }
}

export function processWrapper(
  command: string,
  options: SpawnSyncOptionsWithBufferEncoding
) {
  options.shell = true
  options.stdio = 'inherit'
  const output = spawnSync(command, options)
  if (output.status !== null && output.status !== 0) {
    throw new Error(`running command:  + ${command}`)
  }
}

function pushImage(
  srcImage: string,
  destImage: string,
  args: string | undefined,
  token: string
): void {
  console.log(`copying image: ${srcImage} ${destImage}`)
  let command = `skopeo copy docker://${srcImage}  docker://${destImage} --dest-creds=token:${token}`
  if (args) {
    command += ` ${args}`
  }
  processWrapper(command, {})
}

async function loadImages(
  directory: string,
  owner: string,
  packageName: string,
  token: string,
  delay: number
) {
  if (!fs.existsSync(`${directory}/prime`)) {
    throw Error(`file: ${directory}/prime doesn't exist`)
  }

  const fileContents = fs.readFileSync(`${directory}/prime`, 'utf-8')
  for (let line of fileContents.split('\n')) {
    const original = line
    if (line.length > 0) {
      if (line.includes('//')) {
        line = line.substring(0, line.indexOf('//')).trim()
      }

      // split into parts
      const parts = line.split('|')
      if (parts.length === 2) {
        pushImage(
          parts[0],
          `ghcr.io/${owner}/${packageName}:${parts[1]}`,
          undefined,
          token
        )
      } else if (parts.length === 3) {
        pushImage(
          parts[0],
          `ghcr.io/${owner}/${packageName}:${parts[1]}`,
          parts[2],
          token
        )
      } else {
        throw Error(`prime file format error: ${original}`)
      }
    }
    if (delay > 0) {
      // sleep to allow packages to be created in order
      await new Promise(f => setTimeout(f, delay))
    }
  }
}

export async function run(): Promise<void> {
  const args = stdio.getopt({
    token: { key: 'token', args: 1, required: true },
    owner: { key: 'owner', args: 1, required: false },
    repository: { key: 'repository', args: 1, required: false },
    package: { key: 'package', args: 1, required: false },
    directory: { key: 'directory', args: 1, required: true },
    mode: { key: 'mode', args: 1, required: true },
    delay: { key: 'delay', args: 1, required: false }
  })

  if (!args) {
    throw Error('args is not setup')
  }

  assertString(args.token)
  const config = new Config(args.token)

  if (args.owner) {
    assertString(args.owner)
    config.owner = args.owner
  }
  if (args.repository) {
    assertString(args.repository)
    config.repository = args.repository
  }
  if (args.package) {
    assertString(args.package)
    config.package = args.package
  }
  assertString(args.directory)
  assertString(args.mode)

  let delay = 0
  if (args.delay) {
    assertString(args.delay)
    delay = parseInt(args.delay)
  }

  // auto populate
  const GITHUB_REPOSITORY = process.env['GITHUB_REPOSITORY']
  if (GITHUB_REPOSITORY) {
    const parts = GITHUB_REPOSITORY.split('/')
    if (parts.length === 2) {
      if (!config.owner) {
        config.owner = parts[0]
      }
      if (!config.package) {
        config.package = parts[1]
      }
      if (!config.repository) {
        config.repository = parts[1]
      }
    }
  }

  const registry = new Registry(config)
  await registry.login()

  const githubPackageRepo = new GithubPackageRepo(config)
  await githubPackageRepo.init()

  const packageIdByDigest = new Map<string, string>()
  const packagesById = new Map<string, any>()

  const dummyDigest =
    'sha256:1a41828fc1a347d7061f7089d6f0c94e5a056a3c674714712a1481a4a33eb56f'

  if (args.mode === 'prime') {
    // push dummy image - repo once it's created and has an iamge it requires atleast one image
    pushImage(
      `busybox@${dummyDigest}`, // 1.31
      `ghcr.io/${config.owner}/${config.package}:dummy`,
      undefined,
      args.token
    )
    // load after dummy to make sure the package exists on first clone/setup
    await githubPackageRepo.loadPackages(packageIdByDigest, packagesById)

    // remove all the existing images - except for the dummy image
    const digests = await registry.getAllTagDigests()
    for (const digest of digests) {
      if (digest !== dummyDigest) {
        await githubPackageRepo.deletePackageVersion(
          packageIdByDigest.get(digest)!,
          digest,
          []
        )
      }
    }

    // prime the test images
    await loadImages(
      args.directory,
      config.owner!,
      config.package!,
      config.token,
      delay
    )

    // make any deletions
  } else if (args.mode === 'validate') {
    // test the repo after the test
    await githubPackageRepo.loadPackages(packageIdByDigest, packagesById)

    let error = false

    // load the expected digests
    if (!fs.existsSync(`${args.directory}/expected-digests`)) {
      core.setFailed(`file: ${args.directory}/expected-digests doesn't exist`)
      error = true
    } else {
      const digests = new Set<string>()
      const fileContents = fs.readFileSync(
        `${args.directory}/expected-digests`,
        'utf-8'
      )
      for (let line of fileContents.split('\n')) {
        if (line.length > 0) {
          if (line.includes('//')) {
            line = line.substring(0, line.indexOf('//') - 1).trim()
          }
          digests.add(line)
        }
      }

      for (const digest of digests) {
        if (packageIdByDigest.has(digest)) {
          packageIdByDigest.delete(digest)
        } else {
          error = true
          core.setFailed(`expected digest not found after test: ${digest}`)
        }
      }
      for (const digest of packageIdByDigest.keys()) {
        error = true
        core.setFailed(`extra digest found after test: ${digest}`)
      }
    }

    // load the expected tags

    if (!fs.existsSync(`${args.directory}/expected-tags`)) {
      core.setFailed(`file: ${args.directory}/expected-tags doesn't exist`)
      error = true
    } else {
      const expectedTags = new Set<string>()
      const fileContents = fs.readFileSync(
        `${args.directory}/expected-tags`,
        'utf-8'
      )
      for (let line of fileContents.split('\n')) {
        if (line.length > 0) {
          if (line.includes('//')) {
            line = line.substring(0, line.indexOf('//')).trim()
          }
          expectedTags.add(line)
        }
      }

      const regTags = new Set(await registry.getTags())
      for (const expectedTag of expectedTags) {
        if (regTags.has(expectedTag)) {
          regTags.delete(expectedTag)
        } else {
          error = true
          core.setFailed(`expected tag ${expectedTag} not found after test`)
        }
      }
      for (const tag of regTags) {
        error = true
        core.setFailed(`extra tag found after test: ${tag}`)
      }
    }

    if (!error) console.info('test passed!')
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
run()
