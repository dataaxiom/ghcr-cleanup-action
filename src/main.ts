import * as core from '@actions/core'
import { Config, getConfig } from './config'
import { Registry } from './registry'
import { GithubPackage } from './github-package'
import { calcDigest } from './utils'

export async function run(): Promise<void> {
  const action = new CleanupAction()
  await action.init()
  await action.run()
}

class CleanupAction {
  config: Config
  excludeTags: string[] = []
  registry: Registry
  githubPackage: GithubPackage
  packageIdByDigest = new Map<string, string>()
  packages = new Map<string, any>()
  trimmedMultiArchPackages = new Map<string, any>()

  constructor() {
    this.config = getConfig()
    if (this.config.excludeTags) {
      this.excludeTags = this.config.excludeTags.split(',')
    }
    this.registry = new Registry(this.config)
    this.githubPackage = new GithubPackage(this.config)
  }

  async init(): Promise<void> {
    await this.registry.login()
    await this.githubPackage.init()
    // get list of all the current packages
    await this.githubPackage.loadPackages(this.packageIdByDigest, this.packages)
  }

  async trimMultiArchImages(reference: string): Promise<void> {
    const manifest = await this.registry.getRawManifest(reference)
    const data = JSON.parse(manifest)
    if (data.manifests) {
      for (const imageManifest of data.manifests) {
        // get the id and trim it as its in use
        const id = this.packageIdByDigest.get(imageManifest.digest)
        if (id) {
          // save it for later use, so don't have to reload it
          this.trimmedMultiArchPackages.set(
            imageManifest.digest,
            this.packages.get(id)
          )
          // now remove it
          this.packages.delete(id)
        }
      }
    }
  }

