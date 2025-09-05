import * as core from '@actions/core'
import { CleanupContext, DeletionResult } from './cleanup-types.js'
import { ManifestAnalyzer } from './manifest-analyzer.js'

export class ImageDeleter {
  private context: CleanupContext
  private manifestAnalyzer: ManifestAnalyzer
  private deleted: Set<string>
  private digestUsedBy: Map<string, Set<string>>

  constructor(context: CleanupContext, digestUsedBy: Map<string, Set<string>>) {
    this.context = context
    this.manifestAnalyzer = new ManifestAnalyzer(context)
    this.deleted = new Set<string>()
    this.digestUsedBy = digestUsedBy
  }

  /**
   * Perform untagging operations
   */
  async performUntagging(
    untagOperations: Map<string, string[]>
  ): Promise<boolean> {
    if (untagOperations.size === 0) {
      return false
    }

    const allTags: string[] = []
    for (const tags of untagOperations.values()) {
      allTags.push(...tags)
    }

    core.startGroup(
      `[${this.context.targetPackage}] Untagging images: ${allTags}`
    )

    for (const [manifestDigest, tags] of untagOperations) {
      for (const tag of tags) {
        // Recheck there is more than 1 tag
        const ghPackage =
          this.context.packageRepo.getPackageByDigest(manifestDigest)
        if (ghPackage.metadata.container.tags.length > 1) {
          core.info(`${tag}`)

          const manifest =
            await this.context.registry.getManifestByDigest(manifestDigest)

          // Clone the manifest
          const newManifest = JSON.parse(JSON.stringify(manifest))

          // Create a fake manifest to separate the tag
          if (newManifest.manifests) {
            newManifest.manifests = []
            await this.context.registry.putManifest(tag, newManifest, true)
          } else {
            newManifest.layers = []
            await this.context.registry.putManifest(tag, newManifest, false)
          }

          // Reload package ids to find the new package id/digest
          await this.context.packageRepo.loadPackages(
            this.context.targetPackage,
            false
          )

          // Delete the untagged version
          const untaggedDigest = this.context.packageRepo.getDigestByTag(tag)
          if (untaggedDigest) {
            const id = this.context.packageRepo.getIdByDigest(untaggedDigest)
            if (id) {
              await this.context.packageRepo.deletePackageVersion(
                this.context.targetPackage,
                id,
                untaggedDigest,
                [tag]
              )
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
    return true
  }

  /**
   * Delete a single image and its children
   */
  async deleteImage(
    ghPackage: any
  ): Promise<{ deleted: number; multiDeleted: number }> {
    let imagesDeleted = 0
    let multiImagesDeleted = 0

    if (this.deleted.has(ghPackage.name)) {
      return { deleted: imagesDeleted, multiDeleted: multiImagesDeleted }
    }

    // Get the manifest first
    const manifest = await this.context.registry.getManifestByDigest(
      ghPackage.name
    )

    // Delete the package
    await this.context.packageRepo.deletePackageVersion(
      this.context.targetPackage,
      ghPackage.id,
      ghPackage.name,
      ghPackage.metadata.container.tags
    )
    this.deleted.add(ghPackage.name)
    imagesDeleted += 1

    // If manifests based image, delete children
    if (manifest.manifests) {
      multiImagesDeleted += 1
      for (const imageManifest of manifest.manifests) {
        const manifestPackage = this.context.packageRepo.getPackageByDigest(
          imageManifest.digest
        )
        if (manifestPackage && !this.deleted.has(manifestPackage.name)) {
          const parents = this.digestUsedBy.get(manifestPackage.name)
          if (parents) {
            if (parents.size === 1 && parents.has(ghPackage.name)) {
              // Only referenced from this image
              await this.context.packageRepo.deletePackageVersion(
                this.context.targetPackage,
                manifestPackage.id,
                manifestPackage.name,
                [],
                await this.manifestAnalyzer.buildLabel(imageManifest)
              )
              this.deleted.add(manifestPackage.name)
              imagesDeleted += 1
              this.digestUsedBy.delete(manifestPackage.name)
            } else {
              core.info(
                ` skipping package id: ${manifestPackage.id} digest: ${manifestPackage.name} as it's in use by another image`
              )
              parents.delete(ghPackage.name)
            }
          }
        }
      }
    }

    // Process referrers/cosign
    const digestTag = ghPackage.name.replace('sha256:', 'sha256-')
    const tags = this.context.packageRepo.getTags()
    for (const tag of tags) {
      if (tag.startsWith(digestTag)) {
        const manifestDigest = this.context.packageRepo.getDigestByTag(tag)
        if (manifestDigest) {
          const attestationPackage =
            this.context.packageRepo.getPackageByDigest(manifestDigest)
          if (attestationPackage) {
            const result = await this.deleteImage(attestationPackage)
            imagesDeleted += result.deleted
            multiImagesDeleted += result.multiDeleted
          }
        }
      }
    }

    return { deleted: imagesDeleted, multiDeleted: multiImagesDeleted }
  }

  /**
   * Delete all images in the delete set
   */
  async deleteImages(deleteSet: Set<string>): Promise<DeletionResult> {
    // Prime manifests
    await this.manifestAnalyzer.primeManifests(deleteSet)

    core.startGroup(`[${this.context.targetPackage}] Deleting packages`)

    let totalDeleted = 0
    let totalMultiDeleted = 0

    if (deleteSet.size > 0) {
      for (const deleteDigest of deleteSet) {
        const deleteImage =
          this.context.packageRepo.getPackageByDigest(deleteDigest)
        const result = await this.deleteImage(deleteImage)
        totalDeleted += result.deleted
        totalMultiDeleted += result.multiDeleted
      }
    } else {
      core.info(`Nothing to delete`)
    }

    core.endGroup()

    return {
      deleted: this.deleted,
      numberImagesDeleted: totalDeleted,
      numberMultiImagesDeleted: totalMultiDeleted
    }
  }

  /**
   * Reset the deletion state
   */
  reset(): void {
    this.deleted.clear()
  }
}
