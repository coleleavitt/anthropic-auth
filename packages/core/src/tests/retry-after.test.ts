/**
 * Retry-After parsing (still used by the quota endpoint). Ported from the
 * deleted ClaudeOAuthRefreshError tests, which exercised the same parser.
 */
import { expect, test } from 'bun:test'

import { parseRetryAfterHeader, parseRetryAfterSeconds } from '../auth.ts'

test('captures Retry-After as seconds', () => {
  expect(parseRetryAfterHeader('60')).toBe(60)
})

test('captures Retry-After as an HTTP date', () => {
  const futureDate = new Date(Date.now() + 120_000).toUTCString()
  const seconds = parseRetryAfterHeader(futureDate)
  expect(seconds).toBeGreaterThan(0)
  expect(seconds).toBeLessThanOrEqual(121)
})

test('is undefined when the header is missing or unparseable', () => {
  expect(parseRetryAfterHeader(undefined)).toBeUndefined()
  expect(parseRetryAfterHeader(null)).toBeUndefined()
  expect(parseRetryAfterHeader('garbage')).toBeUndefined()
})

test('prefers retry-after-ms over retry-after', () => {
  expect(parseRetryAfterSeconds('60', '1500')).toBe(2)
  expect(parseRetryAfterSeconds('60', 'garbage')).toBe(60)
})