  async deleteByTag(): Promise<void> {
    if (this.config.tags) {
      core.info(`deleting images by tags`)
      const tags = this.config.tags.split(',')
      for (const tag of tags) {
        if (!this.excludeTags.includes(tag)) {
          if (await this.registry.tagExists(tag)) {
            let manifest = await this.registry.getRawManifest(tag)
            const manifestDigest = calcDigest(manifest)
            // get the package
            const ghPackageId = this.packageIdByDigest.get(manifestDigest)
            const ghPackage = await this.githubPackage.getPackage(ghPackageId!)
            // if the image only has one tag - delete it
            if (ghPackage.data.metadata.container.tags.length === 1) {
              const data = JSON.parse(manifest)
              await this.githubPackage.deletePackage(
                ghPackageId!,
                manifestDigest,
                ghPackage.data.metadata.container.tags
              )
              if (data.manifests) {
                // a multiarch image
                for (const imageManifest of data.manifests) {
                  const imageDigest = imageManifest.digest
                  const id = this.packageIdByDigest.get(imageDigest)
                  if (id) {
                    await this.githubPackage.deletePackage(id, imageDigest, [
                      `architecture ${imageManifest.platform.architecture}`
                    ])
                  } else {
                    core.warning(
                      `couldn't find package id ${id} with digest ${imageDigest} to delete`
                    )
                  }
                }
              }
            } else {
              // preform a "ghcr.io" image deleltion
              // as the registry doesn't support manifest deletion directly
              // we instead assign the tag to a different manifest first
              // then we delete it
              core.info(`untagging ${tag}`)
              const data = JSON.parse(manifest)
              // create a fake manifest to seperate the tag
              if (data.manifests) {
                // a multiarch image
                data.manifests = []
                await this.registry.putManifest(tag, data, true)
              } else {
                data.layers = []
                await this.registry.putManifest(tag, data, false)
              }

              // reload package ids to find the new package id
              const reloadPackageByDigest = new Map<string, string>()
              const githubPackages = new Map<string, any>()
              await this.githubPackage.loadPackages(
                reloadPackageByDigest,
                githubPackages
              )
              // reload the manifest
              manifest = await this.registry.getRawManifest(tag)
              const untaggedDigest = calcDigest(manifest)
              const id = reloadPackageByDigest.get(untaggedDigest)
              if (id) {
                await this.githubPackage.deletePackage(id, untaggedDigest, [
                  tag
                ])
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
      }
    }
  }

  async keepNuntagged(): Promise<void> {
    if (this.config.keepNuntagged && this.config.keepNuntagged !== 0) {
      core.info(
        `deleting untagged images, keeping ${this.config.keepNuntagged} versions`
      )

      // get all the tagged digests from the containter registry
      const imageDigests = await this.registry.getAllTagDigests()

      // remove these from the saved packages list
      for (const digest of imageDigests) {
        const id = this.packageIdByDigest.get(digest)
        if (id) {
          this.packages.delete(id)
        }
        this.packageIdByDigest.delete(digest)
      }

      // now remove the untagged images left in the packages list
      if (this.packageIdByDigest.size > 0) {
        // remove multi architecture images - only count the manifest list image
        for (const digest of this.packageIdByDigest.keys()) {
          await this.trimMultiArchImages(digest)
        }
        // now sort the remaining packages by date
        let untaggedPackages = [...this.packages.values()]
        untaggedPackages.sort((a, b) => {
          return Date.parse(a.updated_at) - Date.parse(b.updated_at)
        })

        // now delete the remainder untagged packages/images minus the keep value
        if (untaggedPackages.length > this.config.keepNuntagged) {
          if (untaggedPackages.length === 1 && this.config.keepNtagged === 1) {
            untaggedPackages = []
          } else if (untaggedPackages.length > this.config.keepNuntagged) {
            untaggedPackages = untaggedPackages.slice(this.config.keepNuntagged)
          }
          for (const untaggedPackage of untaggedPackages) {
            const ghPackage = this.packages.get(untaggedPackage.id)
            // get the manifest before we delete it
            const manifest = await this.registry.getRawManifest(
              untaggedPackage.name
            )
            await this.githubPackage.deletePackage(
              untaggedPackage.id,
              untaggedPackage.name,
              ghPackage.metadata.container.tags
            )
            // if multi arch image now delete the platform packages/images
            const data = JSON.parse(manifest)
            if (data.manifests) {
              for (const imageManifest of data.manifests) {
                const trimmedPackage = this.trimmedMultiArchPackages.get(
                  imageManifest.digest
                )
                await this.githubPackage.deletePackage(
                  trimmedPackage.id,
                  trimmedPackage.name,
                  [`architecture ${imageManifest.platform.architecture}`]
                )
              }
            }
          }
        }
      } else {
        core.info('no images to remove')
      }
    }
  }

  async deletePackages(): Promise<void> {
    // process deletion in 2 iterations to delete multi images first
    const deleted = new Set<string>()
    // cache for second iteration
    const manifests = new Map<string, string>()

    for (const untaggedPackage of this.packages.values()) {
      if (!deleted.has(untaggedPackage.name)) {
        // get the manifest before we delete it
        let manifest = manifests.get(untaggedPackage.name)
        if (!manifest) {
          manifest = await this.registry.getRawManifest(untaggedPackage.name)
          manifests.set(untaggedPackage.name, manifest)
        }
        const data = JSON.parse(manifest)
        if (data.manifests) {
          await this.githubPackage.deletePackage(
            untaggedPackage.id,
            untaggedPackage.name,
            untaggedPackage.metadata.container.tags
          )
          deleted.add(untaggedPackage.name)

          // if multi arch image now delete the platform packages/images
          for (const imageManifest of data.manifests) {
            const packackeId = this.packageIdByDigest.get(imageManifest.digest)
            const ghPackage = this.packages.get(packackeId!)
            await this.githubPackage.deletePackage(
              ghPackage.id,
              ghPackage.name,
              [`architecture ${imageManifest.platform.architecture}`]
            )
            deleted.add(ghPackage.name)
          }
        }
      }
    }
    // now process the remainder
    for (const untaggedPackage of this.packages.values()) {
      if (!deleted.has(untaggedPackage.name)) {
        await this.githubPackage.deletePackage(
          untaggedPackage.id,
          untaggedPackage.name,
          untaggedPackage.metadata.container.tags
        )
        deleted.add(untaggedPackage.name)
      }
    }
  }

  async keepNtagged(): Promise<void> {
    if (this.config.keepNtagged != null) {
      core.info(
        `deleting tagged images, keeping ${this.config.keepNtagged} versions`
      )
      let packagesToKeep = []
      // get all the packages with tags
      if (this.config.keepNtagged > 0) {
        for (const ghPackage of this.packages.values()) {
          if (ghPackage.metadata.container.tags.length > 0) {
            // only add for excluded tags
            let excluded = false
            for (const excludeTag of this.excludeTags) {
              if (ghPackage.metadata.container.tags.includes(excludeTag)) {
                excluded = true
                break
              }
            }
            if (!excluded) {
              packagesToKeep.push(ghPackage)
            }
          }
        }

        // sort them by date
        packagesToKeep.sort((a, b) => {
          return Date.parse(a.updated_at) - Date.parse(b.updated_at)
        })
        // trim to size
        if (packagesToKeep.length > this.config.keepNtagged) {
          packagesToKeep = packagesToKeep.splice(this.config.keepNtagged + 1)
        }

        // now strip these from the package list
        for (const ghPackage of packagesToKeep) {
          // if multi arch delete those
          await this.trimMultiArchImages(ghPackage.name)
          this.packages.delete(ghPackage.id)
        }
      }

      // remove the excluded tags
      for (const tag of this.excludeTags) {
        const manifest = await this.registry.getRawManifest(tag)
        const imageDigest = calcDigest(manifest)
        const data = JSON.parse(manifest)
        if (data.manifests) {
          await this.trimMultiArchImages(tag)
        }
        const id = this.packageIdByDigest.get(imageDigest)
        if (id) {
          this.packages.delete(id)
        } else {
          core.warning(
            `couldn't find package id ${id} with digest ${imageDigest} to delete`
          )
        }
      }
      await this.deletePackages()
    }
  }

  async run(): Promise<void> {
    try {
      if (this.config.tags) {
        // we are in the delete specific tags mode
        await this.deleteByTag()
      } else if (this.config.keepNuntagged) {
        // value 0 will be treated as boolean
        // we are in the cleanup untagged images mode
        await this.keepNuntagged()
      } else if (this.config.keepNtagged != null) {
        // we are in the cleanup tagged images mode
        await this.keepNtagged()
      } else {
        // in deleting all untagged images

        core.info('deleting all untagged images')

        // get all the tagged digests from the containter registry
        const inUseDigests = await this.registry.getAllTagDigests()

        // remove these from the saved packages list
        for (const digest of inUseDigests) {
          const id = this.packageIdByDigest.get(digest)
          if (id) this.packages.delete(id)
        }
        await this.deletePackages()
      }
    } catch (error) {
      // Fail the workflow run if an error occurs
      if (error instanceof Error) core.setFailed(error.message)
    }
  }
}
