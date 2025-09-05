import { Config } from './config.js'
import { Registry } from './registry.js'
import { PackageRepo } from './package-repo.js'

/**
 * Shared context object passed to all cleanup modules.
 * Provides access to configuration and core services needed for cleanup operations.
 */
export interface CleanupContext {
  /** The action configuration containing all user inputs and settings */
  config: Config
  /** Registry client for interacting with the container registry (ghcr.io) */
  registry: Registry
  /** Package repository client for GitHub Package API operations */
  packageRepo: PackageRepo
  /** The name of the package being processed */
  targetPackage: string
}

/**
 * Result of applying filters to the package repository.
 * Contains the filtered set of images and metadata about excluded items.
 */
export interface FilterResult {
  /** Set of image digests that passed all filters and are candidates for processing */
  filterSet: Set<string>
  /** Array of tag names that were explicitly excluded from deletion */
  excludeTags: string[]
  /** Set of all tags currently in use in the repository */
  tagsInUse: Set<string>
}

/**
 * Result of analyzing image manifests and their relationships.
 * Maps parent-child relationships for multi-architecture images.
 */
export interface ManifestAnalysis {
  /**
   * Map of child digest to parent digests.
   * Key: Child image digest (e.g., platform-specific image)
   * Value: Set of parent digests that reference this child
   */
  digestUsedBy: Map<string, Set<string>>
  /** Set of top-level image digests (excludes child platform images) */
  filterSet: Set<string>
}

/**
 * Result of validating image integrity in the repository.
 * Identifies various types of broken or orphaned images.
 */
export interface ValidationResult {
  /** Whether any validation errors were found */
  hasErrors: boolean
  /**
   * Ghost images: multi-arch images where ALL platform images are missing.
   * These are completely broken and cannot be pulled.
   */
  ghostImages: Set<string>
  /**
   * Partial images: multi-arch images where SOME platform images are missing.
   * These are partially broken and may fail for certain platforms.
   */
  partialImages: Set<string>
  /**
   * Orphaned images: images with tags like 'sha256-...' whose parent image no longer exists.
   * Common with attestation/signature images that lost their parent.
   */
  orphanedImages: Set<string>
}

/**
 * Represents the planned operations for handling tag deletions.
 * This includes both complete image deletions and tag removal from multi-tagged images.
 */
export interface DeletionPlan {
  /**
   * Set of image digests to be completely deleted.
   * These are images that either have only one tag, or where all tags are being removed.
   */
  deleteSet: Set<string>

  /**
   * Map of untagging operations for multi-tagged images.
   * Key: Image digest of a multi-tagged image
   * Value: Array of tag names to remove from that image
   *
   * Example: { 'sha256:abc123': ['v1.0', 'old-release'] }
   * This means remove tags 'v1.0' and 'old-release' from the image with digest sha256:abc123,
   * while keeping any other tags (like 'latest') intact.
   *
   * The untagging process creates a new empty manifest, points the tag to it,
   * then deletes that empty manifest, effectively removing the tag from the original image.
   */
  untagOperations: Map<string, string[]>
}

/**
 * Result of performing deletion operations.
 * Contains statistics and tracking of what was deleted.
 */
export interface DeletionResult {
  /** Set of digests that were successfully deleted */
  deleted: Set<string>
  /** Total number of images deleted (including child images) */
  numberImagesDeleted: number
  /** Number of multi-architecture parent images deleted */
  numberMultiImagesDeleted: number
}
