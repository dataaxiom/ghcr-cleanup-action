/**
 * A utility to prime, setup and test CI use cases
 */

import stdio from 'stdio'
import fs from 'fs'
import * as core from '@actions/core'
import { Config } from './config.js'
import { GithubPackageRepo } from './github-package.js'
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
  if (output.error != null) {
    throw new Error(`error running command: ${output.error}`)
  } else if (output.status !== null && output.status !== 0) {
    throw new Error(`running command:  + ${command}, status: ${output.status}`)
  }
}

/**
 * Pushes a given source image to the given destination.
 *
 * Uses skopeo to perform the copy operation.
 *
 * @param srcImage The source image in the format `docker://<image-name>`.
 * @param destImage The destination image in the format `docker://<image-name>`.
 * @param extraArgs Additional arguments to pass to the `skopeo` command.
 * @param token The authentication token for the destination registry.
 */
function copyImage(
  srcImage: string,
  destImage: string,
  extraArgs: string | undefined,
  token: string
): void {
  core.info(`Copying image ${srcImage} to ${destImage}.`)

  // Set up the arguments for the skopeo command.
  const args = [
    'copy',
    `docker://${srcImage}`,
    `docker://${destImage}`,
    `--dest-creds=token:${token}`
  ]

  // Add any additional arguments.
  if (extraArgs) {
    const parts = extraArgs.split(' ')
    for (const part of parts) {
      args.push(part.trim())
    }
  }

  // Run the skopeo command.
  processWrapper('skopeo', args, {
    encoding: 'utf-8',
    shell: false,
    stdio: 'inherit'
  })
}

async function copyImages(
  filePath: string,
  owner: string,
  packageName: string,
  token: string,
  delay: number
): Promise<void> {
  const fileContents = fs.readFileSync(filePath, 'utf-8')

  for (const line of fileContents.split('\n')) {
    // Remove comment, maybe, and trim whitespace.
    const line0 = (
      line.includes('//') ? line.substring(0, line.indexOf('//')) : line
    ).trim()

    // Ignore empty lines.
    if (line0.length <= 0) continue

    // Split into parts.
    const parts = line0.split('|')

    core.info(`parts = ${parts}`)

    // Validate the number of parts.
    if (parts.length !== 2 && parts.length !== 3) {
      throw Error(`prime file format error: ${line}`)
    }

    // The source image repository is the first part.
    const srcImage = parts[0]

    // Determine the tags to use in the target repository.
    let tags: string[] = []
    if (parts[1]) {
      // The tags are explicitly given in the second part, separated by commas.
      tags = parts[1].split(',').map(tag => `:${tag.trim()}`)
    } else if (parts[0].includes('@')) {
      // No tag specified, use the source image digest, so the copied image will be untagged.
      tags = [parts[0].substring(parts[0].indexOf('@'))]
    } else if (parts[0].includes(':')) {
      // No tag specified, use the the source image tag.
      tags = [parts[0].substring(parts[0].indexOf(':'))]
    } else {
      // Incorrect format.
      throw Error('Unable to determine target image tag or digest')
    }

    // The full destination image name.
    const destImages: string[] = tags.map(
      tag => `ghcr.io/${owner}/${packageName}${tag}`
    )

    core.info(`srcImage = ${srcImage}`)
    core.info(`destImages = ${destImages}`)

    // Additional arguments to pass to the skopeo command, maybe.
    const args = parts.length === 3 ? parts[2] : undefined

    for (const destImage of destImages) {
      copyImage(srcImage, destImage, args, token)
    }
  }

  if (delay > 0) {
    // sleep to allow packages to be created in order
    await new Promise(f => setTimeout(f, delay))
  }
}

/**
 * Deletes package versions based on the digests specified in a file.
 *
 * @param directory The directory where the file is located.
 * @param packageIdByDigest A map that stores the package ID by digest.
 * @param repo The instance of the GithubPackageRepo class.
 */
