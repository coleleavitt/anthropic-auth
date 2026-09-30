/**
 * An in-memory stand-in for the account store, for plugin-level tests that
 * exercise routing, quota and sidebar behaviour with plain fixture tokens.
 * The real store (Rust binding) is covered by shared-auth.test.ts,
 * accounts.test.ts and the core suite, against a temp store and a mock token
 * endpoint.
 */
import type {
  AccessToken,
  AccountStorage,
  SharedAnthropicAccount,
  UnauthorizedResult,
} from '@cortexkit/anthropic-auth-core'
import type { StoreAccess } from '../../shared-auth.ts'

type Row = {
  id: string
  access: string
  expires: number
  enabled: boolean
  current: boolean
  refresh?: string
  refreshDead?: boolean
  lastError?: string
  /** Served by `handleUnauthorized` when this row's bearer gets a 401. */
  onUnauthorized?: { access: string; expires: number }
  /** What the store's own refresh yields once this row's token expired. */
  refreshTo?: { access: string; expires: number }
  /**
   * Without `refreshTo`, an expired row is "refreshed" by extending its
   * expiry (same bearer string, so header assertions stay readable).
   */
  autoRefresh?: boolean
}

export const OPENCODE_MAIN_ROW = 'opencode-main'

function codedError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

export class FixtureStore {
  readonly rows = new Map<string, Row>()
  readonly calls = {
    getAccessToken: [] as string[],
    refreshed: [] as string[],
    handleUnauthorized: [] as string[],
    keepAliveOnce: 0,
    importCredential: 0,
  }

  /** Every OAuth fixture account that carries an access token. */
  register(storage: AccountStorage | null | undefined) {
    for (const account of storage?.accounts ?? []) {
      if (account.type !== 'oauth' || !account.access) continue
      this.rows.set(account.id, {
        id: account.id,
        access: account.access,
        expires: account.expires ?? Number.MAX_SAFE_INTEGER,
        enabled: account.enabled !== false,
        current: false,
      })
    }
  }

  /** {@link register}, then drop rows (other than main) the list no longer names. */
  sync(storage: AccountStorage | null | undefined) {
    this.register(storage)
    const ids = new Set((storage?.accounts ?? []).map((account) => account.id))
    for (const id of [...this.rows.keys()]) {
      if (id !== OPENCODE_MAIN_ROW && !ids.has(id)) this.rows.delete(id)
    }
  }

  row(id: string) {
    const row = this.rows.get(id)
    if (!row) throw new Error(`no fixture row ${id}`)
    return row
  }

  private info(row: Row): SharedAnthropicAccount {
    return {
      id: row.id,
      kind: 'oauth',
      enabled: row.enabled,
      current: row.current,
      available: row.enabled,
      accessLive: row.expires > Date.now(),
      expiresAt: row.expires,
      refreshDead: row.refreshDead === true,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      scopes: ['user:inference'],
    }
  }

  access(): Partial<StoreAccess> {
    return {
      listAccounts: async () =>
        [...this.rows.values()].map((row) => this.info(row)),
      getAccessToken: async (accountId): Promise<AccessToken> => {
        this.calls.getAccessToken.push(accountId)
        const row = this.rows.get(accountId)
        if (!row) throw codedError('auth_required', `no account ${accountId}`)
        if (row.refreshDead) {
          throw codedError('invalid_grant', 'the refresh token is dead')
        }
        if (row.expires <= Date.now() && (row.refreshTo || row.autoRefresh)) {
          this.calls.refreshed.push(accountId)
          row.access = row.refreshTo?.access ?? row.access
          row.expires = row.refreshTo?.expires ?? Date.now() + 8 * 3_600_000
          row.refreshTo = undefined
          return {
            accessToken: row.access,
            accountId,
            expiresAt: row.expires,
            source: 'refreshed',
          }
        }
        return {
          accessToken: row.access,
          accountId,
          expiresAt: row.expires,
          source: 'store',
        }
      },
      handleUnauthorized: async (accessToken): Promise<UnauthorizedResult> => {
        this.calls.handleUnauthorized.push(accessToken)
        const row = [...this.rows.values()].find(
          (candidate) => candidate.access === accessToken,
        )
        if (!row?.onUnauthorized) {
          return {
            retry: false,
            reason: 'NoReplacement',
            failureCode: 'transient',
          }
        }
        row.access = row.onUnauthorized.access
        row.expires = row.onUnauthorized.expires
        row.onUnauthorized = undefined
        return {
          retry: true,
          reason: 'Refreshed',
          token: {
            accessToken: row.access,
            accountId: row.id,
            expiresAt: row.expires,
            source: 'refreshed',
          },
        }
      },
      keepAliveOnce: async () => {
        this.calls.keepAliveOnce += 1
        return {
          lease: 'acquired',
          refreshed: [],
          adopted: [],
          failed: [],
          skipped: [],
        }
      },
      markUsed: async () => true,
      // OpenCode's own credential becomes the store's current (main) row.
      importCredential: async (options) => {
        this.calls.importCredential += 1
        const existing = [...this.rows.values()].find(
          (row) => row.refresh && row.refresh === options.refreshToken,
        )
        if (existing) {
          return { status: 'already_present', accountId: existing.id }
        }
        for (const row of this.rows.values()) row.current = false
        this.rows.set(OPENCODE_MAIN_ROW, {
          id: OPENCODE_MAIN_ROW,
          access: options.accessToken,
          expires: options.expiresAt,
          enabled: true,
          current: true,
          refresh: options.refreshToken,
          autoRefresh: true,
        })
        return { status: 'added', accountId: OPENCODE_MAIN_ROW }
      },
    }
  }
}
