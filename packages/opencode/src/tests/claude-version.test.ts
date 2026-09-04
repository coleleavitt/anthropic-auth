import { describe, expect, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  buildBillingHeaderValue,
  compareVersions,
  getCachedClaudeCodeVersion,
  getClaudeCodeUserAgent,
  getClaudeCodeVersion,
  resetClaudeCodeVersionCache,
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

  test('includes native Agent SDK and client-app identity details', () => {
    const previousEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    const previousSdk = process.env.CLAUDE_AGENT_SDK_VERSION
    const previousClient = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    try {
      process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
      process.env.CLAUDE_AGENT_SDK_VERSION = '0.3.153'
      process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'prime-agent'
      expect(getClaudeCodeUserAgent('2.1.260')).toBe(
        'claude-cli/2.1.260 (external, sdk-cli, agent-sdk/0.3.153, client-app/prime-agent)',
      )
    } finally {
      if (previousEntrypoint === undefined)
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = previousEntrypoint
      if (previousSdk === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION
      else process.env.CLAUDE_AGENT_SDK_VERSION = previousSdk
      if (previousClient === undefined)
        delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
      else process.env.CLAUDE_AGENT_SDK_CLIENT_APP = previousClient
    }
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

describe('live version tracking', () => {
  test('floor is at least 2.1.251 so Fable-era models are accepted offline', () => {
    resetClaudeCodeVersionCache()
    expect(
      compareVersions(getCachedClaudeCodeVersion(), '2.1.251'),
    ).toBeGreaterThanOrEqual(0)
  })

  test('adopts a newer npm latest version for subsequent headers', async () => {
    resetClaudeCodeVersionCache()
    const previousFetch = globalThis.fetch
    const previousDisable =
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
    globalThis.fetch = (async () =>
      Response.json({ version: '9.9.9' })) as unknown as typeof fetch
    try {
      await expect(getClaudeCodeVersion()).resolves.toBe('9.9.9')
      expect(getCachedClaudeCodeVersion()).toBe('9.9.9')
      expect(getClaudeCodeUserAgent()).toBe('claude-cli/9.9.9 (external, cli)')
    } finally {
      globalThis.fetch = previousFetch
      if (previousDisable !== undefined)
        process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK =
          previousDisable
      resetClaudeCodeVersionCache()
    }
  })

  test('never downgrades below the verified floor from a stale registry', async () => {
    resetClaudeCodeVersionCache()
    const floor = getCachedClaudeCodeVersion()
    const previousFetch = globalThis.fetch
    const previousDisable =
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
    globalThis.fetch = (async () =>
      Response.json({ version: '2.1.100' })) as unknown as typeof fetch
    try {
      await expect(getClaudeCodeVersion()).resolves.toBe(floor)
      expect(getCachedClaudeCodeVersion()).toBe(floor)
    } finally {
      globalThis.fetch = previousFetch
      if (previousDisable !== undefined)
        process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK =
          previousDisable
      resetClaudeCodeVersionCache()
    }
  })
})
