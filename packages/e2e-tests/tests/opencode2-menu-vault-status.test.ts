import { expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  createNativeUi,
  publishNativeEmptyInit,
} from '@cortexkit/anthropic-auth-core'
import { connectNativeVaultScopedClient } from '../../core/src/native-vault-runtime'
import { nativeVaultPaths } from '../../core/src/native-vault-paths'
import { createTestLifetimeSuite } from '../../core/src/tests/test-lifetime'
import { resolveNativeSetupPaths } from '../../opencode/src/setup/native-paths'
import { createNativeMenuCapabilities } from '../../opencode/src/v2/menu'
import type { NativeSource } from '../../opencode/src/v2/source'
import {
  type FakeClaustrumCredential,
  startFakeClaustrumDaemon,
} from '../src/mock-claustrum'

const { test, deferCleanup, gate } = createTestLifetimeSuite()

const VAULT_EMPTY =
  'No Claude accounts in the vault for this host yet. Add one with `ck auth login --provider anthropic`, then grant it to this host.'
const TRANSPORT_REFUSAL =
  'request refused: WebSocket relay is not supported on OpenCode 2; select HTTP relay or direct transport'
const credential: FakeClaustrumCredential = {
  payload: 'synthetic-access-token',
  account_id: '11111111-2222-4333-8444-555555555555',
  record_version: 1,
  expires_at_ms: Date.now() + 3_600_000,
}

async function fixture(
  options: {
    credentials?: Record<string, FakeClaustrumCredential>
    local?: boolean
    beforeConnect?: () => Promise<void>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'oc2-menu-vault-'))
  const env = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(root, 'routing.json'),
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(root, 'legacy-state.json'),
  }
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  )
  let dispose = async () => {}
  Object.assign(process.env, env)
  deferCleanup(async () => {
    await dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(env.HOME, { recursive: true })
  const { paths, routingDestinationPath } = await resolveNativeSetupPaths(
    'opencode',
    env,
  )
  await publishNativeEmptyInit({
    paths,
    routingDestinationPath,
    processFence: async () => {},
    env,
  })
  if (!options.local)
    await writeFile(
      env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
  const daemon = await startFakeClaustrumDaemon({
    directory: root,
    scopedCredentials: options.credentials,
  })
  dispose = () => daemon.stop()
  let connects = 0
  let http = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    http++
    throw new Error('Status must not call Anthropic')
  }) as unknown as typeof fetch
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env,
      connect: async () => {
        connects++
        await options.beforeConnect?.()
        return connectNativeVaultScopedClient(daemon.connectionFile)
      },
    },
  })
  const menu = createNativeMenuCapabilities({
    runtime,
    source: {} as NativeSource,
    start: async () => {},
  })
  // Close the runtime before removing files, so late discovery cannot publish into a deleted fixture.
  dispose = async () => {
    menu.close()
    await runtime.close()
    await daemon.stop()
    globalThis.fetch = previousFetch
  }
  return {
    runtime,
    menu,
    daemon,
    paths: options.local ? paths : nativeVaultPaths(paths),
    env,
    counts: () => ({ connects, http }),
  }
}

test('Status discovers a scoped vault account before any request and writes the roster', async () => {
  const { menu, runtime, paths, daemon, counts } = await fixture({
    credentials: { 'oauth:anthropic': credential },
  })
  expect((await runtime.read()).accounts).toEqual([])
  expect(await Bun.file(paths.roster).exists()).toBe(false)
  const ui = createNativeUi({
    host: 'opencode',
    dispatch: menu.dispatch,
    readStatus: (command) => menu.readStatus(command),
    readAccounts: () => runtime.read(),
    readMode: async () => 'claustrum',
    disconnectVault: async () => {
      throw new Error('Unexpected vault disconnect')
    },
    interactive: true,
  })
  const opened = await ui.open({ sessionId: 'synthetic-session', notify() {} })
  const status = opened.menu.sections
    .find((section) => section.id === 'Accounts')!
    .lines.join('\n')
  expect(status).toContain('oauth:anthropic [main]: enabled, oauth, vault, active')
  expect((await runtime.read()).accounts[0]?.credentialId).toBe(
    'oauth:anthropic',
  )
  expect(JSON.parse(await readFile(paths.roster, 'utf8')).rows).toMatchObject([
    { credentialId: 'oauth:anthropic' },
  ])
  expect(daemon.scopedLists).toBe(1)
  expect(daemon.credentialGets).toEqual([])
  expect(counts()).toEqual({ connects: 1, http: 0 })
})

