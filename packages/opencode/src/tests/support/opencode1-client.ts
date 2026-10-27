import { expect, mock } from 'bun:test'
import type {
  CommandApplyRequest,
  CommandApplyResult,
} from '@cortexkit/anthropic-auth-core'
import { drainNotifications } from '../../rpc/notifications'
import { createRpcClient } from '../../rpc/rpc-client'
import { MESSAGES_URL } from '../test-fetch'
import {
  EMPTY_POST,
  type Opencode1TestContext,
} from './opencode1-test-context.ts'

export type TestPlugin = {
  auth: {
    loader: (
      hostGetAuth: () => Promise<Record<string, unknown>>,
      provider: unknown,
    ) => Promise<{ fetch: typeof fetch }>
    methods: Array<{
      label: string
      type: string
      authorize?: (...args: unknown[]) => unknown
      provider?: string
    }>
    provider: string
  }
  provider?: {
    id: string
    models?: (...args: unknown[]) => unknown
  }
  event: (event: unknown) => Promise<unknown> | unknown
  dispose?: () => unknown
  'command.execute.before': (input: {
    command: string
    arguments: string
    sessionID: string
  }) => Promise<unknown>
  'chat.headers': (input: unknown, output: unknown) => Promise<unknown>
  'chat.message': (input: unknown, output: unknown) => Promise<unknown>
  'experimental.chat.system.transform': (
    input: unknown,
    output: unknown,
  ) => Promise<unknown>
  'experimental.chat.messages.transform': (
    input: unknown,
    output: unknown,
  ) => Promise<unknown>
}

// Minimal mock of the OpenCode plugin client
export function createMockClient(
  messages?: unknown[],
  getSessionStatuses?: () =>
    | Record<string, { type: string }>
    | Promise<Record<string, { type: string }>>,
) {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
    session: {
      messages: messages
        ? mock(() => Promise.resolve({ data: messages }))
        : undefined,
      status: getSessionStatuses
        ? mock(async () => ({ data: await getSessionStatuses() }))
        : undefined,
      promptAsync: mock((_input: unknown) => Promise.resolve()),
    },
  }
}

export async function expectHandledCommandResponse(promise: Promise<unknown>) {
  try {
    await promise
    throw new Error('Expected handled command sentinel')
  } catch (error) {
    expect(String(error)).toContain(
      '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__',
    )
    const value = error as Record<string, unknown>
    expect(value['~effect/http/HttpServerResponse']).toBe(
      '~effect/http/HttpServerResponse',
    )
    expect(value['~effect/ErrorReporter/ignore']).toBe(true)
    expect(value.status).toBe(204)
    expect((value.body as { _tag?: unknown })?._tag).toBe('Empty')
    expect((value.cookies as { cookies?: unknown })?.cookies).toEqual({})
  }
}

/** The latest ignored reply text sent to a session without a connected TUI. */
export function latestIgnoredReply(
  client: ReturnType<typeof createMockClient>,
) {
  const calls = (
    client.session.promptAsync as unknown as {
      mock: {
        calls: Array<
          [{ body: { parts: Array<{ text: string; ignored?: boolean }> } }]
        >
      }
    }
  ).mock.calls
  const part = calls.at(-1)?.[0]?.body.parts[0]
  expect(part?.ignored).toBe(true)
  return part?.text ?? ''
}

/** Open /claude for a TUI-connected session and return the menu payload. */
export async function openClaudeMenu(plugin: TestPlugin, sessionId: string) {
  // The TUI polls its session's notifications; the plugin treats a recent
  // poll as a connected TUI, so draining here makes the session interactive.
  drainNotifications(0, sessionId)
  await expectHandledCommandResponse(
    plugin['command.execute.before']({
      command: 'claude',
      arguments: '',
      sessionID: sessionId,
    }),
  )
  const notice = drainNotifications(0, sessionId).at(-1)
  if (notice?.type !== 'open-menu')
    throw new Error('Expected the /claude menu notification')
  drainNotifications(notice.id, sessionId)
  return notice.payload
}

/**
 * Open /claude, then submit one menu action through the plugin's RPC server
 * the way the TUI renderer does. The plugin starts that server only when it
 * is given a project directory, so create it with the migrated root.
 */
export async function applyMenuAction(
  ctx: Opencode1TestContext,
  plugin: TestPlugin,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  await openClaudeMenu(plugin, sessionId)
  const rpcDir = process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR
  if (!rpcDir) throw new Error('Missing isolated RPC directory')
  // Provider mocks reject loopback URLs; only the RPC request goes to the
  // preload's loopback-only fetch.
  const providerFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new URL(input instanceof Request ? input.url : String(input)).hostname ===
      '127.0.0.1'
        ? ctx.loopbackFetch(input, init)
        : providerFetch(input, init),
    { preconnect: providerFetch.preconnect },
  ) as typeof fetch
  try {
    return await createRpcClient(rpcDir, process.pid).applyMenu({
      command: 'claude',
      sessionId,
      ...request,
    })
  } finally {
    globalThis.fetch = providerFetch
  }
}

/** Fire 5 concurrent fetch requests against /v1/messages. */
export function fireConcurrentFetches(result: { fetch: typeof fetch }) {
  return Promise.all(
    Array.from({ length: 5 }, () => result.fetch(MESSAGES_URL, EMPTY_POST)),
  )
}
