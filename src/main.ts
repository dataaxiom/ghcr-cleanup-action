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
  childInUsePackages = new Map<string, any>() // by id
  tagsInUse = new Set<string>()
  deleted = new Set<string>()
  childInUsePackages = new Map<string, any>() // by id
  tagsInUse = new Set<string>()
  deleted = new Set<string>()

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
    this.childInUsePackages = new Map<string, any>()
    this.tagsInUse = new Set<string>()
    this.deleted = new Set<string>()

    // get list of all the current packages
    await this.githubPackageRepo.loadPackages(
      this.packageIdByDigest,
      this.packagesById
    )
    // extract tags
    for (const ghPackage of this.packagesById.values()) {
      for (const tag of ghPackage.metadata.container.tags) {
        this.tagsInUse.add(tag)
        this.tagsInUse.add(tag)
      }
    }
    // find exclude tags using matcher
    if (this.config.excludeTags) {
      const isTagMatch = wcmatch(this.config.excludeTags.split(','))
      for (const tag of this.tagsInUse) {
      for (const tag of this.tagsInUse) {
        if (isTagMatch(tag)) {
          this.excludeTags.push(tag)
        }
      }
    }
  }

  movePackageToChildList(digest: string) {
    // get the id and trim it as it's in use
    const id = this.packageIdByDigest.get(digest)
    if (id) {
      // save it as a child
      if (this.packagesById.get(id)) {
        this.childInUsePackages.set(id, this.packagesById.get(id))
        // now remove it
        this.packagesById.delete(id)
      }
    }
  }

  // move 'child' packages from main package list to the separate child list
  async trimChildPackages(digest: string): Promise<void> {
    // only process digests not already moved
    const packageId = this.packageIdByDigest.get(digest)
    if (packageId && !this.childInUsePackages.has(packageId)) {
      const manifest = await this.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          // get the id and trim it as it's in use
          this.movePackageToChildList(imageManifest.digest)
        }
      }
      // process any referrers - OCI v1 via tag currently
      const referrerTag = digest.replace('sha256:', 'sha256-')
      if (
        this.tagsInUse.has(referrerTag) &&
        !this.excludeTags.includes(referrerTag)
      ) {
        // find the package and move it and it's children to the childInUsePackages
        const referrerDigest = await this.registry.getTagDigest(referrerTag)
        this.movePackageToChildList(referrerDigest)
        const referrerManifest =
          await this.registry.getManifestByTag(referrerTag)
        if (referrerManifest.manifests) {
          for (const manifestEntry of referrerManifest.manifests) {
            // get the id and trim it as it's in use
            this.movePackageToChildList(manifestEntry.digest)
          }
        }
      }
    }
  }

  // validate manifests list packages
  // validate manifests list packages
  async validate(): Promise<void> {
    core.info('validating multi-architecture/referrers images:')
    // copy the loaded packages
    const digests = new Map<string, string>(this.packageIdByDigest)
    const packages = new Map<string, any>(this.packagesById)
    // cycle thru digests checking them
    let error = false
    const processedManifests = new Set<string>()
    const processedManifests = new Set<string>()
    for (const digest of digests.keys()) {
      // is the digest a multi arch image?
      if (!processedManifests.has(digest)) {
        const manifest = await this.registry.getManifestByDigest(digest)
        const tags = packages.get(digests.get(digest)!).metadata.container.tags
        if (manifest.manifests) {
          for (const childImage of manifest.manifests) {
            // mark it as processed
            processedManifests.add(childImage.digest)
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
    }
    // check for orphaned referrers tags
    for (const tag of this.tagsInUse) {
      if (tag.startsWith('sha256-')) {
        const digest = tag.replace('sha256-', 'sha256:')
        if (!this.packageIdByDigest.get(digest)) {
          error = true
          core.warning(
            `parent image for referrer tag ${tag} not found in repository`
          )
        }
      }
    }
    if (!error) {
      core.info(' no errors found')
    }
  }

  buildLabel(imageManifest: any): string {
    // build the 'label'
    let label = ''
    if (imageManifest.platform) {
      if (imageManifest.platform.architecture) {
        label = imageManifest.platform.architecture
      }
      if (imageManifest.platform.variant) {
        label += `/${imageManifest.platform.variant}`
      }
      label = `architecture: ${label}`
    } else if (imageManifest.artifactType) {
      // check if it's a attestation
      if (
        imageManifest.artifactType.startsWith(
          'application/vnd.dev.sigstore.bundle'
        )
      ) {
        label = 'sigstore attestation'
      }
    }
    return label
  }

  async deleteImage(ghPackage: any): Promise<void> {
    if (!this.deleted.has(ghPackage.name)) {
      // get the manifest first
      const manifest = await this.registry.getManifestByDigest(ghPackage.name)

      // now delete it
      await this.githubPackageRepo.deletePackageVersion(
        ghPackage.id,
        ghPackage.name,
        ghPackage.metadata.container.tags
      )
      this.deleted.add(ghPackage.name)
      this.numberImagesDeleted += 1

      // if manifest list image now delete the children
      if (manifest.manifests) {
        this.numberMultiImagesDeleted += 1
        for (const imageManifest of manifest.manifests) {
          const packageId = this.packageIdByDigest.get(imageManifest.digest)
          if (packageId) {
            const manifestPackage = this.childInUsePackages.get(packageId)
            if (manifestPackage) {
              await this.githubPackageRepo.deletePackageVersion(
                manifestPackage.id,
                manifestPackage.name,
                [],
                this.buildLabel(imageManifest)
              )
              this.deleted.add(manifestPackage.name)
              this.numberImagesDeleted += 1
            } else {
              core.setFailed(
                `something went wrong - can't find the manifest  ${imageManifest.digest}`
              )
            }
          } else {
            core.info(
              ` image digest ${imageManifest.digest} not found in repository, skipping`
            )
          }
        }
      }

      // process any referrers manifests - using tag approach
      const attestationTag = ghPackage.name.replace('sha256:', 'sha256-')
      if (
        this.tagsInUse.has(attestationTag) &&
        !this.excludeTags.includes(attestationTag)
      ) {
        // find the package
        const manifestDigest = await this.registry.getTagDigest(attestationTag)
        const attestationPackage = this.getPackageByDigest(manifestDigest)
        // recursively delete it
        await this.deleteImage(attestationPackage)
      }
    }
  }

  getPackageByDigest(digest: string): any {
    let ghPackage
    const id = this.packageIdByDigest.get(digest)
    if (id) {
      ghPackage = this.packagesById.get(id)
      if (!ghPackage) {
        ghPackage = this.childInUsePackages.get(id)
      }
    }
    return ghPackage
  }

  async deleteByTag(): Promise<void> {
    if (this.config.tags) {
      core.info(`deleting images by tags ${this.config.tags}`)
      // find the tags the match wildcard patterns
      const isTagMatch = wcmatch(this.config.tags.split(','))
      const matchTags = []
      for (const tag of this.tagsInUse) {
      for (const tag of this.tagsInUse) {
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
            const ghPackage = this.getPackageByDigest(manifestDigest)
            const ghPackage = this.getPackageByDigest(manifestDigest)
            // if the image only has one tag - delete it
            if (ghPackage.metadata.container.tags.length === 1) {
              // deleteImage function works from child list so trim first
              await this.trimChildPackages(manifestDigest)
              await this.deleteImage(ghPackage)
            if (ghPackage.metadata.container.tags.length === 1) {
              // deleteImage function works from child list so trim first
              await this.trimChildPackages(manifestDigest)
              await this.deleteImage(ghPackage)
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
          await this.trimChildPackages(digest)
          await this.trimChildPackages(digest)
          this.packagesById.delete(id)
          this.packageIdByDigest.delete(digest)
        }
      }
      // now remove the untagged images left in the packages list
      if (this.packageIdByDigest.size > 0) {
        // remove multi/referrer images - only count the manifest list image
        // remove multi/referrer images - only count the manifest list image
        // and trim manifests which have no children
        const ghostImages = []
        for (const digest of this.packageIdByDigest.keys()) {
          await this.trimChildPackages(digest)
          await this.trimChildPackages(digest)
          if (await this.isGhostImage(digest)) {
            // save it to add back
            ghostImages.push(this.getPackageByDigest(digest))

            ghostImages.push(this.getPackageByDigest(digest))

            // remove it from later untaggedPackages sort
            this.packagesById.delete(this.packageIdByDigest.get(digest)!)
          }
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
            await this.deleteImage(ghPackage)
            await this.deleteImage(ghPackage)
          }
        }
      }
    }
  }

  async deleteRemainingPackages(): Promise<void> {
    // process deletion in 2 iterations
    // delete manifest list images first
    for (const ghPackage of this.packagesById.values()) {
      if (!this.deleted.has(ghPackage.name)) {
        const manifest = await this.registry.getManifestByDigest(ghPackage.name)
  async deleteRemainingPackages(): Promise<void> {
    // process deletion in 2 iterations
    // delete manifest list images first
    for (const ghPackage of this.packagesById.values()) {
      if (!this.deleted.has(ghPackage.name)) {
        const manifest = await this.registry.getManifestByDigest(ghPackage.name)
        if (manifest.manifests) {
          await this.deleteImage(ghPackage)
          await this.deleteImage(ghPackage)
        }
      }
    }
    // now process the remainder
    for (const ghPackage of this.packagesById.values()) {
      if (!this.deleted.has(ghPackage.name)) {
        await this.deleteImage(ghPackage)
    for (const ghPackage of this.packagesById.values()) {
      if (!this.deleted.has(ghPackage.name)) {
        await this.deleteImage(ghPackage)
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
        await this.trimChildPackages(imageDigest)
        await this.trimChildPackages(imageDigest)
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

      // trim all the child packages

      // trim all the child packages
      for (const digest of this.packageIdByDigest.keys()) {
        await this.trimChildPackages(digest)
      }
      // only copy images with tags and not ghost images
      for (const ghPackage of this.packagesById.values()) {
        if (!(await this.isGhostImage(ghPackage.name))) {
        await this.trimChildPackages(digest)
      }
      // only copy images with tags and not ghost images
      for (const ghPackage of this.packagesById.values()) {
        if (!(await this.isGhostImage(ghPackage.name))) {
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
        this.packagesById.delete(ghPackage.id)
      }
    }
    await this.deleteRemainingPackages()
    await this.deleteRemainingPackages()
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
            await this.trimChildPackages(digest)
            await this.trimChildPackages(digest)
            this.packagesById.delete(id)
          } else {
            core.info(
              `couldn't find image digest ${digest} in repository, skipping`
            )
          }
        }
        // now trim child packages from the remaining untagged images
        for (const ghPackage of this.packagesById.values()) {
          await this.trimChildPackages(ghPackage.name)
        }
        await this.deleteRemainingPackages()
        // now trim child packages from the remaining untagged images
        for (const ghPackage of this.packagesById.values()) {
          await this.trimChildPackages(ghPackage.name)
        }
        await this.deleteRemainingPackages()
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
