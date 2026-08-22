import { describe, expect, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  buildBillingHeaderValue,
  compareVersions,
  getCachedClaudeCodeVersion,
  getClaudeCodeUserAgent,
} from '@cortexkit/anthropic-auth-core'

describe('compareVersions', () => {
  test('orders by major, minor, then patch', () => {
    expect(compareVersions('2.1.233', '2.1.232')).toBe(1)
    expect(compareVersions('2.1.232', '2.1.233')).toBe(-1)
    expect(compareVersions('2.1.233', '2.1.233')).toBe(0)
    expect(compareVersions('2.2.0', '2.1.999')).toBe(1)
    expect(compareVersions('3.0.0', '2.9.9')).toBe(1)
  })

  test('compares numerically, not lexicographically', () => {
    expect(compareVersions('2.1.100', '2.1.99')).toBe(1)
  })

  test('ignores prerelease suffixes for ordering', () => {
    expect(compareVersions('2.1.233-canary.1', '2.1.233')).toBe(0)
  })
})

describe('getClaudeCodeUserAgent', () => {
  test('matches the claude-cli user agent shape', () => {
    expect(getClaudeCodeUserAgent('2.1.233')).toBe(
      'claude-cli/2.1.233 (external, cli)',
    )
  })

  test('defaults to the cached version used by the request headers', () => {
    expect(getClaudeCodeUserAgent()).toBe(
      `claude-cli/${getCachedClaudeCodeVersion()} (external, cli)`,
    )
  })
})

describe('version wiring', () => {
  test('request headers use the same version source as the billing header', () => {
    const version = getCachedClaudeCodeVersion()
    const userAgent = applyClaudeCodeHeaders(
      new Headers(),
      'sk-ant-oat-test',
    ).get('user-agent')
    const billing = buildBillingHeaderValue(
      [{ role: 'user', content: 'audit header capture' }],
      undefined,
      'cli',
    )

    expect(userAgent).toBe(`claude-cli/${version} (external, cli)`)
    expect(billing).toContain(`cc_version=${version}.`)
  })
})
