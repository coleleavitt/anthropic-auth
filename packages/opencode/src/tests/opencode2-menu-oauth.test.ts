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

const GUIDANCE_COMMAND =
  'opencode auth login anthropic --method native-claude-oauth'
const MENU_IDENTITY =
  '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const MAIN_IDENTITY =
  '66666666-7777-4888-9999-aaaaaaaaaaaa' as ProviderAccountUuid
const MAIN_ACCESS = 'sk-ant-oat01-synthetic-main-access'

/**
 * Builds a real runtime on a disposable empty-init pool. Identity lookup is
 * keyed by access token so a pre-existing main account and the menu sign-in
 * resolve to different Claude accounts.
 */
const createMenuFixture = async () => {
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
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: { env },
    local: {
      resolveIdentity: async (access: string) => ({
        accountUuid: access === MAIN_ACCESS ? MAIN_IDENTITY : MENU_IDENTITY,
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
  return { runtime, capabilities }
}

/** Drives Start then Finish OAuth sign-in with only the token endpoint mocked. */
const signInThroughMenu = async (
  capabilities: ReturnType<typeof createNativeMenuCapabilities>,
  access: string,
  refresh: string,
) => {
  const sessionId = 'synthetic-menu-session'
  const started = await capabilities.dispatch(
    { action: 'add-oauth-start', values: {}, sessionId },
    {},
  )
  expect(started.ok).toBe(true)
  const url = new URL(started.text.match(/https:\/\/\S+/)![0])
  const state = url.searchParams.get('state')
  expect(state).toBeTruthy()
  let exchanges = 0
  const savedFetch = globalThis.fetch
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
  try {
    const finished = await capabilities.dispatch(
      {
        action: 'add-oauth-finish',
        values: { code: `synthetic-code#${state}`, label: 'Menu account' },
        sessionId,
      },
      {},
    )
    expect(exchanges).toBe(1)
    return finished
  } finally {
    globalThis.fetch = savedFetch
  }
}

test('OC2 menu OAuth sign-in stores the exchanged tokens as an OAuth credential', async () => {
  const { runtime, capabilities } = await createMenuFixture()
  try {
    const access = 'sk-ant-oat01-synthetic-menu-access'
    const finished = await signInThroughMenu(
      capabilities,
      access,
      'synthetic-menu-refresh',
    )
    expect(finished.ok).toBe(true)
    // The pool still has no main account, so the menu explains how to
    // connect OpenCode through the pool login.
    expect(finished.text).toContain(GUIDANCE_COMMAND)
    expect(finished.text).toContain(
      "Adding an account here does not change OpenCode's Anthropic connection.",
    )
    const snapshot = await runtime.read()
    expect(snapshot.accounts).toHaveLength(1)
    const account = snapshot.accounts[0]!
    expect(account).toMatchObject({
      label: 'Menu account',
      accountIdentity: MENU_IDENTITY,
      type: 'oauth',
    })
    expect(await runtime.authorizeLocal(account.id)).toMatchObject({
      status: 'usable',
      access,
    })
    const status = await capabilities.readStatus('account')
    expect(status).toContain('Menu account [fallback]: enabled, oauth, local')
    expect(status).toContain(`  Route: ${account.id}`)
    expect(status).toContain('Claude Pro / Max (native account pool)')
    expect(status).not.toContain(MENU_IDENTITY)
  } finally {
    capabilities.close()
    await runtime.close()
  }
})

test('OC2 menu OAuth sign-in omits the connection guidance when a main account exists', async () => {
  const { runtime, capabilities } = await createMenuFixture()
  try {
    // The registered pool login is what stores the main account.
    await runtime.loginOAuth({
      routeId: 'main',
      credential: {
        access: MAIN_ACCESS,
        refresh: 'synthetic-main-refresh',
        expires: Date.now() + 3_600_000,
      },
    })
    const finished = await signInThroughMenu(
      capabilities,
      'sk-ant-oat01-synthetic-menu-access',
      'synthetic-menu-refresh',
    )
    expect(finished).toEqual({
      ok: true,
      text: 'OAuth account stored in the native account pool.',
    })
    const snapshot = await runtime.read()
    expect(snapshot.accounts.map((account) => account.id)).toContain('main')
    expect(snapshot.accounts).toHaveLength(2)
    const status = await capabilities.readStatus('account')
    expect(status).toContain('Main account: enabled, oauth, local')
    expect(status).toContain('Menu account [fallback]: enabled, oauth, local')
    expect(status).not.toContain(GUIDANCE_COMMAND)
  } finally {
    capabilities.close()
    await runtime.close()
  }
})
