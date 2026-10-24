import { expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  type ProviderAccountUuid,
  publishNativeEmptyInit,
  resolveNativePoolPaths,
  TOKEN_URL,
} from '@cortexkit/anthropic-auth-core'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { createNativeMenuCapabilities } from '../v2/menu'
import type { NativeSource } from '../v2/source'

const { test, deferCleanup } = createTestLifetimeSuite()

test('OC2 menu OAuth sign-in stores the exchanged tokens as an OAuth credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode2-menu-oauth-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'legacy.json'),
    join(root, 'legacy-state.json'),
  )
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(root, 'routing.json'),
  }
  await publishNativeEmptyInit({
    paths,
    routingDestinationPath: env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE,
    processFence: async () => {},
    env,
  })
  const identity = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: { env },
    local: {
      resolveIdentity: async () => ({
        accountUuid: identity,
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
      }),
    },
  })
  const capabilities = createNativeMenuCapabilities({
    runtime,
    source: {} as NativeSource,
    start: async () => {},
  })
  const savedFetch = globalThis.fetch
  try {
    const sessionId = 'synthetic-menu-session'
    const started = await capabilities.dispatch(
      { action: 'add-oauth-start', values: {}, sessionId },
      {},
    )
    expect(started.ok).toBe(true)
    const url = new URL(started.text.match(/https:\/\/\S+/)![0])
    const state = url.searchParams.get('state')
    expect(state).toBeTruthy()
    const access = 'sk-ant-oat01-synthetic-menu-access'
    const refresh = 'synthetic-menu-refresh'
    let exchanges = 0
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toBe(TOKEN_URL)
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          code: 'synthetic-code',
          state,
          grant_type: 'authorization_code',
        })
        exchanges++
        return Response.json({
          access_token: access,
          refresh_token: refresh,
          expires_in: 3600,
        })
      },
      { preconnect: savedFetch.preconnect },
    )
    const finished = await capabilities.dispatch(
      {
        action: 'add-oauth-finish',
        values: { code: `synthetic-code#${state}`, label: 'Menu account' },
        sessionId,
      },
      {},
    )
    expect(finished.ok).toBe(true)
    expect(finished.text).toContain(
      'opencode auth login anthropic --method native-claude-oauth',
    )
    expect(finished.text).toContain(
      "Adding an account here does not change OpenCode's Anthropic connection.",
    )
    expect(exchanges).toBe(1)
    const snapshot = await runtime.read()
    expect(snapshot.accounts).toHaveLength(1)
    const account = snapshot.accounts[0]!
    expect(account).toMatchObject({
      label: 'Menu account',
      accountIdentity: identity,
      type: 'oauth',
    })
    expect(await runtime.authorizeLocal(account.id)).toMatchObject({
      status: 'usable',
      access,
    })
    const status = await capabilities.readStatus('account')
    expect(status).toContain('Menu account [fallback]: enabled, oauth, local')
    expect(status).toContain('Claude Pro / Max (native account pool)')
    expect(status).not.toContain(identity)
  } finally {
    capabilities.close()
    await runtime.close()
    globalThis.fetch = savedFetch
  }
})
