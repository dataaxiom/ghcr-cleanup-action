/**
 * A utility to prime, setup and test CI use cases
 */

import stdio from 'stdio'
import fs from 'fs'
import * as core from '@actions/core'
import { Config } from './config.js'
import { PackageRepo } from './package-repo.js'
import { OctokitClient } from './octokit-client.js'
import { Registry } from './registry.js'
import { SpawnSyncOptionsWithStringEncoding, spawnSync } from 'child_process'

function assertString(input: unknown): asserts input is string {
  if (typeof input !== 'string') {
    throw new Error('Input is not a string.')
  }
}

export function processWrapper(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
): void {
  const output = spawnSync(command, args, options)
  if (output.error) {
    throw new Error(`error running command: ${output.error}`)
  } else if (output.status !== null && output.status !== 0) {
    throw new Error(`running command:  + ${command}, status: ${output.status}`)
  }
}

function pushImage(
  srcImage: string,
  destImage: string,
  extraArgs: string | undefined,
  token: string
): void {
  console.log(`copying image: ${srcImage} ${destImage}`)
  const args = [
    'copy',
    `docker://${srcImage}`,
    `docker://${destImage}`,
    `--dest-creds=token:${token}`,
    '--preserve-digests'
  ]
  if (extraArgs) {
    const parts = extraArgs.split(' ')
    for (const part of parts) {
      args.push(part.trim())
    }
  }
  processWrapper('skopeo', args, {
    encoding: 'utf-8',
    shell: false,
    stdio: 'inherit'
  })
}

async function loadImages(
  directory: string,
  owner: string,
  packageName: string,
  token: string,
  delay: number
): Promise<void> {
  if (!fs.existsSync(`${directory}/prime`)) {
    throw Error(`file: ${directory}/prime doesn't exist`)
  }

  const fileContents = fs.readFileSync(`${directory}/prime`, 'utf-8')
  for (let line of fileContents.split('\n')) {
    const original = line
    line = line.trim()
    if (line.length > 0) {
      if (line.includes('//')) {
        line = line.substring(0, line.indexOf('//'))
      }
      line = line.trim()

      // split into parts
      const parts = line.split('|')
      if (parts.length !== 2 && parts.length !== 3) {
        throw Error(`prime file format error: ${original}`)
      }
      const srcImage = parts[0]
      let tag
      if (parts[1]) {
        if (parts[1].includes('@')) {
          tag = parts[1]
        } else {
          tag = `:${parts[1]}`
        }
      } else {
        if (parts[0].includes('@')) {
          tag = `${parts[0].substring(parts[0].indexOf('@'))}`
        } else if (parts[0].includes(':')) {
          tag = `:${parts[0].substring(parts[0].indexOf(':'))}`
        } else {
          throw Error(`no tag specified in ${parts[0]}`)
        }
      }
      const destImage = `ghcr.io/${owner}/${packageName}${tag}`
      const args = parts.length === 3 ? parts[2] : undefined
      pushImage(srcImage, destImage, args, token)
    }
    if (delay > 0) {
      // sleep to allow packages to be created in order
      await new Promise(f => setTimeout(f, delay))
    }
  }
}