async function deleteImages(
  filePath: string,
  repo: GithubPackageRepo
): Promise<void> {
  // Read file contents.
  const fileContents = fs.readFileSync(filePath, 'utf-8')

  for (const line of fileContents.split('\n')) {
    // Remove comment, maybe, and trim whitespace.
    const line0 = (
      line.includes('//') ? line.substring(0, line.indexOf('//')) : line
    ).trim()

    // Skip empty lines.
    if (line0.length <= 0) continue

    const version = repo.getVersionForDigest(line0)

    if (version) {
      core.info(
        `Deleting package version: id = ${version.id}, digest = ${line0}`
      )
      await repo.deletePackageVersion(version.id)
    } else {
      throw Error(
        `Unable to delete image with digest = ${line0} as it was not found in the repository.`
      )
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

  if (args == null) {
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

  // let tag
  if (args.tag) {
    assertString(args.tag)
    // tag = args.tag
  }

  // auto populate
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY
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

  const registry = new Registry(config)
  await registry.login()

  const githubPackageRepo = new GithubPackageRepo(config)
  await githubPackageRepo.init()

  const packagesById = new Map<string, any>()

  // Digest of busybox image to be used as dummy image. Corresponds to busybox:1.31.
  const dummyDigest =
    'sha256:6d9a2e77c3b19944a28c3922f5715ede91c1ae869d91edf5f6adf88ed54e97cf' // 1.36.1-musl linux/amd64

  if (args.mode === 'prime') {
    // Prime the container image repository with the given images and tags.
    core.info(
      `Priming the container image repository ghcr.io/${config.owner}/${config.package}.`
    )

    // Push dummy image to ensure that the container image repository exists and contains at least one version.
    // Once the repository has been created, it must contain at least one version, i.e. trying to delete the
    // last version will fail. To that end, the dummy image is always kept in the repository but is ignored for
    // the actual tests.
    copyImage(
      `busybox@${dummyDigest}`,
      `ghcr.io/${config.owner}/${config.package}:dummy`,
      undefined,
      args.token
    )

    // Load all versions.
    await githubPackageRepo.loadVersions()

    // Remove all existing images, except for the dummy image.
    for (const version of githubPackageRepo.getVersions()) {
      if (version.name !== dummyDigest) {
        await githubPackageRepo.deletePackageVersion(version.id)
      }
    }

    // Path to prime file. Contains the images to copy into the repository.
    const primeFilePath = `${args.directory}/prime`

    if (fs.existsSync(primeFilePath)) {
      core.info(`Found prime file at ${primeFilePath}. Pushing images in file.`)

      // Push the images from the prime file.
      await copyImages(
        primeFilePath,
        config.owner,
        config.package,
        config.token,
        delay
      )
    } else {
      // No prime file. This is an error because for testing the action, we need to copy some images into the reppository first.
      throw Error(`No prime file found at ${primeFilePath}.`)
    }

    // Path to prime-delete file. Contains the digests of images to delete from the repository after images have been copied.
    // Can be used to delete select images again that were initially copied recursively because they were referenced from the
    // prime images.
    const primeDeleteFilePath = `${args.directory}/prime-delete`

    if (fs.existsSync(primeDeleteFilePath)) {
      core.info(
        `Found prime-delete file at ${primeDeleteFilePath}. Deleting images in file.`
      )

      // Reload all versions.
      await githubPackageRepo.loadVersions()

      for (const version of githubPackageRepo.getVersions()) {
        core.info(`id = ${version.id}, digest = ${version.name}`)
      }

      // Delete the images from the prime delete file.
      await deleteImages(primeDeleteFilePath, githubPackageRepo)
    } else {
      console.info(
        `No prime-delete file found at ${primeDeleteFilePath}. Skipping.`
      )
    }
  } else if (args.mode === 'validate') {
    // test the repo after the test
    await githubPackageRepo.loadVersions()

    let error = false

    // Load expected digests.
    if (!fs.existsSync(`${args.directory}/expected-digests`)) {
      core.setFailed(`file: ${args.directory}/expected-digests doesn't exist`)
      error = true
    } else {
      const digests_expected = new Set<string>()
      const fileContents = fs.readFileSync(
        `${args.directory}/expected-digests`,
        'utf-8'
      )

      for (const line of fileContents.split('\n')) {
        // Remove comment, maybe, and trim whitespace.
        const line0 = (
          line.includes('//') ? line.substring(0, line.indexOf('//')) : line
        ).trim()

        // Ignore empty lines.
        if (line0.length <= 0) continue

        digests_expected.add(line0)
      }

      const digests = new Set<string>()
      for (const version of githubPackageRepo.getVersions()) {
        digests.add(version.name)
      }

      for (const digest of digests_expected) {
        if (digests.has(digest)) {
          // Found expected digest.

          // Delete it from the set already since it is irrelevant when checking for unexpected digests in the next loop below.
          digests.delete(digest)
        } else {
          // Could not find expected digest.
          error = true
          core.setFailed(`Expected digest not found after test: ${digest}`)
        }
      }

      for (const digest of digests) {
        // Found digest that was not expected.
        error = true
        core.setFailed(`Found unexpected digest after test: ${digest}`)
      }
    }

    // Load expected tags.

    if (!fs.existsSync(`${args.directory}/expected-tags`)) {
      core.setFailed(`file: ${args.directory}/expected-tags doesn't exist`)
      error = true
    } else {
      const expectedTags = new Set<string>()
      const fileContents = fs.readFileSync(
        `${args.directory}/expected-tags`,
        'utf-8'
      )
      for (const line of fileContents.split('\n')) {
        // Remove comment, maybe, and trim whitespace.
        const line0 = (
          line.includes('//') ? line.substring(0, line.indexOf('//')) : line
        ).trim()

        // Ignore empty lines.
        if (line0.length <= 0) continue

        expectedTags.add(line)
      }

      const tags = new Set<string>()
      for (const tag of githubPackageRepo.getTags()) {
        tags.add(tag)
      }

      for (const tag of expectedTags) {
        if (tags.has(tag)) {
          // Found expected tag.

          // Delete it from the set already since it is irrelevant when checking for unexpected digests in the next loop below.
          tags.delete(tag)
        } else {
          // Could not find expected tag.
          error = true
          core.setFailed(`Expected tag not found after test: ${tag}`)
        }
      }

      for (const tag of tags) {
        // Found tag that was not expected.
        error = true
        core.setFailed(`Found unexpected tag after test: ${tag}`)
      }
    }

    if (!error) console.info('test passed!')
  } else if (args.mode === 'save-expected') {
    // save the expected tag dynamically
    await githubPackageRepo.loadVersions()

    const tags = new Set<string>()
    for (const ghPackage of packagesById.values()) {
      for (const repoTag of ghPackage.metadata.container.tags) {
        tags.add(repoTag)
      }
    }

    // if (tag) {
    // find the digests in use for the supplied tag
    // const digest = await registry.getTagDigest(tag)
    // fs.appendFileSync(`${args.directory}/expected-digests`, `${digest}\n`)

    // is there a refferrer digest
    //   const referrerTag = digest.replace('sha256:', 'sha256-')
    //   if (tags.has(tag)) {
    //     fs.appendFileSync(`${args.directory}/expected-tags`, `${referrerTag}\n`)
    //     const referrerDigest = await registry.getTagDigest(referrerTag)
    //     fs.appendFileSync(
    //       `${args.directory}/expected-digests`,
    //       `${referrerDigest}\n`
    //     )
    //     const referrerManifest =
    //       await registry.getManifestByDigest(referrerDigest)
    //     if (referrerManifest.manifests) {
    //       for (const manifest of referrerManifest.manifests) {
    //         fs.appendFileSync(
    //           `${args.directory}/expected-digests`,
    //           `${manifest.digest}\n`
    //         )
    //       }
    //     }
    //   }
    // } else {
    //   core.setFailed('no tag supplied')
    // }
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
await run()
