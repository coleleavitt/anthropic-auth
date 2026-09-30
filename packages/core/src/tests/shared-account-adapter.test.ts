import { describe, expect, test } from 'bun:test'

import type {
  ApiKeyAccount,
  FallbackAccount,
  OAuthAccount,
} from '../accounts.ts'
import {
  isFirstPartyAnthropicApiAccount,
  materializeSharedFallbackAccounts,
  sharedAccountToFallback,
} from '../shared-account-adapter.ts'
import type { SharedAnthropicAccount } from '../shared-account-store.ts'

function row(
  id: string,
  overrides: Partial<SharedAnthropicAccount> = {},
): SharedAnthropicAccount {
  return {
    id,
    label: id,
    kind: 'oauth',
    enabled: true,
    current: false,
    available: true,
    accessLive: true,
    expiresAt: 2_000_000_000_000,
    refreshDead: false,
    scopes: ['user:inference'],
    ...overrides,
  }
}

const customRoute: ApiKeyAccount = {
  id: 'custom-route',
  type: 'api',
  apiKey: 'custom-key',
  baseURL: 'https://gateway.example.com',
  authHeader: 'authorization-bearer',
}

describe('store rows as host fallback accounts', () => {
  test('a materialized account carries no token and keeps host-only state', () => {
    const existing: OAuthAccount = {
      id: 'work',
      type: 'oauth',
      label: 'Work (host label)',
      addedAt: 1,
      authLineageId: 'lineage-1',
      quota: { checkedAt: 5, source: 'poll' },
      profile: { tier: 'max', orgType: 'personal', checkedAt: 3 },
    }
    const account = sharedAccountToFallback(
      row('work', {
        label: undefined,
        email: 'work@example.com',
        lastUsedAt: 42,
        refreshExpiresAt: 99,
      }),
      existing,
    )
    expect(account).toMatchObject({
      id: 'work',
      type: 'oauth',
      label: 'Work (host label)',
      enabled: true,
      addedAt: 1,
      lastUsed: 42,
      refreshExpires: 99,
      authLineageId: 'lineage-1',
      quota: { checkedAt: 5, source: 'poll' },
    })
    expect(account.access).toBeUndefined()
    expect('refresh' in account).toBe(false)
  })

  test("the store's dead-token verdict becomes a permanent refresh error", () => {
    const account = sharedAccountToFallback(
      row('dead', { refreshDead: true, lastError: 'invalid_grant' }),
    )
    expect(account.lastRefreshError).toMatchObject({
      message: 'invalid_grant',
      permanent: true,
    })
    const recovering = sharedAccountToFallback(
      row('flaky', { lastError: 'rate limited' }),
    )
    expect(recovering.lastRefreshError).toMatchObject({ permanent: false })
    expect(sharedAccountToFallback(row('ok')).lastRefreshError).toBeUndefined()
  })

  test('keeps the configured order and appends rows the host has never seen', () => {
    const legacy: FallbackAccount[] = [
      { id: 'b', type: 'oauth', label: 'B' },
      customRoute,
      { id: 'a', type: 'oauth', label: 'A' },
    ]
    const ids = materializeSharedFallbackAccounts(legacy, [
      row('a'),
      row('b'),
      row('c'),
    ]).map((account) => account.id)
    expect(ids).toEqual(['b', 'custom-route', 'a', 'c'])
  })

  test('drops host OAuth entries the store does not hold and skips the main row', () => {
    const legacy: FallbackAccount[] = [
      { id: 'yiyi', type: 'oauth' },
      { id: 'main', type: 'oauth' },
      { id: 'kept', type: 'oauth' },
    ]
    const ids = materializeSharedFallbackAccounts(
      legacy,
      [row('main'), row('kept')],
      { mainId: 'main' },
    ).map((account) => account.id)
    expect(ids).toEqual(['kept'])
  })

  test('store api_key rows are not materialized (the binding hands out no keys)', () => {
    const ids = materializeSharedFallbackAccounts(
      [],
      [row('key', { kind: 'api_key' }), row('oauth')],
    ).map((account) => account.id)
    expect(ids).toEqual(['oauth'])
  })

  test('recognises first-party API-key routes', () => {
    expect(isFirstPartyAnthropicApiAccount(customRoute)).toBe(false)
    expect(
      isFirstPartyAnthropicApiAccount({
        ...customRoute,
        baseURL: 'https://api.anthropic.com/v1/',
        authHeader: 'x-api-key',
      }),
    ).toBe(true)
  })
})
