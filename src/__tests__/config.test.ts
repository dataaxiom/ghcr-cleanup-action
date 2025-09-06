import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import { Config, LogLevel, buildConfig } from '../config'
import { OctokitClient } from '../octokit-client'

// Mock dependencies
vi.mock('@actions/core')
vi.mock('../octokit-client')
vi.mock('human-interval')

// Mock environment variables
const originalEnv = process.env

describe('Config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('Config class', () => {
    it('should initialize with default values', () => {
      const config = new Config()

      expect(config.isPrivateRepo).toBe(false)
      expect(config.repoType).toBe('Organization')
      expect(config.owner).toBe('')
      expect(config.repository).toBe('')
      expect(config.package).toBe('')
      expect(config.token).toBe('')
      expect(config.logLevel).toBe(LogLevel.INFO)
      expect(config.expandPackages).toBeUndefined()
      expect(config.defaultPackageUsed).toBe(false)
      expect(config.deleteTags).toBeUndefined()
      expect(config.excludeTags).toBeUndefined()
      expect(config.olderThanReadable).toBeUndefined()
      expect(config.olderThan).toBeUndefined()
      expect(config.deleteUntagged).toBeUndefined()
      expect(config.deleteGhostImages).toBeUndefined()
      expect(config.deletePartialImages).toBeUndefined()
      expect(config.deleteOrphanedImages).toBeUndefined()
      expect(config.keepNuntagged).toBeUndefined()
      expect(config.keepNtagged).toBeUndefined()
      expect(config.dryRun).toBeUndefined()
      expect(config.validate).toBeUndefined()
      expect(config.useRegex).toBeUndefined()
      expect(config.registryUrl).toBeUndefined()
      expect(config.githubApiUrl).toBeUndefined()
    })
  })

  describe('buildConfig', () => {
    let mockGetInput: vi.MockedFunction<typeof core.getInput>
    let mockGetBooleanInput: vi.MockedFunction<typeof core.getBooleanInput>
    let mockInfo: vi.MockedFunction<typeof core.info>
    let mockStartGroup: vi.MockedFunction<typeof core.startGroup>
    let mockEndGroup: vi.MockedFunction<typeof core.endGroup>
    let mockOctokitClient: vi.MockedClass<typeof OctokitClient>

    beforeEach(() => {
      mockGetInput = core.getInput as vi.MockedFunction<typeof core.getInput>
      mockGetBooleanInput = core.getBooleanInput as vi.MockedFunction<
        typeof core.getBooleanInput
      >
      mockInfo = core.info as vi.MockedFunction<typeof core.info>
      mockStartGroup = core.startGroup as vi.MockedFunction<
        typeof core.startGroup
      >
      mockEndGroup = core.endGroup as vi.MockedFunction<typeof core.endGroup>
      mockOctokitClient = vi.mocked(OctokitClient)

      // Setup default mocks
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          owner: 'test-owner',
          repository: 'test-repo',
          package: 'test-package'
        }
        return inputs[name] || ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      // Mock OctokitClient
      mockOctokitClient.prototype.getRepository = vi
        .fn()
        .mockResolvedValue({ isPrivate: false, ownerType: 'Organization' })
    })

    it('should build config with basic inputs', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'

      const config = await buildConfig()

      expect(config.token).toBe('test-token')
      expect(config.owner).toBe('test-owner')
      expect(config.repository).toBe('test-repo')
      expect(config.package).toBe('test-package')
      expect(config.isPrivateRepo).toBe(false)
      expect(config.repoType).toBe('Organization')
    })

    it('should auto-populate from GITHUB_REPOSITORY env var', async () => {
      process.env.GITHUB_REPOSITORY = 'auto-owner/auto-repo'
      mockGetInput.mockImplementation((name: string) => {
        if (name === 'token') return 'test-token'
        return '' // Return empty for owner, repository, package
      })

      const config = await buildConfig()

      expect(config.owner).toBe('auto-owner')
      expect(config.repository).toBe('auto-repo')
      expect(config.package).toBe('auto-repo')
      expect(config.defaultPackageUsed).toBe(true)
    })

    it('should throw error when GITHUB_REPOSITORY is missing', async () => {
      delete process.env.GITHUB_REPOSITORY

      await expect(buildConfig()).rejects.toThrow(
        'GITHUB_REPOSITORY is not set'
      )
    })

    it('should throw error when GITHUB_REPOSITORY is malformed', async () => {
      process.env.GITHUB_REPOSITORY = 'malformed'

      await expect(buildConfig()).rejects.toThrow(
        'Error parsing GITHUB_REPOSITORY: malformed'
      )
    })

    it('should throw error when package and packages are both set', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          package: 'package1',
          packages: 'package2'
        }
        return inputs[name] || ''
      })

      await expect(buildConfig()).rejects.toThrow(
        'package and packages cant be used at the same time, use either one'
      )
    })

    it('should handle packages input as fallback for package', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          packages: 'package1,package2'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.package).toBe('package1,package2')
    })

    it('should auto-enable expand-packages for wildcard patterns', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          package: 'test-*'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.expandPackages).toBe(true)
      expect(mockInfo).toHaveBeenCalledWith(
        expect.stringContaining('auto enabling expand-packages to true')
      )
    })

    it('should handle delete-tags and tags inputs', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'delete-tags': 'v1.*,v2.*'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.deleteTags).toBe('v1.*,v2.*')
    })

    it('should throw error when tags and delete-tags are both set', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          tags: 'v1.*',
          'delete-tags': 'v2.*'
        }
        return inputs[name] || ''
      })

      await expect(buildConfig()).rejects.toThrow(
        'tags and delete-tags cant be used at the same time, use either one'
      )
    })

    it('should handle keep-n-tagged and keep-n-untagged', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'keep-n-tagged': '5',
          'keep-n-untagged': '3'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.keepNtagged).toBe(5)
      expect(config.keepNuntagged).toBe(3)
    })

    it('should throw error for invalid keep-n-tagged value', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'keep-n-tagged': 'invalid'
        }
        return inputs[name] || ''
      })

      await expect(buildConfig()).rejects.toThrow('keep-n-tagged is not number')
    })

    it('should throw error for negative keep-n-tagged value', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'keep-n-tagged': '-1'
        }
        return inputs[name] || ''
      })

      await expect(buildConfig()).rejects.toThrow('keep-n-tagged is negative')
    })

    it('should default deleteUntagged to true when no options are set', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        if (name === 'token') return 'test-token'
        return ''
      })

      const config = await buildConfig()

      expect(config.deleteUntagged).toBe(true)
    })

    it('should handle boolean inputs correctly', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'delete-untagged': 'true',
          'delete-ghost-images': 'true',
          'delete-partial-images': 'true',
          'delete-orphaned-images': 'true',
          'dry-run': 'true',
          validate: 'true',
          'use-regex': 'true'
        }
        return inputs[name] || ''
      })
      mockGetBooleanInput.mockReturnValue(true)

      const config = await buildConfig()

      expect(config.deleteUntagged).toBe(true)
      expect(config.deleteGhostImages).toBe(true)
      expect(config.deletePartialImages).toBe(true)
      expect(config.deleteOrphanedImages).toBe(true)
      expect(config.dryRun).toBe(true)
      expect(config.validate).toBe(true)
      expect(config.useRegex).toBe(true)
    })

    it('should handle log levels correctly', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'log-level': 'debug'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.logLevel).toBe(LogLevel.DEBUG)
    })

    it('should handle registry-url with trailing slash', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'registry-url': 'https://custom.registry.com'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.registryUrl).toBe('https://custom.registry.com/')
    })

    it('should handle github-api-url without trailing slash', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'github-api-url': 'https://custom.github.com/'
        }
        return inputs[name] || ''
      })

      const config = await buildConfig()

      expect(config.githubApiUrl).toBe('https://custom.github.com')
    })

    it('should fetch repository info from OctokitClient', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockOctokitClient.prototype.getRepository = vi
        .fn()
        .mockResolvedValue({ isPrivate: true, ownerType: 'User' })

      const config = await buildConfig()

      expect(config.isPrivateRepo).toBe(true)
      expect(config.repoType).toBe('User')
      expect(mockOctokitClient.prototype.getRepository).toHaveBeenCalledWith(
        'test-owner',
        'test-repo'
      )
    })

    it('should print runtime configuration', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'

      await buildConfig()

      expect(mockStartGroup).toHaveBeenCalledWith('Runtime configuration')
      expect(mockEndGroup).toHaveBeenCalled()
    })

    it('should throw error when delete-untagged and keep-n-untagged are both set', async () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          token: 'test-token',
          'delete-untagged': 'true',
          'keep-n-untagged': '3'
        }
        return inputs[name] || ''
      })
      mockGetBooleanInput.mockImplementation((name: string) => {
        return name === 'delete-untagged'
      })

      await expect(buildConfig()).rejects.toThrow(
        'delete-untagged and keep-n-untagged can not be set at the same time'
      )
    })
  })

  describe('LogLevel enum', () => {
    it('should have correct values', () => {
      expect(LogLevel.ERROR).toBe(1)
      expect(LogLevel.WARN).toBe(2)
      expect(LogLevel.INFO).toBe(3)
      expect(LogLevel.DEBUG).toBe(4)
    })
  })
})
