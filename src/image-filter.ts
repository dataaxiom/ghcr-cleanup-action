import * as core from '@actions/core'
import wcmatch from 'wildcard-match'
import { CleanupContext } from './cleanup-types.js'

export class ImageFilter {
  private context: CleanupContext

  constructor(context: CleanupContext) {
    this.context = context
  }

  /**
   * Applies exclusion filters to the filter set
   */
  applyExclusionFilters(filterSet: Set<string>): string[] {
    const excludeTags: string[] = []

    if (!this.context.config.excludeTags) {
      return excludeTags
    }

    const tagsInUse = this.context.packageRepo.getTags()

    if (this.context.config.useRegex) {
      const regex = new RegExp(this.context.config.excludeTags)
      // Check all tags for matches first
      for (const tag of tagsInUse) {
        if (regex.test(tag)) {
          const digest = this.context.packageRepo.getDigestByTag(tag)
          if (digest) {
            filterSet.delete(digest)
          }
          excludeTags.push(tag)
        }
      }
      // Now check for digest based format matches
      for (const digest of this.context.packageRepo.getDigests()) {
        if (regex.test(digest)) {
          filterSet.delete(digest)
          excludeTags.push(digest)
        }
      }
    } else {
      const isTagMatch = wcmatch(this.context.config.excludeTags.split(','))
      // Check all tags for matches first
      for (const tag of tagsInUse) {
        if (isTagMatch(tag)) {
          const digest = this.context.packageRepo.getDigestByTag(tag)
          if (digest) {
            filterSet.delete(digest)
          }
          excludeTags.push(tag)
        }
      }
      // Now check for digest based format matches
      for (const digest of this.context.packageRepo.getDigests()) {
        if (isTagMatch(digest)) {
          filterSet.delete(digest)
          excludeTags.push(digest)
        }
      }
    }

    if (excludeTags.length > 0) {
      core.startGroup(
        `[${this.context.targetPackage}] Excluding tags from deletion`
      )
      for (const tag of excludeTags) {
        core.info(tag)
      }
      core.endGroup()
    }

    return excludeTags
  }

  /**
   * Filters images by age
   */
  applyAgeFilter(filterSet: Set<string>): void {
    if (!this.context.config.olderThan) {
      return
    }

    core.startGroup(
      `[${this.context.targetPackage}] Finding images that are older than: ${this.context.config.olderThanReadable}`
    )

    for (const digest of filterSet) {
      const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
      if (ghPackage.updated_at) {
        const cutOff = new Date(Date.now() - this.context.config.olderThan)
        const packageDate = new Date(ghPackage.updated_at)
        if (packageDate >= cutOff) {
          // The package is newer than cutoff so remove it from filterSet
          filterSet.delete(digest)
        } else {
          const tags = ghPackage.metadata.container.tags
          if (tags.length > 0) {
            core.info(`${digest} ${tags}`)
          } else {
            core.info(digest)
          }
        }
      }
    }

    if (filterSet.size === 0) {
      core.info('no images found')
    }
    core.endGroup()
  }

  /**
   * Expands tags based on wildcard or regex patterns
   */
  expandTags(filterSet: Set<string>): Set<string> {
    const matchTags = new Set<string>()

    if (!this.context.config.deleteTags) {
      return matchTags
    }

    if (this.context.config.useRegex) {
      const regex = new RegExp(this.context.config.deleteTags)
      // Build match list from filterSet
      for (const digest of filterSet) {
        const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
        for (const tag of ghPackage.metadata.container.tags) {
          if (regex.test(tag)) {
            matchTags.add(tag)
          }
        }
      }
      // Check for digest based format matches
      for (const digest of filterSet) {
        if (regex.test(digest)) {
          matchTags.add(digest)
        }
      }
    } else {
      const isTagMatch = wcmatch(this.context.config.deleteTags.split(','))
      // Build match list from filterSet
      for (const digest of filterSet) {
        const ghPackage = this.context.packageRepo.getPackageByDigest(digest)
        for (const tag of ghPackage.metadata.container.tags) {
          if (isTagMatch(tag)) {
            matchTags.add(tag)
          }
        }
      }
      // Check for digest based format matches
      for (const digest of filterSet) {
        if (isTagMatch(digest)) {
          matchTags.add(digest)
        }
      }
    }

    return matchTags
  }
}
