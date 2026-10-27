import { expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectVaultRoster } from '@cortexkit/common-auth/claustrum'

import { stateRefusalCause } from '../holder-registry.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeCustodyClient } from '../native-custody.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { createNativeVaultRuntime } from '../native-vault-runtime.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import {
  nativeRelocationGuard,
  RELOCATED_MESSAGE,
  RelocatedError,
} from '../relocation-guard.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const uuid2 = '22222222-2222-4333-8444-555555555555'
const id = 'oauth:anthropic'
const now = 1_000_000
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]
const listed: Row = {
  id,
  accountId: uuid,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  state: 'active',
  operations: ['read'],
  recordVersion: 7,
  createdAtMs: null,
}

/**
 * Plant what a completed move of `paths` leaves behind: a committed
 * `layout.json` and `config-dir.json` in a state-home folder, the journal
 * set aside, and relocation tombstones over both legacy runtime files. This
 * version never reads the marker; its guards see the tombstones.
 */
async function plantCommittedMove(root: string, paths: NativePoolPaths) {
  const stateRoot = join(root, 'state', 'cortexkit', 'anthropic-auth')
  const sub = join(stateRoot, 'opencode')
  const attempt = 'attempt-1'
  const identity = join(root, 'config')
  await mkdir(sub, { recursive: true })
  await writeFile(
    join(sub, 'config-dir.json'),
    JSON.stringify({ version: 1, identity }),
  )
  await writeFile(
    join(sub, 'layout.json'),
    JSON.stringify({
      version: 1,
      phase: 'committed',
      attempt,
      identity,
      stateRoot,
      sub,
      oldDir: identity,
      storageIds: {
        local: paths.storageId,
        vault: nativeVaultPaths(paths).storageId,
      },
      cleanup: 'pending',
    }),
  )
  await rename(paths.journal, `${paths.journal}.moving-${attempt}`).catch(
    () => {},
  )
  const tombstone = JSON.stringify({
    version: 0,
    relocatedTo: sub,
    stateRoot,
    identity,
    attempt,
    by: '2.4.0',
  })
  await writeFile(paths.runtime, tombstone, { mode: 0o600 })
  await writeFile(nativeVaultPaths(paths).runtime, tombstone, { mode: 0o600 })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relocation-guard-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'config')
  await mkdir(config)
  const paths = await resolveNativePoolPaths(
    join(config, 'anthropic-auth.json'),
  )
  await initializeNativeTestAuthority(paths)
  const vaultPaths = nativeVaultPaths(paths)
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'opencode-enrollment.json',
    ),
  }
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: vaultPaths,
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  const projected = projectVaultRoster(
    undefined,
    {
      view: 'initial',
      credentials: [
        {
          credentialId: id,
          credentialType: 'oauth',
          accountIdentity: uuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now },
  )
  const primaryRouteId = projected.rows[0]?.routeId
  if (!primaryRouteId) throw new Error('Missing fixture primary route')
  await store.updateSettings((settings) => {
    settings.mainAccountId = primaryRouteId
    settings.claustrum = {
      primaryAccount: { credentialId: id, accountId: uuid, state: 'active' },
    }
  })
  let rows: readonly Row[] = [listed]
  let version = 7
  const client: NativeCustodyClient = {
    listScoped: async () => ({
      view: `view-${rows.length}-${rows.map((row) => row.accountId).join()}`,
      rows,
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
      material: `synthetic-bearer-${version}`,
      recordVersion: version,
      expiresAtMs: now + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const vault = {
    env,
    now: () => now,
    connect: async () => client,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
  }
  const runtime = createNativeVaultRuntime({
    ...vault,
    paths,
    host: 'opencode',
  })
  deferCleanup(async () => {
    await runtime.drainQuotaPublications()
    runtime.close()
  })
  return {
    root,
    paths,
    vaultPaths,
    vault,
    runtime,
    move: () => plantCommittedMove(root, paths),
    rows: (value: readonly Row[]) => {
      rows = value
    },
    version: (value: number) => {
      version = value
    },
  }
}

async function readText(path: string) {
  return readFile(path, 'utf8').catch(() => undefined)
}

test('vault authorize returns no receipt once the dataset has moved', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  expect((await f.runtime.authorize('main')).credentialId).toBe(id)
  await f.move()
  const error = await f.runtime.authorize('main').catch((caught) => caught)
  expect(error).toBeInstanceOf(RelocatedError)
  expect(error.message).toBe(RELOCATED_MESSAGE)
})

test('vault prepareRetry issues no new receipt once the dataset has moved', async () => {
  const control = await fixture()
  await control.runtime.refresh()
  const servedBefore = await control.runtime.authorize('main')
  control.version(8)
  const retried = await control.runtime.prepareRetry(servedBefore)
  expect(retried).not.toMatchObject({ reason: 'reauthorize-failed' })

  const f = await fixture()
  await f.runtime.refresh()
  const served = await f.runtime.authorize('main')
  f.version(8)
  await f.move()
  expect(await f.runtime.prepareRetry(served)).toEqual({
    retry: false,
    reason: 'reauthorize-failed',
    code: 'unavailable',
  })
})

test('discovery publishes no roster once the dataset has moved', async () => {
  const control = await fixture()
  await control.runtime.refresh()
  const second = { ...listed, id: 'oauth:anthropic:work', accountId: uuid2 }
  control.rows([listed, second])
  expect((await control.runtime.refresh())?.rows).toHaveLength(2)

  const f = await fixture()
  await f.runtime.refresh()
  const roster = await readText(f.vaultPaths.roster)
  f.rows([listed, second])
  await f.move()
  await f.runtime.refresh().catch(() => undefined)
  expect(await readText(f.vaultPaths.roster)).toBe(roster)
})

test('setEnabled writes no roster once the dataset has moved', async () => {
  const control = await fixture()
  await control.runtime.refresh()
  expect(await control.runtime.setEnabled('main', false)).toBe(true)

  const f = await fixture()
  await f.runtime.refresh()
  const roster = await readText(f.vaultPaths.roster)
  await f.move()
  const error = await f.runtime
    .setEnabled('main', false)
    .catch((caught) => caught)
  expect(error).toBeInstanceOf(RelocatedError)
  expect(await readText(f.vaultPaths.roster)).toBe(roster)
})

test('the primary pin writes no settings once the dataset has moved', async () => {
  const control = await fixture()
  await control.runtime.refresh()
  await rm(control.vaultPaths.config)
  await control.runtime.initializeSettings()
  expect(await readText(control.vaultPaths.config)).toBeDefined()

  const f = await fixture()
  await f.runtime.refresh()
  await rm(f.vaultPaths.config)
  await f.move()
  const error = await f.runtime.initializeSettings().catch((caught) => caught)
  expect(stateRefusalCause(error)).toBeInstanceOf(RelocatedError)
  expect(await readText(f.vaultPaths.config)).toBeUndefined()
})

test('a vault store write refuses in its locked hook once the dataset has moved', async () => {
  const f = await fixture()
  const accounts = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: f.vault,
  })
  deferCleanup(async () => {
    await accounts.drainQuotaPublications()
    await accounts.close()
  })
  await accounts.updateSettings((settings) => {
    settings.routing = { mode: 'sticky-balanced' }
  })
  const settings = await readText(f.vaultPaths.config)
  expect(settings).toContain('sticky-balanced')
  await f.move()
  const error = await accounts
    .updateSettings((settings) => {
      settings.routing = { mode: 'main-first' }
    })
    .catch((caught) => caught)
  expect(stateRefusalCause(error)).toBeInstanceOf(RelocatedError)
  // The store keeps the refusal's fixed text, which is what hosts show.
  expect(error.message).toBe(RELOCATED_MESSAGE)
  expect(await readText(f.vaultPaths.config)).toBe(settings)
})

test('routing writes and the routing seed write no temporary file once the dataset has moved', async () => {
  const f = await fixture()
  const input = (sessionId: string) => ({
    sessionId,
    family: 'general' as const,
    candidates: [
      { accountId: 'main', order: 0, quota: { kind: 'unknown' as const } },
    ],
    retainAccountIds: new Set(['main']),
    storage: null,
    inputBytes: 1,
  })
  const guard = nativeRelocationGuard(f.paths)
  const control = new StickySessionRouter({
    path: join(f.root, 'control-routing.json'),
    relocationGuard: guard,
  })
  await control.resolve(input('control'))
  await control.drain()
  expect(await readText(join(f.root, 'control-routing.json'))).toBeDefined()

  await f.move()
  const routingDir = join(f.root, 'routing')
  await mkdir(routingDir)
  const router = new StickySessionRouter({
    path: join(routingDir, 'routing.json'),
    relocationGuard: guard,
  })
  await router.resolve(input('moved'))
  await router.drain()
  const seeded = new StickySessionRouter({
    path: join(routingDir, 'seeded-routing.json'),
    vaultSeed: {
      legacyConfig: f.paths.legacyConfig,
      roster: f.vaultPaths.roster,
    },
    relocationGuard: guard,
  })
  await seeded.prepareLegacySeed({
    version: 1,
    complete: true,
    rows: [],
  } as never)
  await seeded.drain().catch(() => {})
  // Only lock files may have come and gone; no state or temporary file.
  expect(
    (await readdir(routingDir)).filter((name) => !name.includes('.lock')),
  ).toEqual([])
})

test('without a move every guard passes and nothing about the files changes', async () => {
  const f = await fixture()
  const guard = nativeRelocationGuard(f.paths)
  await guard.assertNotRelocated()
  expect(await guard.isRelocated()).toBe(false)
  // An ordinary runtime file, valid or not, is not a tombstone.
  await writeFile(f.paths.runtime, '{"version": 0}')
  expect(await guard.isRelocated()).toBe(false)
  await writeFile(f.paths.runtime, 'not json')
  expect(await guard.isRelocated()).toBe(false)
  // A layout marker alone, with no tombstone, changes nothing in this release.
  await mkdir(join(f.root, 'state'), { recursive: true })
  await writeFile(join(f.root, 'state', 'layout.json'), '{}')
  expect(await guard.isRelocated()).toBe(false)
})
