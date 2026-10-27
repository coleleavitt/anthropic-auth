import { expect } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProviderAccountUuid } from '../claude-code.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import {
  NativeMigrationError,
  runNativeMigration,
} from '../native-migration.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  type NativePoolPaths,
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
} from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { LEGACY_STATE_LAYOUT } from '../state-layout-paths.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const now = 1_000_000

// The local credential service accepts exactly these path keys and rejects any
// other own property, so a layout must never become a field of the paths.
const CREDENTIAL_SERVICE_PATH_KEYS = [
  'legacyConfig',
  'legacyState',
  'config',
  'state',
  'runtime',
  'journal',
  'roster',
  'storageId',
]

async function root() {
  const parent = new URL(
    '../../../../node_modules/.cache/state-layout-authorization/',
    import.meta.url,
  ).pathname
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fixture-'))
  deferCleanup(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function migrate(paths: NativePoolPaths, dir: string) {
  return runNativeMigration({
    paths,
    host: 'opencode',
    removePiAnthropicAuth: false,
    hostAuthPath: join(dir, 'host-auth'),
    routingSourcePath: join(dir, 'old-routing'),
    routingDestinationPath: resolveLocalRoutingDestination(
      'opencode',
      paths,
      {},
    ),
    env: {},
    processFence: async () => {},
  })
}

async function authorize(paths: NativePoolPaths) {
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now: () => now,
  })
  await store.initialize()
  await store.add({
    id: 'imported-main',
    identity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-synthetic-access',
      refresh: 'synthetic-refresh',
      expires: now + 3_600_000,
    },
  })
  await store.updateSettings((settings) => {
    settings.mainAccountId = 'imported-main'
  })
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          paths.legacyConfig,
          '..',
          'opencode-enrollment.json',
        ),
      },
    },
    local: {
      now: () => now,
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid,
      }),
      refreshToken: async () => {
        throw new Error('No refresh expected')
      },
    },
  })
  deferCleanup(async () => {
    await runtime.drainQuotaPublications()
    runtime.close()
  })
  return runtime.authorizeLocal('main')
}

test('legacy-layout paths keep the eight captured keys and authorize locally', async () => {
  const dir = await root()
  const config = join(dir, 'anthropic-auth.json')
  const state = join(dir, 'anthropic-auth-state.json')
  const paths = await resolveNativePoolPaths(config, state)
  expect(
    await resolveNativePoolPaths(config, state, LEGACY_STATE_LAYOUT),
  ).toEqual(paths)
  expect(Reflect.ownKeys(paths).sort()).toEqual(
    [...CREDENTIAL_SERVICE_PATH_KEYS].sort(),
  )
  await migrate(paths, dir)
  const result = await authorize(paths)
  expect(result.status).toBe('usable')
})

test('migration refuses paths resolved in a layout other than the process layout', async () => {
  const dir = await root()
  const sub = join(dir, 'state-home')
  await mkdir(sub)
  const config = join(dir, 'anthropic-auth.json')
  const state = join(dir, 'anthropic-auth-state.json')
  const moved = await resolveNativePoolPaths(config, state, {
    kind: 'state-home',
    dir: sub,
  })
  const error = await migrate(moved, dir).catch((caught) => caught)
  expect(error).toBeInstanceOf(NativeMigrationError)
  expect(error).toMatchObject({ code: 'invalid-source' })
  expect(
    (await readdir(sub)).filter((name) => !name.includes('.lock')),
  ).toEqual([])
  // The same call with paths from this process's layout succeeds.
  const legacy = await resolveNativePoolPaths(config, state)
  await expect(migrate(legacy, dir)).resolves.toBeDefined()
})
