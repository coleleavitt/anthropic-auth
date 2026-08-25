import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncRefreshedFallbackAccountInSharedStore } from '../shared-account-adapter.ts'
import {
  claimSharedAccountRefresh,
  loadSharedAccountStore,
  markSharedRefreshTokenDead,
  pickSharedAccount,
  recordSharedAccountQuota,
  releaseSharedAccountRefresh,
  type SharedAnthropicAccount,
} from '../shared-account-store.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})

const REFRESH = `sk-ant-ort01-${'a'.repeat(24)}`

function account(id: string, refresh = REFRESH): SharedAnthropicAccount {
  return {
    id,
    email: `${id}@example.com`,
    credential: {
      type: 'oauth',
      access: `sk-ant-oat01-${'a'.repeat(24)}`,
      refresh,
      expires_at: Date.now() + 60_000,
      account: { uuid: `uuid-${id}`, email_address: `${id}@example.com` },
      organization: { uuid: `org-${id}` },
    },
    enabled: true,
    created_at: '2026-08-14T00:00:00.000Z',
  }
}

async function storeWith(accounts: SharedAnthropicAccount[]) {
  const dir = await mkdtemp(join(tmpdir(), 'refresh-contention-'))
  dirs.push(dir)
  const path = join(dir, 'accounts.json')
  await writeFile(path, JSON.stringify({ version: 1, accounts }))
  return path
}

describe('refresh contention — only one caller may spend a token', () => {
  test('concurrent claimants: exactly one wins', async () => {
    // Anthropic revokes the whole family when a refresh token is presented
    // twice. Every caller past the first must be told to stand down, or the
    // account dies.
    const path = await storeWith([account('acct')])

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimSharedAccountRefresh('acct', REFRESH, { path }),
      ),
    )

    const claimed = claims.filter((c) => c.status === 'claimed')
    expect(claimed).toHaveLength(1)
    expect(claims.filter((c) => c.status === 'held')).toHaveLength(7)
  })

  test('the loser learns which process holds the claim', async () => {
    // Without the holder's pid a revoked family is unattributable after the
    // fact; with it the contention is reconstructable from the log alone.
    const path = await storeWith([account('acct')])

    const first = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(first.status).toBe('claimed')

    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('held')
    if (second.status !== 'held') throw new Error('unreachable')
    expect(second.holderPid).toBe(process.pid)
    expect(second.until).toBeGreaterThan(Date.now())
  })

  test('the claim is visible to a separate reader of the same store', async () => {
    // The claim only serialises processes if it lands on disk; an in-memory
    // guard would leave every other process free to spend the same token.
    const path = await storeWith([account('acct')])
    await claimSharedAccountRefresh('acct', REFRESH, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const lease = loaded.store.accounts[0]?.refresh_lease

    expect(lease?.holder_pid).toBe(process.pid)
    expect(lease?.token_fingerprint).toBeString()
    expect(lease?.claimed_at).toBeString()
  })

  test('the lease records a fingerprint, never the token', async () => {
    // The store holds the credential by design; the lease must not duplicate
    // it, so a leaked lease reveals nothing usable.
    const path = await storeWith([account('acct')])
    await claimSharedAccountRefresh('acct', REFRESH, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const lease = loaded.store.accounts[0]?.refresh_lease
    expect(JSON.stringify(lease)).not.toContain(REFRESH)
    expect(lease?.token_fingerprint).not.toBe(REFRESH)
    expect(lease?.token_fingerprint?.length).toBeGreaterThan(8)
  })

  test('claims on different accounts do not block each other', async () => {
    // Serialising per-account, not globally: two accounts can refresh at once.
    const path = await storeWith([
      account('one', `${REFRESH}-one`),
      account('two', `${REFRESH}-two`),
    ])

    const [a, b] = await Promise.all([
      claimSharedAccountRefresh('one', `${REFRESH}-one`, { path }),
      claimSharedAccountRefresh('two', `${REFRESH}-two`, { path }),
    ])

    expect(a.status).toBe('claimed')
    expect(b.status).toBe('claimed')
  })

  test('a caller holding a spent token is handed the winner, never a retry', async () => {
    // The critical path: after a peer rotates, this caller must NOT reach the
    // token endpoint — presenting the superseded token is what revokes.
    const path = await storeWith([account('acct')])
    const rotated = `sk-ant-ort01-${'z'.repeat(24)}`
    await writeFile(
      path,
      JSON.stringify({ version: 1, accounts: [account('acct', rotated)] }),
    )

    const claim = await claimSharedAccountRefresh('acct', REFRESH, { path })

    expect(claim.status).toBe('already-refreshed')
    if (claim.status !== 'already-refreshed') throw new Error('unreachable')
    expect(claim.credential.refresh).toBe(rotated)
  })

  test('a crashed holder does not wedge the account forever', async () => {
    // A process that dies mid-refresh must not lock the account out; the claim
    // expires so the next caller can take over.
    const path = await storeWith([account('acct')])
    const dead = await claimSharedAccountRefresh('acct', REFRESH, {
      path,
      ttlMs: -1,
    })
    expect(dead.status).toBe('claimed')

    const next = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(next.status).toBe('claimed')
  })

  test('releasing hands the claim to the next caller immediately', async () => {
    const path = await storeWith([account('acct')])
    const first = await claimSharedAccountRefresh('acct', REFRESH, { path })
    if (first.status !== 'claimed') throw new Error('expected a claim')

    await releaseSharedAccountRefresh('acct', first.leaseId, { path })

    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('claimed')
  })

  test('a stale lease id cannot release the live holder', async () => {
    // Otherwise a late release from a previous attempt would unlock an
    // in-flight refresh and let a second caller spend the same token.
    const path = await storeWith([account('acct')])
    const first = await claimSharedAccountRefresh('acct', REFRESH, { path })
    if (first.status !== 'claimed') throw new Error('expected a claim')

    await releaseSharedAccountRefresh('acct', 'stale-lease-id', { path })

    const second = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(second.status).toBe('held')
  })

  test('a serialised burst yields one spend per rotation, never two', async () => {
    // Models the real loop: claim, rotate, release, repeat. Each round must
    // spend exactly the token the store currently holds.
    const path = await storeWith([account('acct')])
    const spent: string[] = []
    let current = REFRESH

    for (let round = 0; round < 4; round += 1) {
      const claim = await claimSharedAccountRefresh('acct', current, { path })
      expect(claim.status).toBe('claimed')
      if (claim.status !== 'claimed') throw new Error('unreachable')

      spent.push(current)
      const rotated = `sk-ant-ort01-round-${round}`
      await writeFile(
        path,
        JSON.stringify({ version: 1, accounts: [account('acct', rotated)] }),
      )
      current = rotated
    }

    expect(new Set(spent).size).toBe(spent.length)
  })
})

