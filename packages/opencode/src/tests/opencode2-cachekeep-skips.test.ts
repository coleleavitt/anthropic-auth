import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  CACHE_KEEP_MAX_BODY_BYTES,
  getLogLevel,
  type LogTestRecord,
  type NativeAccountRuntime,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { createNativeCacheKeep } from '../v2/cachekeep'
import type { NativeSource } from '../v2/source'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type PreparedInput = Parameters<
  NonNullable<NativeSource['onRequestPrepared']>
>[0]
type Prepared = { -readonly [K in keyof PreparedInput]: PreparedInput[K] }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-skips-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const level = getLogLevel()
  const logs: LogTestRecord[] = []
  setLogLevel('debug')
  __setLogTestSink((record) => logs.push(record))
  cleanups.push(() => {
    __setLogTestSink(null)
    setLogLevel(level)
  })
  let now = Date.now()
  const binding = {
    storageId: randomUUID(),
    rowId: 'first',
    credentialEpoch: 0,
  }
  const policy = {
    version: 1,
    accounts: [],
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }
  const account = {
    id: 'first',
    accountIdentity: '11111111-2222-4333-8444-555555555555' as
      | string
      | undefined,
    binding,
    credentialId: 'credential-first',
    source: 'local',
  }
  let child = false
  let lookupFails = false
  let stopDuringRead = false
  let stopDuringLookup = false
  const runtime = {
    read: async () => {
      if (stopDuringRead) await keep.dispose()
      return { accounts: [account], policyStorage: policy }
    },
  } as unknown as NativeAccountRuntime
  const keep = createNativeCacheKeep({
    runtime,
    source: {} as NativeSource,
    storageId: binding.storageId,
    registryDirectory: directory,
    now: () => now,
    isSubagent: async () => {
      if (stopDuringLookup) await keep.dispose()
      if (lookupFails) throw new Error('PRIVATE host error')
      return child
    },
  })
  // Another live instance keeps the shared registry visible even when the
  // instance being tested is stopped during a tracking attempt.
  const observer = createNativeCacheKeep({
    runtime,
    source: {} as NativeSource,
    storageId: binding.storageId,
    registryDirectory: directory,
    now: () => now,
  })
  cleanups.push(async () => {
    now += 2 * 3600_000
    await observer.dispose()
    await keep.dispose()
  })
  const input = {
    sessionID: 'ses_skipped',
    route: 'oauth',
    agent: 'build',
    kind: 'primary',
    accountId: 'first',
    url: 'https://api.anthropic.com/v1/messages',
    bodyText: '{"system":"PRIVATE"}',
    provenance: { kind: 'local', subject: { binding } },
  } as Prepared
  return {
    keep,
    input,
    logs,
    policy,
    account,
    child: () => {
      child = true
    },
    lookupFails: () => {
      lookupFails = true
    },
    stopDuringRead: () => {
      stopDuringRead = true
    },
    stopDuringLookup: () => {
      stopDuringLookup = true
    },
  }
}

test.each([
  'lease-stopped',
  'not-oauth',
  'cachekeep-agent',
  'prime-agent',
  'not-primary',
  'session-lookup-failed',
  'subagents-disabled',
  'account-identity-missing',
  'local-binding-changed',
  'vault-credential-changed',
  'stopped-during-read',
  'stopped-during-lookup',
])(
  'OpenCode 2 tracking skip stays quiet and retains the existing target: %s',
  async (path) => {
    const f = await fixture()
    await f.keep.track(f.input)
    const tracked = await f.keep.registry.list()
    expect(tracked).toHaveLength(1)
    f.logs.length = 0
    switch (path) {
      case 'lease-stopped':
        await f.keep.dispose()
        break
      case 'not-oauth':
        f.input.route = 'api'
        break
      case 'cachekeep-agent':
        f.input.agent = 'cachekeep'
        break
      case 'prime-agent':
        f.input.agent = 'prime'
        break
      case 'not-primary':
        f.input.kind = 'auxiliary' as Prepared['kind']
        break
      case 'session-lookup-failed':
        f.lookupFails()
        break
      case 'subagents-disabled':
        f.child()
        break
      case 'account-identity-missing':
        f.account.accountIdentity = undefined
        break
      case 'local-binding-changed':
        f.account.binding = { ...f.account.binding, credentialEpoch: 1 }
        break
      case 'vault-credential-changed':
        f.input.provenance = {
          kind: 'vault',
          credentialId: 'replaced',
        } as Prepared['provenance']
        break
      case 'stopped-during-read':
        f.stopDuringRead()
        break
      case 'stopped-during-lookup':
        f.stopDuringLookup()
        break
    }
    await f.keep.track(f.input)
    expect(f.logs).toHaveLength(1)
    expect(f.logs[0]).toMatchObject({
      level: 'debug',
      channel: 'cachekeep',
      message: 'tracking skipped',
      payload: {
        session: 'ses_skipped',
        reason: path.endsWith('-agent')
          ? 'background-agent'
          : path.startsWith('stopped-during-')
            ? 'lease-stopped'
            : path,
      },
    })
    expect(f.logs.filter((record) => record.level === 'warn')).toEqual([])
    expect(await f.keep.registry.list()).toEqual(tracked)
    expect(JSON.stringify(f.logs)).not.toContain('PRIVATE')
  },
)

test('OpenCode 2 manager refusal reports its returned reason once, not just debug', async () => {
  const f = await fixture()
  await f.keep.track(f.input)
  const tracked = await f.keep.registry.list()
  f.logs.length = 0
  f.input.bodyText = 'é'.repeat(CACHE_KEEP_MAX_BODY_BYTES / 2 + 1)
  await f.keep.track(f.input)
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]).toMatchObject({
    level: 'warn',
    channel: 'cachekeep',
    payload: {
      session: 'ses_skipped',
      reason: 'body-budget',
      detail: 'body exceeds cachekeep memory budget',
      bodyBytes: 67_108_866,
      budgetBytes: 67_108_864,
      targets: 1,
    },
  })
  expect(await f.keep.registry.list()).toEqual(tracked)
})
