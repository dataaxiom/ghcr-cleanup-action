import * as core from '@actions/core'
import { getConfig } from './config'
import { Registry } from './registry'
import { GithubPackage } from './github-package'
import { calcDigest } from './utils'

export async function run(): Promise<void> {
  try {
    const config = getConfig()
    const registry = new Registry(config)
    await registry.login()
    const githubPackage = new GithubPackage(config)
    await githubPackage.init()

    // get all the packages
    let packageByDigest = new Map<string, string>()
    let packages = new Map<string, any>()
    await githubPackage.loadPackages(packageByDigest, packages)

    if (config.tags) {
      const tags = config.tags.split(',')
      for (const tag of tags) {
        if (await registry.tagExists(tag)) {
          let manifest = await registry.getRawManifest(tag)
          const manifestDigest = calcDigest(manifest)
          // get the package
          const ghPackageId = packageByDigest.get(manifestDigest)
          const ghPackage = await githubPackage.getPackage(ghPackageId!)
          // if the image only has one tag - delete it
          if (ghPackage.data.metadata.container.tags.length === 1) {
            if (await registry.isMultiArch(tag)) {
              const data = JSON.parse(manifest)
              for (const imageManifest of data.manifests) {
                const imageDigest = imageManifest.digest
                const id = packageByDigest.get(imageDigest)
                if (id) {
                  await githubPackage.deletePackage(id, imageDigest)
                } else {
                  core.warning(
                    `couldn't find package id ${id} with digest ${imageDigest} to delete`
                  )
                }
              }
            }
            core.info(`deleting ${tag}`)
            await githubPackage.deletePackage(ghPackageId!, manifestDigest)
          } else {
            // preform a "ghcr.io" image deleltion
            // as the registry doesn't support manifest deletion directly
            // so instead we asign the tag to a different manifest first
            // then we delete the new one
            core.info(`untagging ${tag}`)
            const data = JSON.parse(manifest)
            // create a fake manifest to seperate the tag
            if (await registry.isMultiArch(tag)) {
              data.manifests = []
              await registry.putManifest(tag, data, true)
            } else {
              data.layers = []
              await registry.putManifest(tag, data, false)
            }
            // reload package ids
            packageByDigest = new Map<string, string>()
            packages = new Map<string, any>()
            await githubPackage.loadPackages(packageByDigest, packages)
            // reload the manifest
            manifest = await registry.getRawManifest(tag)
            const untaggedDigest = calcDigest(manifest)
            const id = packageByDigest.get(untaggedDigest)
            if (id) {
              await githubPackage.deletePackage(id, untaggedDigest)
            } else {
              core.warning(
                `couldn't find package id ${id} with digest ${untaggedDigest} to delete`
              )
            }
          }
        } else {
          core.info(
            `skipping ${tag} tag deletion, it doesn't exist in registry`
          )
        }
      }
    } else {
      // we are in cleanup all untagged images mode

      // get the docker images view
      const images = await registry.getAllTagDigests()

      // remove all the images from the packages list
      for (const image of images) {
        packageByDigest.delete(image)
        const id = packageByDigest.get(image)
        if (id) packages.delete(id)
      }

      // now remove the untagged images
      if (packageByDigest.size > 0) {
        if (config.numberUntagged && config.numberUntagged !== 0) {
          core.info(
            `deleting untagged images, keeping ${config.numberUntagged} versions`
          )
          // remove multi architecture images - only count the manifest
          for (const digest of packageByDigest.entries()) {
            const manifest = await registry.getRawManifest(digest[0])
            if (await registry.isMultiArch(digest[0])) {
              const data = JSON.parse(manifest)
              for (const imageManifest of data.manifests) {
                packageByDigest.delete(imageManifest.digest)
                // get the id and delete it as its inuse
                const id = packageByDigest.get(imageManifest.digest)
                if (id) packages.delete(id)
              }
            }
          }
          // now sort the remaining packages
          let untaggedPackages = [...packages.values()]
          untaggedPackages.sort((a, b) => {
            return Date.parse(b.updated_at) - Date.parse(a.updated_at)
          })

          untaggedPackages = untaggedPackages.slice(config.numberUntagged)
          // now delete the remainder untagged packages/images
          for (const untaggedPackage of untaggedPackages) {
            await githubPackage.deletePackage(
              untaggedPackage.id,
              untaggedPackage.name
            )
          }
        } else {
          core.info('deleting all untagged images')
          for (const entry of packageByDigest.entries()) {
            await githubPackage.deletePackage(entry[1], entry[0])
          }
        }
      } else {
        core.info('no images to remove')
      }
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
