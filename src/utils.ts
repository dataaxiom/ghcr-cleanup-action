import { createHash } from 'crypto'

/**
 * Calculates the digest of a manifest using the SHA256 algorithm.
 * @param manifest - The manifest to calculate the digest for.
 * @returns The calculated digest in the format "sha256:{digest}".
 */
export function calcDigest(manifest: string): string {
  return `sha256:${createHash('sha256').update(manifest).digest('hex').toLowerCase()}`
}

/**
 * Parses a challenge string and returns a map of attributes.
 * @param challenge - The challenge string to parse.
 * @returns A map of attributes parsed from the challenge string.
 */
export function parseChallenge(challenge: string): Map<string, string> {
  const attributes = new Map<string, string>()
  if (challenge.startsWith('Bearer ')) {
    challenge = challenge.replace('Bearer ', '')
    const parts = challenge.split(',')
    for (const part of parts) {
      const values = part.split('=')
      let value = values[1]
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1)
      }
      attributes.set(values[0], value)
    }
  }
  return attributes
}

/**
 * Checks if a challenge is valid based on the provided attributes.
 * @param attributes - A map of attribute names and values.
 * @returns A boolean indicating whether the challenge is valid or not.
 */
export function isValidChallenge(attributes: Map<string, string>): boolean {
  let valid = false
  if (
    attributes.has('realm') &&
    attributes.has('service') &&
    attributes.has('scope')
  ) {
    valid = true
  }
  return valid
}