describe('dead refresh tokens are never re-presented', () => {
  test('a marked token short-circuits before the network', async () => {
    // Anthropic's `invalid_grant` is terminal — the family never comes back.
    // Claude Code keeps the same registry in memory (`u2n`) and returns
    // `known_dead_refresh_token` rather than asking again.
    const path = await storeWith([account('acct')])
    await markSharedRefreshTokenDead('acct', REFRESH, { path })

    const claim = await claimSharedAccountRefresh('acct', REFRESH, { path })
    expect(claim.status).toBe('dead-token')
  })

  test('the verdict survives a reload, so a restart does not retry it', async () => {
    const path = await storeWith([account('acct')])
    await markSharedRefreshTokenDead('acct', REFRESH, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts[0]?.dead_refresh_fingerprint).toBeString()
    expect(loaded.store.accounts[0]?.last_error).toBe('invalid_grant')
  })

  test('a later rotation does not inherit its predecessor’s verdict', async () => {
    // Marking the account rather than the token would strand a healthy
    // credential obtained by a subsequent re-login.
    const path = await storeWith([account('acct')])
    await markSharedRefreshTokenDead('acct', REFRESH, { path })

    const rotated = `sk-ant-ort01-${'z'.repeat(24)}`
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            ...account('acct', rotated),
            dead_refresh_fingerprint: (
              await loadSharedAccountStore({ path, legacyPaths: [] })
            ).store.accounts[0]?.dead_refresh_fingerprint,
          },
        ],
      }),
    )

    const claim = await claimSharedAccountRefresh('acct', rotated, { path })
    expect(claim.status).toBe('claimed')
  })

  test('marking only applies to the token the account still holds', async () => {
    // A late failure report from a superseded attempt must not condemn the
    // credential that replaced it.
    const path = await storeWith([account('acct')])
    const superseded = `sk-ant-ort01-${'y'.repeat(24)}`

    await markSharedRefreshTokenDead('acct', superseded, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts[0]?.dead_refresh_fingerprint).toBeUndefined()
    expect(
      (await claimSharedAccountRefresh('acct', REFRESH, { path })).status,
    ).toBe('claimed')
  })

  test('marking clears any claim the dead attempt was holding', async () => {
    const path = await storeWith([account('acct')])
    await claimSharedAccountRefresh('acct', REFRESH, { path })

    await markSharedRefreshTokenDead('acct', REFRESH, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(loaded.store.accounts[0]?.refresh_lease).toBeUndefined()
  })
})

