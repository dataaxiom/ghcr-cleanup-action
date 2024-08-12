import * as core from '@actions/core'
import { Config, getConfig } from './config.js'
import { Registry } from './registry.js'
import { GithubPackageRepo } from './github-package.js'
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
  // The action configuration
  config: Config

  // tags which should be excluded from deletion
  excludeTags: string[] = []

  // used to interact with the container registry api
  registry: Registry

  // used to interact with the github package api
  githubPackageRepo: GithubPackageRepo

  // working set of package digests to process filters/keeps options on
  filterSet = new Set<string>()

  // digests to delete
  deleteSet = new Set<string>()

  // all the tags in use in the registry
  tagsInUse = new Set<string>()

  // mapping child digests to parent digests
  digestUsedBy = new Map<string, Set<string>>()

  // digests which have been deleted
  deleted = new Set<string>()

  // action stats
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
    this.deleteSet.clear()
    this.deleted.clear()

    // prime the list of current packages
    await this.githubPackageRepo.loadPackages()
    // extract values from the load
    this.filterSet = this.githubPackageRepo.getDigests()
    this.tagsInUse = this.githubPackageRepo.getTags()

    // build digestUsedBy map
    await this.loadDigestUsedByMap()

    // remove children from filterSet - manifest image children, refferers
    await this.trimChildren()

    // find excluded tags using matcher
    this.excludeTags = []
    if (this.config.excludeTags) {
      const isTagMatch = wcmatch(this.config.excludeTags.split(','))
      for (const tag of this.tagsInUse) {
        if (isTagMatch(tag)) {
          // delete the tag from the filterSet
          const digest = this.githubPackageRepo.getDigestByTag(tag)
          if (digest) {
            this.filterSet.delete(digest)
          }
          this.excludeTags.push(tag)
        }
      }
    }
  }

  /*
   * Builds a map child images back to their parents
   * The map is used to determine if image can be safely deleted
   */
  async loadDigestUsedByMap(): Promise<void> {
    this.digestUsedBy.clear()

    const digests = this.githubPackageRepo.getDigests()
    for (const digest of digests) {
      const manifest = await this.registry.getManifestByDigest(digest)
      // we only map multi-arch images
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          // only add existing packages
          if (digests.has(imageManifest.digest)) {
            let parents = this.digestUsedBy.get(imageManifest.digest)
            if (!parents) {
              parents = new Set<string>()
              this.digestUsedBy.set(imageManifest.digest, parents)
            }
            parents.add(digest)
          }
        }
      }
    }
  }

  /*
   * Remove all multi architecture platform images from the filterSet it's including
   * refferrer image if present. Filting/processing occurs on  top level images.
   */
  async trimChildren(): Promise<void> {
    const digests = this.githubPackageRepo.getDigests()
    for (const digest of digests) {
      const manifest = await this.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          if (digests.has(imageManifest.digest)) {
            this.filterSet.delete(imageManifest.digest)
          }
        }
      }
      // process any referrers - OCI v1 via tag currently
      const referrerTag = digest.replace('sha256:', 'sha256-')
      if (
        this.tagsInUse.has(referrerTag) &&
        !this.excludeTags.includes(referrerTag)
      ) {
        // find the digest and children and remove them
        const referrerDigest = await this.registry.getTagDigest(referrerTag)
        this.filterSet.delete(referrerDigest)
        const referrerManifest =
          await this.registry.getManifestByTag(referrerTag)
        if (referrerManifest.manifests) {
          for (const manifestEntry of referrerManifest.manifests) {
            if (digests.has(manifestEntry.digest)) {
              // get the id and trim it as it's in use
              this.filterSet.delete(manifestEntry.digest)
            }
          }
        }
      }
    }
  }

  // validate manifests list packages
  async validate(): Promise<void> {
    core.info('validating multi-architecture/referrers images:')
    // cycle thru digests checking them
    let error = false
    const processedManifests = new Set<string>()
    for (const digest of this.githubPackageRepo.getDigests()) {
      // is the digest a multi arch image?
      if (!processedManifests.has(digest)) {
        const manifest = await this.registry.getManifestByDigest(digest)
        const tags =
          this.githubPackageRepo.getPackageByDigest(digest).metadata.container
            .tags
        if (manifest.manifests) {
          for (const childImage of manifest.manifests) {
            // mark it as processed
            processedManifests.add(childImage.digest)
            if (!this.githubPackageRepo.getIdByDigest(childImage.digest)) {
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
        if (!this.githubPackageRepo.getIdByDigest(digest)) {
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

  async buildLabel(imageManifest: any): Promise<string> {
    // build the 'label'
    let label = ''
    if (imageManifest.platform) {
      if (imageManifest.platform.architecture) {
        label = imageManifest.platform.architecture
      }
      if (label !== 'unknown') {
        if (imageManifest.platform.variant) {
          label += `/${imageManifest.platform.variant}`
        }
        label = `architecture: ${label}`
      } else {
        // check if it's a buildx attestation
        const manifest = await this.registry.getManifestByDigest(
          imageManifest.digest
        )
        // kinda crude
        if (manifest.layers) {
          if (manifest.layers[0].mediaType === 'application/vnd.in-toto+json') {
            label = 'application/vnd.in-toto+json'
          }
        }
      }
    } else if (imageManifest.artifactType) {
      // check if it's a github attestation
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

      // if manifest based image now delete it's children
      if (manifest.manifests) {
        this.numberMultiImagesDeleted += 1
        for (const imageManifest of manifest.manifests) {
          const manifestPackage = this.githubPackageRepo.getPackageByDigest(
            imageManifest.digest
          )
          if (manifestPackage) {
            if (!this.deleted.has(manifestPackage.name)) {
              // check if the digest isn't in use by another image
              const parents = this.digestUsedBy.get(manifestPackage.name)
              if (parents) {
                if (parents.size === 1 && parents.has(ghPackage.name)) {
                  // it's only referenced from this image so delete it
                  await this.githubPackageRepo.deletePackageVersion(
                    manifestPackage.id,
                    manifestPackage.name,
                    [],
                    await this.buildLabel(imageManifest)
                  )
                  this.deleted.add(manifestPackage.name)
                  this.numberImagesDeleted += 1
                } else {
                  core.info(
                    ` skipping deletion of ${ghPackage.name} as it's in use by another image`
                  )
                  // skip the deletion since it's in use by another image - just remove the usedBy reference
                  parents.delete(ghPackage.name)
                }
              } else {
                // should never be here
                core.info(
                  ` digestUsedBy not correctly setup for ${manifestPackage.name}`
                )
              }
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
        const attestationPackage =
          this.githubPackageRepo.getPackageByDigest(manifestDigest)
        // recursively delete it
        await this.deleteImage(attestationPackage)
      }
    }
  }

  async deleteByTag(): Promise<void> {
    if (this.config.deleteTags) {
      core.info(`deleting tagged images: ${this.config.deleteTags}`)
      // find the tags the match wildcard patterns
      const isTagMatch = wcmatch(this.config.deleteTags.split(','))
      const matchTags = []
      // build match list from filterSet
      for (const digest of this.filterSet) {
        const ghPackage = this.githubPackageRepo.getPackageByDigest(digest)
        for (const tag of ghPackage.metadata.container.tags) {
          if (isTagMatch(tag)) {
            matchTags.push(tag)
          }
        }
      }
      if (matchTags.length > 0) {
        core.info(` found matching images to delete: ${matchTags}`)

        for (const tag of matchTags) {
          if (!this.excludeTags.includes(tag)) {
            // get the package
            const manifest = await this.registry.getManifestByTag(tag)
            const manifestDigest = await this.registry.getTagDigest(tag)
            const ghPackage =
              this.githubPackageRepo.getPackageByDigest(manifestDigest)
            // if the image only has one tag - delete it
            if (ghPackage.metadata.container.tags.length === 1) {
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
              await this.githubPackageRepo.loadPackages()

              // reload the manifest
              const untaggedDigest = await this.registry.getTagDigest(tag)
              const id = this.githubPackageRepo.getIdByDigest(untaggedDigest)
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

  async deleteGhostImages(): Promise<void> {
    for (const digest of this.filterSet) {
      let ghostImage = false
      // is a ghost image if all of the child manifests dont exist
      const manfiest = await this.registry.getManifestByDigest(digest)
      if (manfiest.manifests) {
        let missing = 0
        for (const imageManfiest of manfiest.manifests) {
          if (!this.githubPackageRepo.getIdByDigest(imageManfiest.digest)) {
            missing += 1
          }
        }
        if (missing === manfiest.manifests.length) {
          ghostImage = true
        }
      }
      if (ghostImage) {
        // setup the ghost image to be deleted
        core.info(
          `image ${digest} is cued up for deletion as it doesn't contain any of it's platform images`
        )
        this.filterSet.delete(digest)
        this.deleteSet.add(digest)
      }
    }
  }

  async deletePartialImages(): Promise<void> {
    for (const digest of this.filterSet) {
      let partialImage = false
      // is a partial image if some of the child manifests dont exist
      const manfiest = await this.registry.getManifestByDigest(digest)
      if (manfiest.manifests) {
        for (const imageManfiest of manfiest.manifests) {
          if (!this.githubPackageRepo.getIdByDigest(imageManfiest.digest)) {
            partialImage = true
            break
          }
        }
      }
      if (partialImage) {
        // setup the partial image to be deleted
        core.info(
          `image ${digest} is cued up for deletion as it doesn't contain all of it's platform images`
        )
        this.filterSet.delete(digest)
        this.deleteSet.add(digest)
      }
    }
  }

  async keepNuntagged(): Promise<void> {
    if (this.config.keepNuntagged && this.config.keepNuntagged !== 0) {
      core.info(
        `deleting untagged images, keeping ${this.config.keepNuntagged} versions`
      )

      // create a temporary array of untagged images to process on
      const unTaggedPackages = []

      // find untagged images in the filterSet
      for (const digest of this.filterSet) {
        const ghPackage = this.githubPackageRepo.getPackageByDigest(digest)
        if (ghPackage.metadata.container.tags.length === 0) {
          unTaggedPackages.push(ghPackage)
        }
      }

      // now sort and remove extra untagged images
      if (unTaggedPackages.length > 0) {
        // sort descending
        unTaggedPackages.sort((a, b) => {
          return Date.parse(b.updated_at) - Date.parse(a.updated_at)
        })

        // now delete the remainder untagged packages/images minus the keep value
        if (unTaggedPackages.length > this.config.keepNuntagged) {
          const deletePackages = unTaggedPackages.splice(
            this.config.keepNuntagged
          )
          for (const deletePackage of deletePackages) {
            this.deleteSet.add(deletePackage.name)
            this.filterSet.delete(deletePackage.name)
          }
        }
      }
    }
  }

  async delete(): Promise<void> {
    // now delete the images
    for (const deleteDigest of this.deleteSet) {
      const deleteImage =
        this.githubPackageRepo.getPackageByDigest(deleteDigest)
      await this.deleteImage(deleteImage)
    }
  }

  async keepNtagged(): Promise<void> {
    if (this.config.keepNtagged != null) {
      core.info(
        `deleting tagged images, keeping ${this.config.keepNtagged} versions`
      )

      // create a temporary array of tagged images to process on
      const taggedPackages = []

      // only copy images with tags
      for (const digest of this.filterSet) {
        const ghPackage = this.githubPackageRepo.getPackageByDigest(digest)
        if (ghPackage.metadata.container.tags.length > 0) {
          taggedPackages.push(ghPackage)
        }
      }
      // sort descending
      taggedPackages.sort((a, b) => {
        return Date.parse(b.updated_at) - Date.parse(a.updated_at)
      })
      // trim packages to keep and delete the remainder
      if (taggedPackages.length > this.config.keepNtagged) {
        const deletePackages = taggedPackages.splice(this.config.keepNtagged)
        // now set these up to be deleted
        for (const deletePackage of deletePackages) {
          this.deleteSet.add(deletePackage.name)
          this.filterSet.delete(deletePackage.name)
        }
      }
    }
  }

  async deleteUntagged(): Promise<void> {
    core.info('deleting all untagged images')

    // find untagged images in the filterSet
    for (const digest of this.filterSet) {
      const ghPackage = this.githubPackageRepo.getPackageByDigest(digest)
      if (ghPackage.metadata.container.tags.length === 0) {
        this.deleteSet.add(ghPackage.name)
        // not currently removing from filterSet (in loop)
      }
    }
  }

  async run(): Promise<void> {
    try {
      // process tag deletions first - to support untagging
      if (this.config.deleteTags) {
        await this.deleteByTag()
        await this.reload()
      }

      if (this.config.deleteGhostImages) {
        await this.deleteGhostImages()
      }
      if (this.config.deletePartialImages) {
        await this.deletePartialImages()
      }

      if (this.config.keepNtagged != null) {
        // we are in the cleanup tagged images mode
        await this.keepNtagged()
      }

      // value 0 will be treated as boolean
      if (this.config.keepNuntagged) {
        // we are in the cleanup untagged images mode
        await this.keepNuntagged()
      } else if (this.config.deleteUntagged) {
        // delete all untagged images
        await this.deleteUntagged()
      }

      // now preform the actual deletion
      await this.delete()

      if (this.config.validate) {
        await this.reload()
        await this.validate()
      }

      core.info('cleanup statistics:')
      // print action statistics
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
