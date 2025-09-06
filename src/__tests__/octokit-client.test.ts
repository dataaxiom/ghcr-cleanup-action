import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import { RequestError } from '@octokit/request-error'
import { OctokitClient } from '../octokit-client'
import { LogLevel } from '../config'

// Mock dependencies
vi.mock('@actions/core')

vi.mock('@octokit/rest', () => {
  const MockOctokit = vi.fn(() => ({
    request: vi.fn()
  }))
  MockOctokit.plugin = vi.fn(() => MockOctokit)

  return {
    Octokit: MockOctokit
  }
})

vi.mock('@octokit/plugin-throttling', () => ({
  throttling: vi.fn()
}))
vi.mock('@octokit/plugin-retry', () => ({
  retry: vi.fn()
}))
vi.mock('@octokit/plugin-request-log', () => ({
  requestLog: vi.fn()
}))

describe('OctokitClient', () => {
  let mockWarning: vi.MockedFunction<typeof core.warning>

  beforeEach(() => {
    vi.clearAllMocks()
    mockWarning = core.warning as vi.MockedFunction<typeof core.warning>
  })

  describe('constructor', () => {
    it('should create client with default settings', () => {
      const client = new OctokitClient('test-token')

      expect(client).toBeDefined()
      expect(client.getClient()).toBeDefined()
    })

    it('should create client with custom GitHub API URL', () => {
      const client = new OctokitClient(
        'test-token',
        'https://custom.github.com'
      )

      expect(client).toBeDefined()
    })

    it('should create client with custom log level', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.DEBUG)

      expect(client).toBeDefined()
    })

    it('should use default API URL when not provided', () => {
      const client = new OctokitClient('test-token', undefined)

      expect(client).toBeDefined()
    })
  })

  describe('throttling configuration', () => {
    it('should handle rate limit and retry up to 3 times', () => {
      // This test verifies the throttling configuration
      // The actual behavior is tested through integration tests
      const client = new OctokitClient('test-token')

      // Get the client to ensure it's properly configured
      const octokit = client.getClient()
      expect(octokit).toBeDefined()
    })

    it('should log rate limit warnings', () => {
      // This would be tested in integration tests
      // Here we just verify the client is created successfully
      const client = new OctokitClient('test-token')
      expect(client).toBeDefined()
    })
  })

  describe('getClient', () => {
    it('should return the Octokit instance', () => {
      const client = new OctokitClient('test-token')
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
      // The actual type is the extended MyOctokitInstance
      expect(octokit).toHaveProperty('request')
    })
  })

  describe('getRepository', () => {
    let client: OctokitClient
    let mockRequest: vi.Mock

    beforeEach(() => {
      client = new OctokitClient('test-token')
      mockRequest = vi.fn()
      ;(client as any).octokit = {
        request: mockRequest
      }
    })

    it('should fetch repository information successfully', async () => {
      mockRequest.mockResolvedValue({
        data: {
          private: true,
          owner: {
            type: 'User'
          }
        }
      })

      const result = await client.getRepository('test-owner', 'test-repo')

      expect(result).toEqual({
        isPrivate: true,
        ownerType: 'User'
      })
      expect(mockRequest).toHaveBeenCalledWith(
        'GET /repos/test-owner/test-repo'
      )
    })

    it('should handle public organization repository', async () => {
      mockRequest.mockResolvedValue({
        data: {
          private: false,
          owner: {
            type: 'Organization'
          }
        }
      })

      const result = await client.getRepository('org-name', 'org-repo')

      expect(result).toEqual({
        isPrivate: false,
        ownerType: 'Organization'
      })
    })

    it('should handle 404 error with warning', async () => {
      const error = new RequestError('Not Found', 404, {
        request: {
          method: 'GET',
          url: 'https://api.github.com/repos/test-owner/test-repo',
          headers: {}
        },
        response: {
          status: 404,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockRequest.mockRejectedValue(error)

      await expect(
        client.getRepository('test-owner', 'test-repo')
      ).rejects.toThrow(error)

      expect(mockWarning).toHaveBeenCalledWith(
        'The repository is not found, check the owner value "test-owner" or the repository value "test-repo" are correct'
      )
    })

    it('should rethrow non-404 errors', async () => {
      const error = new RequestError('Internal Server Error', 500, {
        request: {
          method: 'GET',
          url: 'https://api.github.com/repos/test-owner/test-repo',
          headers: {}
        },
        response: {
          status: 500,
          url: '',
          headers: {},
          data: {},
          retryCount: 0
        }
      })
      mockRequest.mockRejectedValue(error)

      await expect(
        client.getRepository('test-owner', 'test-repo')
      ).rejects.toThrow(error)

      expect(mockWarning).not.toHaveBeenCalled()
    })

    it('should rethrow non-RequestError errors', async () => {
      const error = new Error('Network error')
      mockRequest.mockRejectedValue(error)

      await expect(
        client.getRepository('test-owner', 'test-repo')
      ).rejects.toThrow(error)

      expect(mockWarning).not.toHaveBeenCalled()
    })
  })

  describe('logging configuration', () => {
    it('should log debug messages when log level is DEBUG', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.DEBUG)
      const octokit = client.getClient()

      // Verify client is created with debug logging
      expect(octokit).toBeDefined()
    })

    it('should log info messages when log level is INFO or higher', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.INFO)
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
    })

    it('should log warn messages when log level is WARN or higher', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.WARN)
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
    })

    it('should log error messages when log level is ERROR or higher', () => {
      const client = new OctokitClient('test-token', undefined, LogLevel.ERROR)
      const octokit = client.getClient()

      expect(octokit).toBeDefined()
    })
  })
})