describe('quota attribution', () => {
  test('a reading lands only on the account it was taken from', async () => {
    // Regression: quota was recorded against whichever account selection
    // currently favoured, not the one the token belonged to. One exhausted
    // account's figures were stamped onto its neighbour, that neighbour was
    // then skipped, selection moved on, and the same figures were stamped
    // again — cascading until every account looked exhausted and routing had
    // nowhere left to go.
    const path = await storeWith([
      account('spent', `${REFRESH}-spent`),
      account('fresh', `${REFRESH}-fresh`),
    ])

    await recordSharedAccountQuota(
      'spent',
      { fiveHourPercent: 0, sevenDayPercent: 100 },
      { path },
    )

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const byId = new Map(loaded.store.accounts.map((a) => [a.id, a]))
    expect(byId.get('spent')?.quota?.seven_day_percent).toBe(100)
    expect(byId.get('fresh')?.quota).toBeUndefined()
  })

  test('an exhausted account does not make its neighbours unselectable', async () => {
    const path = await storeWith([
      account('spent', `${REFRESH}-spent`),
      account('fresh', `${REFRESH}-fresh`),
    ])
    await recordSharedAccountQuota('spent', { sevenDayPercent: 100 }, { path })

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    expect(pickSharedAccount(loaded.store)?.id).toBe('fresh')
  })
})

describe('a rotation must reach the shared store', () => {
  test('syncing prevents the next pass re-presenting the old token', async () => {
    // The single-process double-spend, in miniature. A refresh rotates the
    // token, but if the new one is only written to a per-app sidecar the
    // shared store still holds the old one — so the next routing pass reads it
    // and presents it a second time. Anthropic revokes the whole family on
    // that second presentation, and no cross-process claim can prevent it:
    // both spends genuinely believe they hold a live token.
    const path = await storeWith([account('acct', 'refresh-v1')])

    // A pass reads the store and refreshes.
    const first = await loadSharedAccountStore({ path, legacyPaths: [] })
    const held =
      first.store.accounts[0]?.credential.type === 'oauth'
        ? first.store.accounts[0].credential.refresh
        : undefined
    expect(held).toBe('refresh-v1')

    await syncRefreshedFallbackAccountInSharedStore(
      {
        id: 'acct',
        type: 'oauth',
        access: 'access-v2',
        refresh: 'refresh-v2',
        expires: Date.now() + 60_000,
      } as never,
      'refresh-v1',
      { path },
    )

    // The next pass must see the rotated token, not the spent one.
    const second = await loadSharedAccountStore({ path, legacyPaths: [] })
    const next =
      second.store.accounts[0]?.credential.type === 'oauth'
        ? second.store.accounts[0].credential.refresh
        : undefined
    expect(next).toBe('refresh-v2')

    // And the spent token is now recognised as spent rather than reused.
    const claim = await claimSharedAccountRefresh('acct', 'refresh-v1', {
      path,
    })
    expect(claim.status).toBe('already-refreshed')
  })

  test('a sync from a stale holder does not clobber a newer rotation', async () => {
    // Two passes overlap: the slower one must not write its older token over
    // the newer one, which would reintroduce the spent credential.
    const path = await storeWith([account('acct', 'refresh-v2')])

    await syncRefreshedFallbackAccountInSharedStore(
      {
        id: 'acct',
        type: 'oauth',
        access: 'access-stale',
        refresh: 'refresh-stale',
        expires: Date.now() + 60_000,
      } as never,
      // Expects v1, but the store already moved to v2.
      'refresh-v1',
      { path },
    )

    const loaded = await loadSharedAccountStore({ path, legacyPaths: [] })
    const current =
      loaded.store.accounts[0]?.credential.type === 'oauth'
        ? loaded.store.accounts[0].credential.refresh
        : undefined
    expect(current).toBe('refresh-v2')
  })
})
