import * as core from '@actions/core'
import { Config, LogLevel } from './config.js'
import { Registry } from './registry.js'
import { PackageRepo } from './package-repo.js'
import wcmatch from 'wildcard-match'
import { CleanupTaskStatistics } from './utils.js'

export class CleanupTask {
  // The action configuration
  config: Config

  // The package repository to cleanup
  targetPackage: string

  // tags which should be excluded from deletion
  excludeTags: string[] = []

  // used to interact with the container registry api
  registry: Registry

  // used to interact with the github package api
  packageRepo: PackageRepo

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

  // action statistics
  statistics: CleanupTaskStatistics

  constructor(config: Config, targetPackage: string) {
    this.config = config
    this.targetPackage = targetPackage
    this.packageRepo = new PackageRepo(this.config)
    this.registry = new Registry(this.config, this.packageRepo)
    this.statistics = new CleanupTaskStatistics(this.targetPackage, 0, 0)
  }

  async init(): Promise<void> {
    await this.registry.login(this.targetPackage)
  }

  async reload(): Promise<void> {
    this.deleteSet.clear()
    this.deleted.clear()

    // prime the list of current packages
    await this.packageRepo.loadPackages(this.targetPackage, true)
    // extract tags from the package load
    this.tagsInUse = this.packageRepo.getTags()

    // build digestUsedBy map
    await this.loadDigestUsedByMap()

    // init filterSet - removed manifest image children, referrers etc
    await this.initFilterSet()

    // find excluded tags using regex or matcher
    this.excludeTags = []
    if (this.config.excludeTags) {
      if (this.config.useRegex) {
        const regex = new RegExp(this.config.excludeTags)
        for (const tag of this.tagsInUse) {
          if (regex.test(tag)) {
            // delete the tag from the filterSet
            const digest = this.packageRepo.getDigestByTag(tag)
            if (digest) {
              this.filterSet.delete(digest)
            }
            this.excludeTags.push(tag)
          }
        }
      } else {
        const isTagMatch = wcmatch(this.config.excludeTags.split(','))
        for (const tag of this.tagsInUse) {
          if (isTagMatch(tag)) {
            // delete the tag from the filterSet
            const digest = this.packageRepo.getDigestByTag(tag)
            if (digest) {
              this.filterSet.delete(digest)
            }
            this.excludeTags.push(tag)
          }
        }
      }
    }
    if (this.excludeTags.length > 0) {
      core.startGroup(`[${this.targetPackage}] Excluding tags from deletion`)
      for (const tag of this.excludeTags) {
        core.info(tag)
      }
      core.endGroup()
    }

    // only include older-than if set
    if (this.config.olderThan) {
      // get the package
      core.startGroup(
        `[${this.targetPackage}] Finding images that are older than: ${this.config.olderThanReadable}`
      )
      for (const digest of this.filterSet) {
        const ghPackage = this.packageRepo.getPackageByDigest(digest)
        if (ghPackage.updated_at) {
          const cutOff = new Date(Date.now() - this.config.olderThan)
          const packageDate = new Date(ghPackage.updated_at)
          if (packageDate >= cutOff) {
            // the package it newer then cutoff so remove it from filterSet
            this.filterSet.delete(digest)
          } else {
            const tags =
              this.packageRepo.getPackageByDigest(digest).metadata.container
                .tags
            if (tags.length > 0) {
              core.info(`${digest} ${tags}`)
            } else {
              core.info(digest)
            }
          }
        }
      }
      if (this.filterSet.size === 0) {
        core.info('no images found')
      }
      core.endGroup()
    }
  }