test('Status names an empty vault rather than a local account pool', async () => {
  const { menu, daemon } = await fixture()
  expect(await menu.readStatus('account')).toBe(VAULT_EMPTY)
  expect(daemon.scopedLists).toBe(1)
  expect(daemon.credentialGets).toEqual([])
})

test('Status reports rejected vault metadata without exposing identifiers', async () => {
  const { menu, paths } = await fixture({
    credentials: { 'private-rejected-id': { ...credential, account_id: '' } },
  })
  const status = await menu.readStatus('account')
  expect(status).toContain(
    'The vault returned an account this plugin cannot use yet.',
  )
  expect(status).not.toContain('private-rejected-id')
  expect(status).not.toContain('No native Claude accounts.')
  expect(
    JSON.parse(await readFile(paths.roster, 'utf8')).rejected,
  ).toHaveLength(1)
})

test('Status refuses WebSocket relay before listing the vault', async () => {
  const { menu, runtime, daemon, paths, counts } = await fixture({
    credentials: { 'oauth:anthropic': credential },
  })
  await runtime.updateRelay({
    enabled: true,
    transport: 'websocket',
    url: 'wss://relay.invalid',
    token: 'synthetic-relay-token',
  })
  expect(await menu.readStatus('account')).toBe(TRANSPORT_REFUSAL)
  expect(daemon.scopedLists).toBe(0)
  expect(daemon.credentialGets).toEqual([])
  expect(await Bun.file(paths.roster).exists()).toBe(false)
  expect(counts()).toEqual({ connects: 0, http: 0 })
})

test('Status keeps the local empty text and does not contact the vault', async () => {
  const { menu, counts, daemon } = await fixture({ local: true })
  expect(await menu.readStatus('account')).toBe(
    [
      'No native Claude accounts.',
      '',
      'For first-time model access, connect Anthropic with "Claude Pro / Max (native account pool)".',
      'Run: opencode auth login anthropic --method native-claude-oauth',
      "Quota refresh checks the pool; it does not check OpenCode's Anthropic connection.",
    ].join('\n'),
  )
  expect(counts()).toEqual({ connects: 0, http: 0 })
  expect(daemon.scopedLists).toBe(0)
})

test('Status requires active enrollment before discovering accounts', async () => {
  const { menu, env, counts, daemon } = await fixture()
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    '{invalid',
  )
  await expect(menu.readStatus('account')).rejects.toThrow()
  expect(counts()).toEqual({ connects: 0, http: 0 })
  expect(daemon.scopedLists).toBe(0)
})

test('Status bounds a slow discovery wait and the shared discovery still publishes later', async () => {
  const release = gate()
  const { menu, runtime, daemon, counts } = await fixture({
    credentials: { 'oauth:anthropic': credential },
    beforeConnect: () => release.wait,
  })
  const started = performance.now()
  const [first, second] = await Promise.all([
    menu.readStatus('account'),
    menu.readStatus('account'),
  ])
  const elapsed = performance.now() - started
  expect(first).toContain('Vault account lookup is still running.')
  expect(second).toBe(first)
  expect(first).not.toContain(VAULT_EMPTY)
  expect(elapsed).toBeGreaterThanOrEqual(1900)
  // Allow scheduler overhead, but not the vault connection's ten-second timeout.
  expect(elapsed).toBeLessThan(2500)
  expect(counts()).toEqual({ connects: 1, http: 0 })
  release.open()
  await runtime.vault.refresh()
  expect((await runtime.read()).accounts[0]?.credentialId).toBe(
    'oauth:anthropic',
  )
  expect(daemon.scopedLists).toBe(1)
  expect(daemon.credentialGets).toEqual([])
})
