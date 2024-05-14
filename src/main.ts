import * as core from '@actions/core'
import { Config, getConfig } from './config'
import { Registry } from './registry'
import { GithubPackageRepo } from './github-package'
import { calcDigest } from './utils'
import wcmatch from 'wildcard-match'

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
  config: Config
  excludeTags: string[] = []
  registry: Registry
  githubPackageRepo: GithubPackageRepo
  packageIdByDigest = new Map<string, string>()
  packages = new Map<string, any>()
  tags = new Set<string>()
  trimmedMultiArchPackages = new Map<string, any>()

  numberMultiImagesDeleted = 0
  numberImagesDeleted = 0

  constructor() {
    this.config = getConfig()
    this.registry = new Registry(this.config)
    this.githubPackageRepo = new GithubPackageRepo(this.config)
  }

  async init(): Promise<void> {
    await this.registry.login()
    await this.githubPackageRepo.init()
    // get list of all the current packages
    await this.githubPackageRepo.loadPackages(
      this.packageIdByDigest,
      this.packages
    )
    // extract tags
    for (const ghPackage of this.packages.values()) {
      for (const tag of ghPackage.metadata.container.tags) {
        this.tags.add(tag)
      }
    }
    // find exclude tags using matcher
    if (this.config.excludeTags) {
      const isTagMatch = wcmatch(this.config.excludeTags.split(','))
      for (const tag of this.tags) {
        if (isTagMatch(tag)) {
          this.excludeTags.push(tag)
        }
      }
    }
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
      // find the tags the match wildcard patterns
      const isTagMatch = wcmatch(this.config.tags.split(','))
      const matchTags = []
      for (const tag of this.tags) {
        if (isTagMatch(tag)) {
          matchTags.push(tag)
        }
      }
      if (matchTags.length > 0) {
        for (const tag of matchTags) {
          if (!this.excludeTags.includes(tag)) {
            let manifest = await this.registry.getRawManifest(tag)
            const manifestDigest = calcDigest(manifest)
            // get the package
            const ghPackageId = this.packageIdByDigest.get(manifestDigest)
            const ghPackage = await this.githubPackageRepo.getPackage(
              ghPackageId!
            )
            // if the image only has one tag - delete it
            if (ghPackage.data.metadata.container.tags.length === 1) {
              const data = JSON.parse(manifest)
              await this.githubPackageRepo.deletePackage(
                ghPackageId!,
                manifestDigest,
                ghPackage.data.metadata.container.tags
              )
              this.numberImagesDeleted += 1
              if (data.manifests) {
                // a multiarch image
                this.numberMultiImagesDeleted += 1
                for (const imageManifest of data.manifests) {
                  const imageDigest = imageManifest.digest
                  const id = this.packageIdByDigest.get(imageDigest)
                  if (id) {
                    await this.githubPackageRepo.deletePackage(
                      id,
                      imageDigest,
                      [`architecture ${imageManifest.platform.architecture}`]
                    )
                    this.numberImagesDeleted += 1
                  } else {
                    core.warning(
                      `couldn't find image digest ${imageDigest} in repository, skipping`
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
              await this.githubPackageRepo.loadPackages(
                reloadPackageByDigest,
                githubPackages
              )
              // reload the manifest
              manifest = await this.registry.getRawManifest(tag)
              const untaggedDigest = calcDigest(manifest)
              const id = reloadPackageByDigest.get(untaggedDigest)
              if (id) {
                await this.githubPackageRepo.deletePackage(id, untaggedDigest, [
                  tag
                ])
                this.numberImagesDeleted += 1
              } else {
                core.warning(
                  `couldn't find package with digest ${untaggedDigest} to delete`
                )
              }
            }
          }
        }
      } else {
        core.info('skipping tag deletion, no matching tags exist')
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
          return Date.parse(b.updated_at) - Date.parse(a.updated_at)
        })

        // now delete the remainder untagged packages/images minus the keep value
        if (untaggedPackages.length > this.config.keepNuntagged) {
          untaggedPackages = untaggedPackages.splice(
            untaggedPackages.length - this.config.keepNuntagged
          )
          for (const untaggedPackage of untaggedPackages) {
            const ghPackage = this.packages.get(untaggedPackage.id)
            // get the manifest before we delete it
            const manifest = await this.registry.getRawManifest(
              untaggedPackage.name
            )
            await this.githubPackageRepo.deletePackage(
              untaggedPackage.id,
              untaggedPackage.name,
              ghPackage.metadata.container.tags
            )
            this.numberImagesDeleted += 1
            // if multi arch image now delete the platform packages/images
            const data = JSON.parse(manifest)
            if (data.manifests) {
              this.numberMultiImagesDeleted += 1
              for (const imageManifest of data.manifests) {
                const trimmedPackage = this.trimmedMultiArchPackages.get(
                  imageManifest.digest
                )
                if (trimmedPackage) {
                  await this.githubPackageRepo.deletePackage(
                    trimmedPackage.id,
                    trimmedPackage.name,
                    [`architecture ${imageManifest.platform.architecture}`]
                  )
                  this.numberImagesDeleted += 1
                }
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
          await this.githubPackageRepo.deletePackage(
            untaggedPackage.id,
            untaggedPackage.name,
            untaggedPackage.metadata.container.tags
          )
          deleted.add(untaggedPackage.name)
          this.numberImagesDeleted += 1
          this.numberMultiImagesDeleted += 1

          // if multi arch image now delete the platform packages/images
          for (const imageManifest of data.manifests) {
            const packageId = this.packageIdByDigest.get(imageManifest.digest)
            if (packageId) {
              const ghPackage = this.packages.get(packageId)
              if (ghPackage) {
                await this.githubPackageRepo.deletePackage(
                  ghPackage.id,
                  ghPackage.name,
                  [`architecture ${imageManifest.platform.architecture}`]
                )
                deleted.add(ghPackage.name)
                this.numberImagesDeleted += 1
              }
            }
          }
        }
      }
    }
    // now process the remainder
    for (const untaggedPackage of this.packages.values()) {
      if (!deleted.has(untaggedPackage.name)) {
        await this.githubPackageRepo.deletePackage(
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
      // remove the excluded tags
      for (const excludedTag of this.excludeTags) {
        const manifest = await this.registry.getRawManifest(excludedTag)
        const imageDigest = calcDigest(manifest)
        const data = JSON.parse(manifest)
        if (data.manifests) {
          await this.trimMultiArchImages(excludedTag)
        }
        const id = this.packageIdByDigest.get(imageDigest)
        if (id) {
          this.packages.delete(id)
        } else {
          core.warning(
            `couldn't find image digest ${imageDigest} in repository, skipping`
          )
        }
      }
      // create an array to sort by date
      let packagesToKeep = []
      for (const ghPackage of this.packages.values()) {
        // only copy images with tags
        if (ghPackage.metadata.container.tags.length > 0) {
          packagesToKeep.push(ghPackage)
        }
      }
      // sort them by date
      packagesToKeep.sort((a, b) => {
        return Date.parse(a.updated_at) - Date.parse(b.updated_at)
      })
      // trim to size
      if (packagesToKeep.length > this.config.keepNtagged) {
        packagesToKeep = packagesToKeep.splice(
          packagesToKeep.length - this.config.keepNtagged
        )
      }
      // now strip these from the package list
      for (const ghPackage of packagesToKeep) {
        // if multi arch delete those
        await this.trimMultiArchImages(ghPackage.name)
        this.packages.delete(ghPackage.id)
      }
    }
    await this.deletePackages()
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
          if (id) {
            this.packages.delete(id)
          } else {
            core.warning(
              `couldn't find image digest ${digest} in repository, skipping`
            )
          }
        }
        await this.deletePackages()
      }

      // print stats
      if (this.numberMultiImagesDeleted > 0) {
        core.info(
          `number of multi architecture images deleted = ${this.numberMultiImagesDeleted}`
        )
      }
      if (this.numberImagesDeleted > 0) {
        core.info(
          `total number of images deleted = ${this.numberImagesDeleted}`
        )
      }
    } catch (error) {
      // Fail the workflow run if an error occurs
      if (error instanceof Error) core.setFailed(error.message)
    }
  }
}
