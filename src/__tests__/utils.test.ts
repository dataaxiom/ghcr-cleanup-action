import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction
} from 'vitest'
import * as core from '@actions/core'
import {
  parseChallenge,
  isValidChallenge,
  MapPrinter,
  CleanupTaskStatistics,
  parentDigestFromReferrerTag,
  SHA256_DIGEST_LENGTH,
  validateUserRegex,
  warnIfUnanchoredRegex,
  MAX_USER_REGEX_LENGTH,
  runWithConcurrency,
  sleep
} from '../utils'

// Mock @actions/core
vi.mock('@actions/core')

describe('utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('parseChallenge', () => {
    it('should parse a valid Bearer challenge', () => {
      const challenge =
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/test:pull"'
      const result = parseChallenge(challenge)

      expect(result.get('realm')).toBe('https://ghcr.io/token')
      expect(result.get('service')).toBe('ghcr.io')
      expect(result.get('scope')).toBe('repository:user/test:pull')
    })

    it('should handle quoted values correctly', () => {
      const challenge = 'Bearer key1="value1",key2=value2,key3="value3"'
      const result = parseChallenge(challenge)

      expect(result.get('key1')).toBe('value1')
      expect(result.get('key2')).toBe('value2')
      expect(result.get('key3')).toBe('value3')
    })

    it('should return empty map for non-Bearer challenge', () => {
      const challenge = 'Basic realm="test"'
      const result = parseChallenge(challenge)

      expect(result.size).toBe(0)
    })

    it('should return empty map for empty string', () => {
      const challenge = ''
      const result = parseChallenge(challenge)

      expect(result.size).toBe(0)
    })

    it('should handle challenge without Bearer prefix', () => {
      const challenge = 'realm="test",service="test",scope="test"'
      const result = parseChallenge(challenge)

      expect(result.size).toBe(0)
    })

    it('should handle malformed challenge without equals sign', () => {
      const challenge = 'Bearer malformed'
      const result = parseChallenge(challenge)

      // With the fix, malformed entries without '=' are ignored
      expect(result.size).toBe(0)
    })

    it('should handle challenge with empty value', () => {
      const challenge = 'Bearer key1=,key2=value'
      const result = parseChallenge(challenge)

      expect(result.get('key1')).toBe('')
      expect(result.get('key2')).toBe('value')
    })

    it('should preserve = characters inside values', () => {
      // base64-encoded scopes can contain = padding; the parser must only
      // split on the first =, not every =.
      const challenge =
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/test:pull=encoded=="'
      const result = parseChallenge(challenge)

      expect(result.get('scope')).toBe('repository:user/test:pull=encoded==')
    })

    it('returns an empty map for an undefined challenge instead of throwing', () => {
      // A 401 with no www-authenticate header yields undefined here; the
      // parser must not blow up on .startsWith.
      expect(() => parseChallenge(undefined)).not.toThrow()
      expect(parseChallenge(undefined).size).toBe(0)
    })
  })

  describe('parentDigestFromReferrerTag', () => {
    const fullDigest = `sha256:${'a'.repeat(64)}`
    const referrerHex = 'a'.repeat(64)

    it('extracts the parent digest from a cosign signature tag', () => {
      const tag = `sha256-${referrerHex}.sig`
      expect(parentDigestFromReferrerTag(tag)).toBe(fullDigest)
    })

    it('extracts the parent digest from an attestation tag', () => {
      const tag = `sha256-${referrerHex}.att`
      expect(parentDigestFromReferrerTag(tag)).toBe(fullDigest)
    })

    it('handles a bare sha256-<hex> tag with no suffix', () => {
      const tag = `sha256-${referrerHex}`
      expect(parentDigestFromReferrerTag(tag)).toBe(fullDigest)
    })

    it('returns null for tags without the sha256- prefix', () => {
      expect(parentDigestFromReferrerTag('latest')).toBeNull()
      expect(parentDigestFromReferrerTag('v1.0.0')).toBeNull()
    })

    it('returns null for malformed short referrer tags', () => {
      // Too short to be a real digest — should not produce a half-valid lookup
      expect(parentDigestFromReferrerTag('sha256-abc')).toBeNull()
    })

    it('SHA256_DIGEST_LENGTH is 71', () => {
      expect(SHA256_DIGEST_LENGTH).toBe(71)
    })
  })

  describe('isValidChallenge', () => {
    it('should return true for valid challenge with all required attributes', () => {
      const attributes = new Map<string, string>([
        ['realm', 'https://ghcr.io/token'],
        ['service', 'ghcr.io'],
        ['scope', 'repository:user/test:pull']
      ])

      expect(isValidChallenge(attributes)).toBe(true)
    })

    it('should return false when realm is missing', () => {
      const attributes = new Map<string, string>([
        ['service', 'ghcr.io'],
        ['scope', 'repository:user/test:pull']
      ])

      expect(isValidChallenge(attributes)).toBe(false)
    })

    it('should return false when service is missing', () => {
      const attributes = new Map<string, string>([
        ['realm', 'https://ghcr.io/token'],
        ['scope', 'repository:user/test:pull']
      ])

      expect(isValidChallenge(attributes)).toBe(false)
    })

    it('should return false when scope is missing', () => {
      const attributes = new Map<string, string>([
        ['realm', 'https://ghcr.io/token'],
        ['service', 'ghcr.io']
      ])

      expect(isValidChallenge(attributes)).toBe(false)
    })

    it('should return false for empty map', () => {
      const attributes = new Map<string, string>()

      expect(isValidChallenge(attributes)).toBe(false)
    })

    it('should return true even with extra attributes', () => {
      const attributes = new Map<string, string>([
        ['realm', 'https://ghcr.io/token'],
        ['service', 'ghcr.io'],
        ['scope', 'repository:user/test:pull'],
        ['extra', 'value']
      ])

      expect(isValidChallenge(attributes)).toBe(true)
    })
  })

  describe('MapPrinter', () => {
    let printer: MapPrinter

    beforeEach(() => {
      printer = new MapPrinter()
    })

    it('should initialize with empty entries and maxLength of 1', () => {
      expect(printer.entries.size).toBe(0)
      expect(printer.maxLength).toBe(1)
    })

    it('should add entries and update maxLength', () => {
      printer.add('short', 'value1')
      printer.add('a very long key', 'value2')
      printer.add('medium', 'value3')

      expect(printer.entries.size).toBe(3)
      expect(printer.entries.get('short')).toBe('value1')
      expect(printer.entries.get('a very long key')).toBe('value2')
      expect(printer.entries.get('medium')).toBe('value3')
      expect(printer.maxLength).toBe('a very long key'.length)
    })

    it('should print entries with proper spacing', () => {
      const mockInfo = core.info as MockedFunction<typeof core.info>

      printer.add('key1', 'value1')
      printer.add('longer_key', 'value2')
      printer.add('k', 'value3')

      printer.print()

      expect(mockInfo).toHaveBeenCalledTimes(3)
      // The column width should be maxLength + 10
      const expectedColumn = 'longer_key'.length + 10
      expect(mockInfo).toHaveBeenNthCalledWith(
        1,
        `key1${''.padEnd(expectedColumn - 'key1'.length, ' ')}value1`
      )
      expect(mockInfo).toHaveBeenNthCalledWith(
        2,
        `longer_key${''.padEnd(expectedColumn - 'longer_key'.length, ' ')}value2`
      )
      expect(mockInfo).toHaveBeenNthCalledWith(
        3,
        `k${''.padEnd(expectedColumn - 'k'.length, ' ')}value3`
      )
    })

    it('should handle empty printer', () => {
      const mockInfo = core.info as MockedFunction<typeof core.info>

      printer.print()

      expect(mockInfo).not.toHaveBeenCalled()
    })

    it('should overwrite existing keys', () => {
      printer.add('key', 'value1')
      printer.add('key', 'value2')

      expect(printer.entries.size).toBe(1)
      expect(printer.entries.get('key')).toBe('value2')
    })
  })

  describe('CleanupTaskStatistics', () => {
    it('should initialize with provided values', () => {
      const stats = new CleanupTaskStatistics('test-package', 5, 10)

      expect(stats.name).toBe('test-package')
      expect(stats.numberMultiImagesDeleted).toBe(5)
      expect(stats.numberImagesDeleted).toBe(10)
    })

    it('should add statistics correctly', () => {
      const stats1 = new CleanupTaskStatistics('combined', 5, 10)
      const stats2 = new CleanupTaskStatistics('package2', 3, 7)

      const result = stats1.add(stats2)

      expect(result.name).toBe('combined')
      expect(result.numberMultiImagesDeleted).toBe(8)
      expect(result.numberImagesDeleted).toBe(17)
    })

    it('should handle adding with zero values', () => {
      const stats1 = new CleanupTaskStatistics('test', 5, 10)
      const stats2 = new CleanupTaskStatistics('test2', 0, 0)

      const result = stats1.add(stats2)

      expect(result.numberMultiImagesDeleted).toBe(5)
      expect(result.numberImagesDeleted).toBe(10)
    })

    it('should print statistics with multi-arch images', () => {
      const mockStartGroup = core.startGroup as MockedFunction<
        typeof core.startGroup
      >
      const mockInfo = core.info as MockedFunction<typeof core.info>
      const mockEndGroup = core.endGroup as MockedFunction<typeof core.endGroup>

      const stats = new CleanupTaskStatistics('test-package', 3, 15)
      stats.print()

      expect(mockStartGroup).toHaveBeenCalledWith(
        '[test-package] Cleanup statistics'
      )
      expect(mockInfo).toHaveBeenCalledWith(
        'multi architecture images deleted = 3'
      )
      expect(mockInfo).toHaveBeenCalledWith('total images deleted = 15')
      expect(mockEndGroup).toHaveBeenCalled()
    })

    it('should print statistics without multi-arch images when zero', () => {
      const mockStartGroup = core.startGroup as MockedFunction<
        typeof core.startGroup
      >
      const mockInfo = core.info as MockedFunction<typeof core.info>
      const mockEndGroup = core.endGroup as MockedFunction<typeof core.endGroup>

      const stats = new CleanupTaskStatistics('test-package', 0, 10)
      stats.print()

      expect(mockStartGroup).toHaveBeenCalledWith(
        '[test-package] Cleanup statistics'
      )
      expect(mockInfo).not.toHaveBeenCalledWith(
        expect.stringContaining('multi architecture images deleted')
      )
      expect(mockInfo).toHaveBeenCalledWith('total images deleted = 10')
      expect(mockEndGroup).toHaveBeenCalled()
    })

    it('should create immutable result when adding', () => {
      const stats1 = new CleanupTaskStatistics('original', 5, 10)
      const stats2 = new CleanupTaskStatistics('other', 3, 7)

      const result = stats1.add(stats2)

      // Original objects should remain unchanged
      expect(stats1.numberMultiImagesDeleted).toBe(5)
      expect(stats1.numberImagesDeleted).toBe(10)
      expect(stats2.numberMultiImagesDeleted).toBe(3)
      expect(stats2.numberImagesDeleted).toBe(7)

      // Result should be a new object
      expect(result).not.toBe(stats1)
      expect(result).not.toBe(stats2)
    })
  })

  describe('validateUserRegex', () => {
    it('accepts simple anchored patterns', () => {
      expect(() =>
        validateUserRegex('^v1\\.\\d+$', 'delete-tags')
      ).not.toThrow()
    })

    it('accepts wildcard-style patterns', () => {
      expect(() =>
        validateUserRegex('release-.*-rc', 'delete-tags')
      ).not.toThrow()
    })

    it('accepts character classes', () => {
      expect(() =>
        validateUserRegex('^[a-z]+-[0-9]+$', 'package')
      ).not.toThrow()
    })

    it('rejects nested-quantifier ReDoS patterns', () => {
      // Classic catastrophic-backtracking shape: (a+)+
      expect(() => validateUserRegex('(a+)+$', 'delete-tags')).toThrow(
        /ReDoS-prone/
      )
    })

    it('rejects ambiguous-alternation ReDoS patterns', () => {
      // (a|a)* / (.*)+ — exponential backtracking
      expect(() => validateUserRegex('(.*)+$', 'exclude-tags')).toThrow(
        /ReDoS-prone/
      )
    })

    it('includes the input source name in the error message', () => {
      expect(() => validateUserRegex('(a+)+', 'delete-tags')).toThrow(
        /^delete-tags:/
      )
    })

    it('rejects patterns over MAX_USER_REGEX_LENGTH', () => {
      const tooLong = 'a'.repeat(MAX_USER_REGEX_LENGTH + 1)
      expect(() => validateUserRegex(tooLong, 'package')).toThrow(
        /exceeds maximum length/
      )
    })

    it('accepts patterns at exactly MAX_USER_REGEX_LENGTH', () => {
      // Boundary case: the cap is inclusive (1000 chars allowed).
      const atLimit = 'a'.repeat(MAX_USER_REGEX_LENGTH)
      expect(() => validateUserRegex(atLimit, 'package')).not.toThrow()
    })
  })

  describe('warnIfUnanchoredRegex', () => {
    it('warns for a fully unanchored pattern', () => {
      warnIfUnanchoredRegex('1.0', 'delete-tags')
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringMatching(/^delete-tags:.*unanchored/)
      )
    })

    it('warns when only one end is anchored', () => {
      warnIfUnanchoredRegex('^v1.*', 'delete-tags')
      warnIfUnanchoredRegex('.*-rc$', 'exclude-tags')
      expect(core.warning).toHaveBeenCalledTimes(2)
    })

    it('stays silent for an anchored pattern', () => {
      warnIfUnanchoredRegex('^release-[0-9]+$', 'package')
      expect(core.warning).not.toHaveBeenCalled()
    })
  })

  describe('runWithConcurrency', () => {
    it('processes every item exactly once', async () => {
      const items = Array.from({ length: 25 }, (_, i) => i)
      const seen: number[] = []
      await runWithConcurrency(items, 5, async item => {
        seen.push(item)
      })
      expect(seen.sort((a, b) => a - b)).toEqual(items)
    })

    it('honors the concurrency cap', async () => {
      let inflight = 0
      let peak = 0
      const items = Array.from({ length: 30 }, (_, i) => i)
      await runWithConcurrency(items, 4, async () => {
        inflight++
        if (inflight > peak) peak = inflight
        await new Promise(resolve => setTimeout(resolve, 5))
        inflight--
      })
      expect(peak).toBeLessThanOrEqual(4)
      expect(peak).toBeGreaterThan(1)
    })

    it('propagates worker errors', async () => {
      await expect(
        runWithConcurrency([1, 2, 3], 2, async n => {
          if (n === 2) throw new Error('boom')
        })
      ).rejects.toThrow('boom')
    })

    it('stops starting new items after the first failure', async () => {
      // concurrency 1 makes ordering deterministic: item 2 throws, so
      // items 3-5 must never be started.
      const seen: number[] = []
      await expect(
        runWithConcurrency([1, 2, 3, 4, 5], 1, async n => {
          seen.push(n)
          if (n === 2) throw new Error('boom')
        })
      ).rejects.toThrow('boom')
      expect(seen).toEqual([1, 2])
    })

    it('stops peers from starting new items after one fails (concurrency > 1)', async () => {
      // Worker A fails on item 0 straight away; worker B is busy with
      // item 1. When B finishes it must see the failure and NOT pull
      // items 2+ — the core fail-fast property, which concurrency 1 can't
      // distinguish from the failing worker simply returning.
      const started: number[] = []
      await expect(
        runWithConcurrency([0, 1, 2, 3], 2, async n => {
          started.push(n)
          if (n === 0) throw new Error('boom')
          await new Promise(resolve => setTimeout(resolve, 20))
        })
      ).rejects.toThrow('boom')
      expect(started).toEqual([0, 1])
    })

    it('rejects even when the worker throws a falsy value', async () => {
      // Deliberately throwing non-Error values: a falsy rejection must
      // still fail the batch rather than resolve as success.
      await expect(
        runWithConcurrency([1], 1, async () => {
          // eslint-disable-next-line no-throw-literal
          throw undefined
        })
      ).rejects.toBeUndefined()
      await expect(
        runWithConcurrency([1], 1, async () => {
          // eslint-disable-next-line no-throw-literal
          throw 0
        })
      ).rejects.toBe(0)
    })

    it('rethrows the first error, not a later one', async () => {
      await expect(
        runWithConcurrency([0, 1], 2, async n => {
          if (n === 0) throw new Error('first')
          await new Promise(resolve => setTimeout(resolve, 10))
          throw new Error('second')
        })
      ).rejects.toThrow('first')
    })

    it('drains in-flight workers before returning (no detached work)', async () => {
      // item 0 throws immediately; items 1 and 2 are already in flight
      // with a delay. The call must not settle until they finish — so by
      // the time it rejects, both have completed (not left running in the
      // background as the old Promise.all-reject behavior did).
      let completed = 0
      await expect(
        runWithConcurrency([0, 1, 2], 3, async n => {
          if (n === 0) throw new Error('boom')
          await new Promise(resolve => setTimeout(resolve, 20))
          completed++
        })
      ).rejects.toThrow('boom')
      expect(completed).toBe(2)
    })

    it('handles empty input', async () => {
      const seen: number[] = []
      await runWithConcurrency([], 5, async n => {
        seen.push(n)
      })
      expect(seen).toEqual([])
    })

    it('clamps concurrency below items.length without losing items', async () => {
      // concurrency > items.length must not deadlock or drop work.
      const seen: number[] = []
      await runWithConcurrency([1, 2], 10, async n => {
        seen.push(n)
      })
      expect(seen.sort((a, b) => a - b)).toEqual([1, 2])
    })
  })

  describe('sleep', () => {
    it('resolves after the given delay', async () => {
      vi.useFakeTimers()
      try {
        let done = false
        const p = (async (): Promise<void> => {
          await sleep(1000)
          done = true
        })()
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(1000)
        await p
        expect(done).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