async function deleteDigests(
  directory: string,
  targetPackage: string,
  packageRepo: PackageRepo
): Promise<void> {
  if (fs.existsSync(`${directory}/prime-delete`)) {
    const fileContents = fs.readFileSync(`${directory}/prime-delete`, 'utf-8')
    for (let line of fileContents.split('\n')) {
      line = line.trim()
      if (line.length > 0) {
        if (line.includes('//')) {
          line = line.substring(0, line.indexOf('//') - 1)
        }
        line = line.trim()
        const id = packageRepo.getIdByDigest(line)
        if (id) {
          await packageRepo.deletePackageVersion(targetPackage, id, line, [])
        }
      }
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
    tag: { key: 'tag', args: 1, required: false },
    mode: { key: 'mode', args: 1, required: true },
    delay: { key: 'delay', args: 1, required: false }
  })

  if (!args) {
    throw Error('args is not setup')
  }

  assertString(args.token)
  const config = new Config()
  config.token = args.token

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

  let tag
  if (args.tag) {
    assertString(args.tag)
    tag = args.tag
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

  config.owner = config.owner?.toLowerCase()

  // Create Octokit client and fetch repository info
  const octokitClient = new OctokitClient(
    config.token,
    config.githubApiUrl,
    config.logLevel
  )
  const repoInfo = await octokitClient.getRepository(
    config.owner,
    config.repository
  )
  config.isPrivateRepo = repoInfo.isPrivate
  config.repoType = repoInfo.ownerType

  const packageRepo = new PackageRepo(config, octokitClient)
  const registry = new Registry(config, packageRepo)
  await registry.login(config.package)

  const dummyDigest =
    'sha256:1a41828fc1a347d7061f7089d6f0c94e5a056a3c674714712a1481a4a33eb56f'

  if (args.mode === 'prime-dummy') {
    // just push the dummy image
    pushImage(
      `busybox@${dummyDigest}`, // 1.31
      `ghcr.io/${config.owner}/${config.package}:dummy`,
      undefined,
      args.token
    )
  } else if (args.mode === 'prime') {
    // push dummy image - repo once it's created and has an iamge it requires atleast one image
    pushImage(
      `busybox@${dummyDigest}`, // 1.31
      `ghcr.io/${config.owner}/${config.package}:dummy`,
      undefined,
      args.token
    )
    // load after dummy to make sure the package exists on first clone/setup
    await packageRepo.loadPackages(config.package, false)

    // remove all the existing images - except for the dummy image
    for (const digest of packageRepo.getDigests()) {
      if (digest !== dummyDigest) {
        const id = packageRepo.getIdByDigest(digest)
        if (id) {
          await packageRepo.deletePackageVersion(config.package, id, digest, [])
        }
      }
    }

    // prime the test images
    await loadImages(
      args.directory,
      config.owner,
      config.package,
      config.token,
      delay
    )

    if (fs.existsSync(`${args.directory}/prime-delete`)) {
      await packageRepo.loadPackages(config.package, false)

      // make any deletions
      await deleteDigests(args.directory, config.package, packageRepo)
    }
  } else if (args.mode === 'validate') {
    // test the repo after the test
    await packageRepo.loadPackages(config.package, false)

    let error = false

    // load the expected digests
    if (!fs.existsSync(`${args.directory}/expected-digests`)) {
      core.setFailed(`file: ${args.directory}/expected-digests doesn't exist`)
      error = true
    } else {
      const expectedDigests = new Set<string>()
      const fileContents = fs.readFileSync(
        `${args.directory}/expected-digests`,
        'utf-8'
      )
      for (let line of fileContents.split('\n')) {
        line = line.trim()
        if (line.length > 0) {
          if (line.includes('//')) {
            line = line.substring(0, line.indexOf('//') - 1)
          }
          line = line.trim()
          expectedDigests.add(line)
        }
      }

      const digests = packageRepo.getDigests()
      for (const digest of expectedDigests) {
        if (packageRepo.getDigests().has(digest)) {
          digests.delete(digest)
        } else {
          error = true
          core.setFailed(`expected digest not found after test: ${digest}`)
        }
      }
      for (const digest of digests) {
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
        line = line.trim()
        if (line.length > 0) {
          if (line.includes('//')) {
            line = line.substring(0, line.indexOf('//'))
          }
          line = line.trim()
          expectedTags.add(line)
        }
      }

      const regTags = packageRepo.getTags()
      for (const expectedTag of expectedTags) {
        if (regTags.has(expectedTag)) {
          regTags.delete(expectedTag)
        } else {
          error = true
          core.setFailed(`expected tag ${expectedTag} not found after test`)
        }
      }
      for (const regTag of regTags) {
        error = true
        core.setFailed(`extra tag found after test: ${regTag}`)
      }
    }

    if (!error) console.info('test passed!')
  } else if (args.mode === 'save-expected') {
    // save the expected tag dynamically
    await packageRepo.loadPackages(config.package, false)

    const tags = new Set<string>()
    for (const digest of packageRepo.getDigests()) {
      const ghPackage = packageRepo.getPackageByDigest(digest)
      for (const repoTag of ghPackage.metadata.container.tags) {
        tags.add(repoTag)
      }
    }

    if (tag) {
      // find the digests in use for the supplied tag
      const digest = packageRepo.getDigestByTag(tag)
      if (digest) {
        fs.appendFileSync(`${args.directory}/expected-digests`, `${digest}\n`)

        // is it a multi arch image
        const manifest = await registry.getManifestByTag(tag)
        if (manifest.manifests) {
          for (const manifestDigest of manifest.manifests) {
            fs.appendFileSync(
              `${args.directory}/expected-digests`,
              `${manifestDigest.digest}\n`
            )
          }
        }

        // is there a refferrer digest
        const referrerTag = digest.replace('sha256:', 'sha256-')
        if (tags.has(referrerTag)) {
          fs.appendFileSync(
            `${args.directory}/expected-tags`,
            `${referrerTag}\n`
          )
          const referrerDigest = packageRepo.getDigestByTag(referrerTag)
          if (referrerDigest) {
            fs.appendFileSync(
              `${args.directory}/expected-digests`,
              `${referrerDigest}\n`
            )
            const referrerManifest =
              await registry.getManifestByDigest(referrerDigest)
            if (referrerManifest.manifests) {
              for (const manifestDigest of referrerManifest.manifests) {
                fs.appendFileSync(
                  `${args.directory}/expected-digests`,
                  `${manifestDigest.digest}\n`
                )
              }
            }
          } else {
            core.setFailed(`no tag found for referrer digest ${digest}`)
          }
        }
      } else {
        core.setFailed(`no tag found for digest ${digest}`)
      }
    } else {
      core.setFailed('no tag supplied')
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
await run()