  /*
   * Builds a map child images back to their parents
   * The map is used to determine if image can be safely deleted
   */
  async loadDigestUsedByMap(): Promise<void> {
    this.digestUsedBy.clear()
    let stopWatch = new Date()
    const digests = this.packageRepo.getDigests()
    const digestCount = digests.size
    let processed = 0
    let skipped = 0

    core.startGroup(`[${this.targetPackage}] Loading manifests`)
    for (const digest of digests) {
      const manifest = await this.registry.getManifestByDigest(digest)
      processed++
      if (this.config.logLevel === LogLevel.DEBUG) {
        const encoded = JSON.stringify(manifest, null, 4)
        core.info(`${digest}:${encoded}`)
      } else {
        // output a status message if 3 seconds has passed
        const now = new Date()
        if (now.getMilliseconds() - stopWatch.getMilliseconds() >= 3000) {
          core.info(`loaded ${processed} of ${digestCount} manifests`)
          stopWatch = new Date() // reset the clock
        }
      }

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

            // now remove so we don't download the child manifest later on in loop
            digests.delete(imageManifest.digest)
            skipped++
            processed++
          }
        }
      }
    }
    core.info(`loaded ${processed} manifests, ${skipped} skipped`)
    core.endGroup()
  }

  /*
   * Remove all multi architecture platform images from the filterSet including its
   * referrer image if present. Filtering/processing only occurs on top level images.
   */
  async initFilterSet(): Promise<void> {
    const digests = this.packageRepo.getDigests()
    for (const digest of digests) {
      const manifest = await this.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          digests.delete(imageManifest.digest)
        }
      }

      // process any associated images which have been tagged using the digest
      const digestTag = digest.replace('sha256:', 'sha256-')
      const tags = this.packageRepo.getTags()
      for (const tag of tags) {
        if (tag.startsWith(digestTag)) {
          // remove it
          const tagDigest = this.packageRepo.getDigestByTag(tag)
          if (tagDigest) {
            digests.delete(tagDigest)
            // process any children
            const childManifest = await this.registry.getManifestByTag(tag)
            if (childManifest.manifests) {
              for (const manifestEntry of childManifest.manifests) {
                digests.delete(manifestEntry.digest)
              }
            }
          }
        }
      }
    }

    // save digests to filterSet
    this.filterSet = digests
  }

  // validate manifests list packages
  async validate(): Promise<void> {
    core.startGroup(
      `[${this.targetPackage}] Validating multi-architecture/referrers images`
    )
    // cycle thru digests checking them
    let error = false
    const processedManifests = new Set<string>()
    const digests = this.packageRepo.getDigests()
    for (const digest of digests) {
      // is the digest a multi arch image?
      if (!processedManifests.has(digest)) {
        const manifest = await this.registry.getManifestByDigest(digest)
        const tags =
          this.packageRepo.getPackageByDigest(digest).metadata.container.tags
        if (manifest.manifests) {
          for (const childImage of manifest.manifests) {
            // mark it as processed
            processedManifests.add(childImage.digest)
            if (!this.packageRepo.getIdByDigest(childImage.digest)) {
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
            // remove it from further processing - we don't need to validate child manifests
            digests.delete(childImage.digest)
          }
        }
      }
    }
    // check for orphaned tags (referrers/cosign etc)
    for (const tag of this.tagsInUse) {
      if (tag.startsWith('sha256-')) {
        let digest = tag.replace('sha256-', 'sha256:')
        if (digest.length > 71) {
          // trim additional chars
          digest = digest.substring(0, 71)
        }
        if (!this.packageRepo.getIdByDigest(digest)) {
          error = true
          core.warning(
            `parent image for referrer tag ${tag} not found in repository`
          )
        }
      }
    }
    if (!error) {
      core.info('no errors found')
    }
    core.endGroup()
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
      } else {
        label = imageManifest.artifactType
      }
    }
    return label
  }

  async deleteImage(ghPackage: any): Promise<void> {
    if (!this.deleted.has(ghPackage.name)) {
      // get the manifest first
      const manifest = await this.registry.getManifestByDigest(ghPackage.name)

      // now delete it
      await this.packageRepo.deletePackageVersion(
        this.targetPackage,
        ghPackage.id,
        ghPackage.name,
        ghPackage.metadata.container.tags
      )
      this.deleted.add(ghPackage.name)
      this.statistics.numberImagesDeleted += 1

      // if manifests based image now delete it's children
      if (manifest.manifests) {
        this.statistics.numberMultiImagesDeleted += 1
        for (const imageManifest of manifest.manifests) {
          const manifestPackage = this.packageRepo.getPackageByDigest(
            imageManifest.digest
          )
          if (manifestPackage) {
            if (!this.deleted.has(manifestPackage.name)) {
              // check if the digest isn't in use by another image
              const parents = this.digestUsedBy.get(manifestPackage.name)
              if (parents) {
                if (parents.size === 1 && parents.has(ghPackage.name)) {
                  // it's only referenced from this image so delete it
                  await this.packageRepo.deletePackageVersion(
                    this.targetPackage,
                    manifestPackage.id,
                    manifestPackage.name,
                    [],
                    await this.buildLabel(imageManifest)
                  )
                  this.deleted.add(manifestPackage.name)
                  this.statistics.numberImagesDeleted += 1
                  // remove the parent - no other references to it
                  this.digestUsedBy.delete(manifestPackage.name)
                } else {
                  core.info(
                    ` skipping package id: ${manifestPackage.id} digest: ${manifestPackage.name} as it's in use by another image`
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
            core.info(` skipping digest ${imageManifest.digest}, not found`)
          }
        }
      }

      // process any referrers/cosign etc - using tag approach
      const digestTag = ghPackage.name.replace('sha256:', 'sha256-')
      const tags = this.packageRepo.getTags()
      for (const tag of tags) {
        if (
          tag.startsWith(digestTag) &&
          !this.excludeTags.includes(digestTag)
        ) {
          // find the package
          const manifestDigest = this.packageRepo.getDigestByTag(tag)
          if (manifestDigest) {
            const attestationPackage =
              this.packageRepo.getPackageByDigest(manifestDigest)
            // recursively delete it
            await this.deleteImage(attestationPackage)
          }
        }
      }
    }
  }

  async deleteGhostImages(): Promise<void> {
    core.startGroup(`[${this.targetPackage}] Finding ghost images to delete`)
    let foundGhostImage = false
    for (const digest of this.filterSet) {
      let ghostImage = false
      // is a ghost image if all of the child manifests don't exist
      const manfiest = await this.registry.getManifestByDigest(digest)
      if (manfiest.manifests) {
        let missing = 0
        for (const imageManfiest of manfiest.manifests) {
          if (!this.packageRepo.getIdByDigest(imageManfiest.digest)) {
            missing += 1
          }
        }
        if (missing === manfiest.manifests.length) {
          ghostImage = true
          foundGhostImage = true
        }
      }
      if (ghostImage) {
        // setup the ghost image to be deleted
        this.filterSet.delete(digest)
        this.deleteSet.add(digest)

        const ghPackage = this.packageRepo.getPackageByDigest(digest)
        if (ghPackage.metadata.container.tags.length > 0) {
          core.info(`${digest} ${ghPackage.metadata.container.tags}`)
        } else {
          core.info(`${digest}`)
        }
      }
    }
    if (!foundGhostImage) {
      core.info('no ghost images found')
    }
    core.endGroup()
  }

  async deletePartialImages(): Promise<void> {
    core.startGroup(`[${this.targetPackage}] Finding partial images to delete`)
    let partialImagesFound = false
    for (const digest of this.filterSet) {
      let partialImage = false
      // is a partial image if some of the child manifests don't exist
      const manfiest = await this.registry.getManifestByDigest(digest)
      if (manfiest.manifests) {
        for (const imageManfiest of manfiest.manifests) {
          if (!this.packageRepo.getIdByDigest(imageManfiest.digest)) {
            partialImage = true
            partialImagesFound = true
            break
          }
        }
      }
      if (partialImage) {
        // setup the partial image to be deleted
        this.filterSet.delete(digest)
        this.deleteSet.add(digest)

        const ghPackage = this.packageRepo.getPackageByDigest(digest)
        if (ghPackage.metadata.container.tags.length > 0) {
          core.info(`${digest} ${ghPackage.metadata.container.tags}`)
        } else {
          core.info(`${digest}`)
        }
      }
    }
    if (!partialImagesFound) {
      core.info('no partial images found')
    }
    core.endGroup()
  }

  async deleteOrphanedImages(): Promise<void> {
    core.startGroup(
      `[${this.targetPackage}] Finding orphaned images (tags) to delete`
    )
    let orphanedImagesFound = false
    for (const tag of this.packageRepo.getTags()) {
      if (tag.startsWith('sha256-')) {
        let digest = tag.replace('sha256-', 'sha256:')
        if (digest.length > 71) {
          // trim additional chars
          digest = digest.substring(0, 71)
        }
        // now check if that digest exists
        if (this.packageRepo.getIdByDigest(digest) === undefined) {
          const orphanDigest = this.packageRepo.getDigestByTag(tag)
          if (orphanDigest) {
            this.deleteSet.add(orphanDigest)
            this.filterSet.delete(orphanDigest)
            core.info(tag)
            orphanedImagesFound = true
          }
        }
      }
    }
    if (!orphanedImagesFound) {
      core.info('no orphaned images found')
    }
    core.endGroup()
  }

  async deleteByTag(): Promise<void> {
    if (this.config.deleteTags) {
      const matchTags = []
      if (this.config.useRegex) {
        const regex = new RegExp(this.config.deleteTags)
        // build match list from filterSet
        for (const digest of this.filterSet) {
          const ghPackage = this.packageRepo.getPackageByDigest(digest)
          for (const tag of ghPackage.metadata.container.tags) {
            if (regex.test(tag)) {
              matchTags.push(tag)
            }
          }
        }
      } else {
        // find the tags that match wildcard patterns
        const isTagMatch = wcmatch(this.config.deleteTags.split(','))
        // build match list from filterSet
        for (const digest of this.filterSet) {
          const ghPackage = this.packageRepo.getPackageByDigest(digest)
          for (const tag of ghPackage.metadata.container.tags) {
            if (isTagMatch(tag)) {
              matchTags.push(tag)
            }
          }
        }
      }
      if (matchTags.length > 0) {
        // build seperate sets for the untagging events and the standard deletions
        const untaggingTags = new Set<string>()
        const standardTags = new Set<string>()

        // first process untagging events - do a pre scan to check if in this mode
        for (const tag of matchTags) {
          if (!this.excludeTags.includes(tag)) {
            // get the package
            const manifestDigest = this.packageRepo.getDigestByTag(tag)
            if (manifestDigest) {
              const ghPackage =
                this.packageRepo.getPackageByDigest(manifestDigest)
              if (ghPackage.metadata.container.tags.length > 1) {
                untaggingTags.add(tag)
              } else if (ghPackage.metadata.container.tags.length === 1) {
                standardTags.add(tag)
              }
            }
          }
        }

        if (untaggingTags.size > 0) {
          const displayTags = Array.from(untaggingTags.values())
          core.startGroup(
            `[${this.targetPackage}] Untagging images: ${displayTags}`
          )
          for (const tag of untaggingTags) {
            // lets recheck there is more than 1 tag, else add it to standard set for later deletion
            // it could be situation where all tags are being deleted
            const manifestDigest = this.packageRepo.getDigestByTag(tag)
            if (manifestDigest) {
              const ghPackage =
                this.packageRepo.getPackageByDigest(manifestDigest)
              if (ghPackage.metadata.container.tags.length === 1) {
                standardTags.add(tag)
              } else {
                core.info(`${tag}`)
                // get the package
                const manifest = await this.registry.getManifestByTag(tag)

                // preform a "ghcr.io" image deletion
                // as the registry doesn't support manifest deletion directly
                // we instead assign the tag to a different manifest first
                // then we delete it

                // clone the manifest
                const newManifest = JSON.parse(JSON.stringify(manifest))

                // create a fake manifest to separate the tag
                if (newManifest.manifests) {
                  // a multi architecture image
                  newManifest.manifests = []
                  await this.registry.putManifest(tag, newManifest, true)
                } else {
                  newManifest.layers = []
                  await this.registry.putManifest(tag, newManifest, false)
                }

                // reload package ids to find the new package id/digest
                await this.packageRepo.loadPackages(this.targetPackage, false)

                // reload the manifest
                const untaggedDigest = this.packageRepo.getDigestByTag(tag)
                if (untaggedDigest) {
                  const id = this.packageRepo.getIdByDigest(untaggedDigest)
                  if (id) {
                    await this.packageRepo.deletePackageVersion(
                      this.targetPackage,
                      id,
                      untaggedDigest,
                      [tag]
                    )
                    this.statistics.numberImagesDeleted += 1
                  } else {
                    core.info(
                      `couldn't find newly created package with digest ${untaggedDigest} to delete`
                    )
                  }
                }
              }
            }
          }
          core.endGroup()
        }

        // reload the state
        if (untaggingTags.size > 0) {
          core.info('Reloading action due to untagging')
          await this.reload()
        }

        if (standardTags.size > 0) {
          core.startGroup(
            `[${this.targetPackage}] Find tagged images to delete: ${this.config.deleteTags}`
          )
          for (const tag of standardTags) {
            core.info(tag)
            // get the package
            const manifestDigest = this.packageRepo.getDigestByTag(tag)
            if (manifestDigest) {
              this.deleteSet.add(manifestDigest)
              this.filterSet.delete(manifestDigest)
            }
          }
          core.endGroup()
        }
      } else {
        core.startGroup(
          `[${this.targetPackage}] Finding tagged images to delete: ${this.config.deleteTags}`
        )
        core.info('no matching tags found')
        core.endGroup()
      }
    }
  }

  async keepNuntagged(): Promise<void> {
    if (this.config.keepNuntagged != null) {
      core.startGroup(
        `[${this.targetPackage}] Finding untagged images to delete, keeping ${this.config.keepNuntagged} versions`
      )

      // create a temporary array of untagged images to process on
      const unTaggedPackages = []

      // find untagged images in the filterSet
      for (const digest of this.filterSet) {
        const ghPackage = this.packageRepo.getPackageByDigest(digest)
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
            core.info(`${deletePackage.name}`)
          }
          if (deletePackages.length === 0) {
            core.info('no untagged images found to delete')
          }
        }
      } else {
        core.info('no untagged images found to delete')
      }
      core.endGroup()
    }
  }

  async keepNtagged(): Promise<void> {
    if (this.config.keepNtagged != null) {
      core.startGroup(
        `[${this.targetPackage}] Finding tagged images to delete, keeping ${this.config.keepNtagged} versions`
      )

      // create a temporary array of tagged images to process on
      const taggedPackages = []

      // only copy images with tags
      for (const digest of this.filterSet) {
        const ghPackage = this.packageRepo.getPackageByDigest(digest)
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

          const ghPackage = this.packageRepo.getPackageByDigest(
            deletePackage.name
          )
          core.info(
            `${deletePackage.name} ${ghPackage.metadata.container.tags}`
          )
        }
      } else {
        core.info('no tagged images found to delete')
      }
      core.endGroup()
    }
  }

  /*
   * Add to deleteSet all digests which have no tags
   */
  async deleteUntagged(): Promise<void> {
    core.startGroup(
      `[${this.targetPackage}] Finding all untagged images to delete`
    )
    let untaggedImageFound = false

    // find untagged images in the filterSet
    for (const digest of this.filterSet) {
      const ghPackage = this.packageRepo.getPackageByDigest(digest)
      if (ghPackage.metadata.container.tags.length === 0) {
        this.deleteSet.add(digest)
        this.filterSet.delete(digest)
        core.info(`${digest}`)
        untaggedImageFound = true
      }
    }
    if (!untaggedImageFound) {
      core.info('no untagged images found')
    }
    core.endGroup()
  }

  // makes sure all required manfiests are downloaded before the deletion
  // process runs. ensuring only package api calls are made during deletion
  // minimizing chances of failed registry calls affecting deletion
  async primeManifests(): Promise<void> {
    for (const digest of this.deleteSet) {
      const manifest = await this.registry.getManifestByDigest(digest)
      if (manifest.manifests) {
        for (const imageManifest of manifest.manifests) {
          // call the buildLabel method which will prime manifest if its needed
          await this.buildLabel(imageManifest)
        }
      }
      // process tagged digests (referrers)
      const digestTag = digest.replace('sha256:', 'sha256-')
      const tags = this.packageRepo.getTags()
      for (const tag of tags) {
        if (tag.startsWith(digestTag)) {
          const tagDigest = this.packageRepo.getDigestByTag(tag)
          if (tagDigest) {
            const tagManifest =
              await this.registry.getManifestByDigest(tagDigest)
            if (tagManifest.manifests) {
              for (const manifestEntry of tagManifest.manifests) {
                await this.buildLabel(manifestEntry)
              }
            }
          }
        }
      }
    }
  }

  /*
   * Deletes all the digets in the deleteSet from the package repository
   */
  async doDelete(): Promise<void> {
    // make sure we have the necessary manifests cached before we start the
    // deletion process
    await this.primeManifests()

    // now delete the images
    core.startGroup(`[${this.targetPackage}] Deleting packages`)
    if (this.deleteSet.size > 0) {
      for (const deleteDigest of this.deleteSet) {
        const deleteImage = this.packageRepo.getPackageByDigest(deleteDigest)
        await this.deleteImage(deleteImage)
      }
    } else {
      core.info(`Nothing to delete`)
    }
    core.endGroup()
  }

  async run(): Promise<CleanupTaskStatistics> {
    // process tag deletions first - to support untagging
    if (this.config.deleteTags) {
      await this.deleteByTag()
    }

    if (this.config.deletePartialImages) {
      await this.deletePartialImages()
    } else if (this.config.deleteGhostImages) {
      await this.deleteGhostImages()
    }

    if (this.config.deleteOrphanedImages) {
      await this.deleteOrphanedImages()
    }

    if (this.config.keepNtagged != null) {
      // we are in the cleanup tagged images mode
      await this.keepNtagged()
    }

    if (this.config.keepNuntagged != null) {
      // we are in the cleanup untagged images mode
      await this.keepNuntagged()
    } else if (this.config.deleteUntagged) {
      // delete all untagged images
      await this.deleteUntagged()
    }

    // now preform the actual deletion
    await this.doDelete()

    // print out the statistics
    this.statistics.print()

    if (this.config.validate) {
      core.info(` [${this.targetPackage}] Running Validation Task `)
      await this.reload()
      await this.validate()
      core.info('')
    }

    return this.statistics
  }
}
