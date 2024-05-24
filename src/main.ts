import * as core from '@actions/core'
import { Config, getConfig } from './config'
import { Registry } from './registry'
import { GithubPackageRepo } from './github-package'
import wcmatch from 'wildcard-match'

export async function run(): Promise<void> {
  try {
    const action = new CleanupAction()
    await action.init()
    await action.reload()
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
  packagesById = new Map<string, any>()
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
  }
  async reload(): Promise<void> {
    this.packageIdByDigest = new Map<string, string>()
    this.packagesById = new Map<string, any>()

    // get list of all the current packages
    await this.githubPackageRepo.loadPackages(
      this.packageIdByDigest,
      this.packagesById
    )
    // extract tags
    for (const ghPackage of this.packagesById.values()) {
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

  async trimMultiArchImages(digest: string): Promise<void> {
    const manifest = await this.registry.getManifestByDigest(digest)
    if (manifest.manifests) {
      for (const imageManifest of manifest.manifests) {
        // get the id and trim it as its in use
        const id = this.packageIdByDigest.get(imageManifest.digest)
        if (id) {
          // save it for later use, so don't have to reload it
          this.trimmedMultiArchPackages.set(
            imageManifest.digest,
            this.packagesById.get(id)
          )
          // now remove it
          this.packagesById.delete(id)
        }
      }
    }
  }

  // validate the multi architecture manifests
  async validate(): Promise<void> {
    core.info('validating multi architecture images:')
    // copy the loaded packages
    const digests = new Map<string, string>(this.packageIdByDigest)
    const packages = new Map<string, any>(this.packagesById)
    // cycle thru digests checking them
    let error = false
    for (const digest of digests.keys()) {
      // is the digest a multi arch image?
      const manifest = await this.registry.getManifestByDigest(digest)
      const tags = packages.get(digests.get(digest)!).metadata.container.tags
      if (manifest.manifests) {
        for (const childImage of manifest.manifests) {
          if (!digests.has(childImage.digest)) {
            error = true
            if (tags.length > 0) {
              core.warning(
                `digest ${childImage.digest} not found on image ${tags}`
              )
            } else {
              core.warning(
                `digest ${childImage.digest} not found on untagged image ${digest}`
              )
            }
          }
        }
      }
    }
    if (!error) {
      core.info(' no errors found')
    }
  }

  async deleteByTag(): Promise<void> {
    if (this.config.tags) {
      core.info(`deleting images by tags ${this.config.tags}`)
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
            // get the package
            const manifest = await this.registry.getManifestByTag(tag)
            const manifestDigest = await this.registry.getTagDigest(tag)
            const ghPackageId = this.packageIdByDigest.get(manifestDigest)
            const ghPackage = await this.githubPackageRepo.getPackage(
              ghPackageId!
            )
            // if the image only has one tag - delete it
            if (ghPackage.data.metadata.container.tags.length === 1) {
              await this.githubPackageRepo.deletePackageVersion(
                ghPackageId!,
                manifestDigest,
                ghPackage.data.metadata.container.tags
              )
              this.numberImagesDeleted += 1
              if (manifest.manifests) {
                // a multiarch image
                this.numberMultiImagesDeleted += 1
                for (const imageManifest of manifest.manifests) {
                  const imageDigest = imageManifest.digest
                  const id = this.packageIdByDigest.get(imageDigest)
                  if (id) {
                    await this.githubPackageRepo.deletePackageVersion(
                      id,
                      imageDigest,
                      [`architecture ${imageManifest.platform.architecture}`]
                    )
                    this.numberImagesDeleted += 1
                  } else {
                    core.info(
                      `image digest ${imageDigest} not found in repository, skipping`
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

              // clone the manifest
              const newManifest = JSON.parse(JSON.stringify(manifest))

              // create a fake manifest to seperate the tag
              if (newManifest.manifests) {
                // a multi architecture image
                newManifest.manifests = []
                await this.registry.putManifest(tag, newManifest, true)
              } else {
                newManifest.layers = []
                await this.registry.putManifest(tag, newManifest, false)
              }
              // the tag will have a new digest now so delete the cached version
              this.registry.deleteTag(tag)

              // reload package ids to find the new package id
              const reloadPackageByDigest = new Map<string, string>()
              const githubPackages = new Map<string, any>()
              await this.githubPackageRepo.loadPackages(
                reloadPackageByDigest,
                githubPackages
              )
              // reload the manifest
              const untaggedDigest = await this.registry.getTagDigest(tag)
              const id = reloadPackageByDigest.get(untaggedDigest)
              if (id) {
                await this.githubPackageRepo.deletePackageVersion(
                  id,
                  untaggedDigest,
                  [tag]
                )
                this.numberImagesDeleted += 1
              } else {
                core.info(
                  `couldn't find newly created package with digest ${untaggedDigest} to delete`
                )
              }
            }
          }
        }
      }
    }
  }

  async isGhostImage(digest: string): Promise<boolean> {
    let ghostImage = false
    // is a ghost image if all of the child manifests dont exist
    const manfiest = await this.registry.getManifestByDigest(digest)
    if (manfiest.manifests) {
      let missing = 0
      for (const imageManfiest of manfiest.manifests) {
        if (!this.packageIdByDigest.get(imageManfiest.digest)) {
          missing += 1
        }
      }
      if (missing === manfiest.manifests.length) {
        ghostImage = true
      }
    }
    return ghostImage
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
          this.packagesById.delete(id)
          this.packageIdByDigest.delete(digest)
        }
      }
      // now remove the untagged images left in the packages list
      if (this.packageIdByDigest.size > 0) {
        // remove multi architecture images - only count the manifest list image
        // and trim manifests which have no children
        const ghostImages = []
        for (const digest of this.packageIdByDigest.keys()) {
          if (await this.isGhostImage(digest)) {
            // save it to add back
            ghostImages.push(
              this.packagesById.get(this.packageIdByDigest.get(digest)!)
            )
            // remove it from later untaggedPackages sort
            this.packagesById.delete(this.packageIdByDigest.get(digest)!)
          }
          await this.trimMultiArchImages(digest)
        }
        // now sort the remaining packages by date
        let untaggedPackages = [...this.packagesById.values()]
        untaggedPackages.sort((a, b) => {
          return Date.parse(b.updated_at) - Date.parse(a.updated_at)
        })
        // add back ghost images to be deleted
        untaggedPackages = [...ghostImages, ...untaggedPackages]

        // now delete the remainder untagged packages/images minus the keep value
        if (untaggedPackages.length > this.config.keepNuntagged) {
          untaggedPackages = untaggedPackages.splice(this.config.keepNuntagged)
          for (const untaggedPackage of untaggedPackages) {
            const ghPackage = this.packagesById.get(untaggedPackage.id)
            // get the manifest before we delete it
            const manifest = await this.registry.getManifestByDigest(
              untaggedPackage.name
            )
            await this.githubPackageRepo.deletePackageVersion(
              untaggedPackage.id,
              untaggedPackage.name,
              ghPackage.metadata.container.tags
            )
            this.numberImagesDeleted += 1
            // if multi arch image now delete the platform packages/images
            if (manifest.manifests) {
              this.numberMultiImagesDeleted += 1
              for (const imageManifest of manifest.manifests) {
                const trimmedPackage = this.trimmedMultiArchPackages.get(
                  imageManifest.digest
                )
                if (trimmedPackage) {
                  await this.githubPackageRepo.deletePackageVersion(
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
      }
    }
  }

  async deletePackages(): Promise<void> {
    // process deletion in 2 iterations to delete multi images first
    const deleted = new Set<string>()
    for (const untaggedPackage of this.packagesById.values()) {
      if (!deleted.has(untaggedPackage.name)) {
        // get the manifest before we delete it
        const manifest = await this.registry.getManifestByDigest(
          untaggedPackage.name
        )
        if (manifest.manifests) {
          await this.githubPackageRepo.deletePackageVersion(
            untaggedPackage.id,
            untaggedPackage.name,
            untaggedPackage.metadata.container.tags
          )
          deleted.add(untaggedPackage.name)
          this.numberImagesDeleted += 1
          this.numberMultiImagesDeleted += 1

          // if multi arch image now delete the platform packages/images
          for (const imageManifest of manifest.manifests) {
            const packageId = this.packageIdByDigest.get(imageManifest.digest)
            if (packageId) {
              const ghPackage = this.packagesById.get(packageId)
              if (ghPackage) {
                await this.githubPackageRepo.deletePackageVersion(
                  ghPackage.id,
                  ghPackage.name,
                  [`architecture ${imageManifest.platform.architecture}`]
                )
                deleted.add(ghPackage.name)
                this.numberImagesDeleted += 1
              }
            } else {
              core.info(
                `image digest ${imageManifest.digest} not found in repository, skipping`
              )
            }
          }
        }
      }
    }
    // now process the remainder
    for (const untaggedPackage of this.packagesById.values()) {
      if (!deleted.has(untaggedPackage.name)) {
        await this.githubPackageRepo.deletePackageVersion(
          untaggedPackage.id,
          untaggedPackage.name,
          untaggedPackage.metadata.container.tags
        )
        deleted.add(untaggedPackage.name)
        this.numberImagesDeleted += 1
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
        const imageDigest = await this.registry.getTagDigest(excludedTag)
        const manifest = await this.registry.getManifestByTag(excludedTag)
        if (manifest.manifests) {
          await this.trimMultiArchImages(excludedTag)
        }
        const id = this.packageIdByDigest.get(imageDigest)
        if (id) {
          this.packagesById.delete(id)
          this.packageIdByDigest.delete(imageDigest)
        } else {
          core.info(
            `image digest ${imageDigest} not found in repository, skipping`
          )
        }
      }
      // create an array to sort by date
      let packagesToKeep = []
      for (const digest of this.packageIdByDigest.keys()) {
        // only copy images with tags and not ghost images
        if (!(await this.isGhostImage(digest))) {
          const ghPackage = this.packagesById.get(
            this.packageIdByDigest.get(digest)!
          )
          if (ghPackage.metadata.container.tags.length > 0) {
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
        packagesToKeep = packagesToKeep.splice(
          packagesToKeep.length - this.config.keepNtagged
        )
      }
      // now strip these from the package list
      for (const ghPackage of packagesToKeep) {
        // if multi arch delete those
        await this.trimMultiArchImages(ghPackage.name)
        this.packagesById.delete(ghPackage.id)
      }
    }
    await this.deletePackages()
  }

  async run(): Promise<void> {
    try {
      if (this.config.tags) {
        await this.deleteByTag()
        await this.reload()
      }

      // value 0 will be treated as boolean
      if (this.config.keepNuntagged) {
        // we are in the cleanup untagged images mode
        await this.keepNuntagged()
      } else if (this.config.keepNtagged != null) {
        // we are in the cleanup tagged images mode
        await this.keepNtagged()
      } else if (!this.config.tags) {
        // in deleting all untagged images
        core.info('deleting all untagged images')
        // get all the tagged digests from the containter registry
        const inUseDigests = await this.registry.getAllTagDigests()
        // remove these from the saved packages list
        for (const digest of inUseDigests) {
          const id = this.packageIdByDigest.get(digest)
          if (id) {
            this.packagesById.delete(id)
          } else {
            core.info(
              `couldn't find image digest ${digest} in repository, skipping`
            )
          }
        }
        await this.deletePackages()
      }

      if (this.config.validate) {
        await this.reload()
        await this.validate()
      }

      core.info('cleanup statistics:')
      // print stats
      if (this.numberMultiImagesDeleted > 0) {
        core.info(
          ` multi architecture images deleted = ${this.numberMultiImagesDeleted}`
        )
      }
      core.info(` total images deleted = ${this.numberImagesDeleted}`)
    } catch (error) {
      // Fail the workflow run if an error occurs
      if (error instanceof Error) core.setFailed(error.message)
    }
  }
}
