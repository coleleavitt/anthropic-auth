import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getClaudeCodeIdentityForVerifiedAccount,
  type NativeCustodyClient,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import {
  holdRefreshJoin,
  observeRefreshJoin,
  refreshedJoinAccess,
  refreshJoinMessage,
} from '../../../core/src/tests/native-refresh-join-fixture.ts'
import {
  holdQuotaPublicationForRefresh,
  quotaRefreshAccess,
} from '../../../core/src/tests/native-refresh-quota-fixture.ts'
import { requestLockProbe } from '../../../core/src/tests/native-request-lock-fixture.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

const lifetimes = createTestLifetimeSuite()
const model: Model<Api> = {
  id: 'claude-fable-5-1',
  name: 'Fable',
  provider: 'anthropic',
  api: 'cortexkit-anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}
const quota = () => ({
  checkedAt: Date.now(),
  five_hour: {
    checkedAt: Date.now(),
    remainingPercent: 100,
    usedPercent: 0,
    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
  },
  seven_day: {
    checkedAt: Date.now(),
    remainingPercent: 100,
    usedPercent: 0,
    resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
  },
})
for (const scenario of [
  'local-healthy',
  'vault-healthy',
  'refresh',
  'join-proactive',
  'join-401',
  'join-deadline',
  'quota-refresh',
] as const) {
  lifetimes.test(
    scenario === 'quota-refresh'
      ? 'Pi saved refresh serves the successor across a pending quota publication'
      : scenario.startsWith('join-')
        ? `Pi refresh join ${scenario.slice(5)} preserves valid-token admission`
        : `Pi ${scenario} request observes only required foreground locks`,
    () =>
      trackPiTestBody(
        (async () => {
          const directory = await mkdtemp(join(tmpdir(), 'pi-request-locks-'))
          const storagePath = join(directory, 'anthropic-auth.json')
          const originalFetch = globalThis.fetch
          const keys = [
            'PI_CODING_AGENT_DIR',
            'PI_ANTHROPIC_AUTH_FILE',
            'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
            'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
          ] as const
          const saved = new Map(keys.map((key) => [key, process.env[key]]))
          lifetimes.deferCleanup(async () => {
            await closePiNativeRuntime(storagePath)
            globalThis.fetch = originalFetch
            for (const [key, value] of saved) {
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
            await rm(directory, { recursive: true, force: true })
          })
          process.env.PI_CODING_AGENT_DIR = directory
          process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
          await saveNativePiFixture(
            {
              version: 1,
              accounts: [],
              routing: { mode: 'sticky-balanced' },
              quota: { enabled: false, mainQuota: quota() },
            },
            storagePath,
          )
          const probe = requestLockProbe()
          const held = holdRefreshJoin(lifetimes)
          const quotaRefresh =
            scenario === 'quota-refresh'
              ? holdQuotaPublicationForRefresh(lifetimes)
              : undefined
          const identity = fixtureAccountIdentity('main')
          const client: NativeCustodyClient = {
            async listScoped() {
              return {
                view: 'ready-lock-proof',
                rows: [
                  {
                    id: 'oauth:anthropic',
                    accountId: identity,
                    credentialType: 'oauth',
                    categories: ['anthropic-native'],
                    serves: ['anthropic'],
                    providerIds: [],
                    refreshAdapter: 'anthropic',
                    operations: ['read'],
                    state: 'active',
                    recordVersion: 1,
                    createdAtMs: 1,
                  },
                ],
                grants: undefined,
                grantTuples: undefined,
              }
            },
            async getScoped() {
              return {
                credentialId: 'oauth:anthropic',
                accountId: identity,
                material: 'sk-ant-oat01-ready-vault',
                recordVersion: 1,
                expiresAtMs: Date.now() + 3600_000,
              }
            },
            async reportAuthFailureScoped() {},
            close() {},
          }
          if (scenario === 'vault-healthy') {
            const enrollment = join(directory, 'enrollment.json')
            process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = enrollment
            await writeFile(
              enrollment,
              JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
              { mode: 0o600 },
            )
          }
          const now = () => Date.now() + 2 * 3600_000
          const native = getPiNativeRuntime(storagePath, {
            vaultPoll: { intervalMs: 0 },
            ...(scenario === 'vault-healthy'
              ? { connect: async () => client }
              : {}),
            local: {
              onLockEvent: probe.onLockEvent,
              ...(quotaRefresh
                ? {
                    refreshToken: quotaRefresh.refreshToken,
                    resolveIdentity: async () =>
                      getClaudeCodeIdentityForVerifiedAccount('main', identity),
                  }
                : {}),
              ...(scenario.startsWith('join-')
                ? {
                    refreshToken: held.refreshToken,
                    resolveIdentity: async () =>
                      getClaudeCodeIdentityForVerifiedAccount('main', identity),
                  }
                : {}),
              ...(scenario === 'refresh'
                ? {
                    now,
                    refreshToken: async () => ({
                      access: 'sk-ant-oat01-refreshed-control',
                      refresh: 'synthetic-control-refresh',
                      expires: now() + 3600_000,
                      expiresIn: 3600,
                    }),
                    resolveIdentity: async () =>
                      getClaudeCodeIdentityForVerifiedAccount('main', identity),
                  }
                : {}),
            },
          })
          const runtime = await native.service()
          if (scenario === 'vault-healthy') {
            await runtime.vault.refresh()
            await runtime.updateSettings((settings) => {
              settings.routing = { mode: 'sticky-balanced' }
              settings.quota = { enabled: false }
            })
            const receipt = await runtime.authorizeVault('main')
            await runtime.vault.publish(receipt, {
              quota: { ...quota(), accountIdentity: identity },
            })
          }
          await runtime.read()
          await runtime.drainRoutingPublications()
          const sent: string[] = []
          const completedAtDispatch: boolean[] = []
          globalThis.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url =
                input instanceof Request ? input.url : input.toString()
              if (!url.includes('/v1/messages')) return Response.json({})
              sent.push(new Headers(init?.headers).get('authorization') ?? '')
              completedAtDispatch.push(held.completed())
              probe.dispatch()
              if (
                (scenario === 'join-401' ||
                  scenario === 'join-deadline' ||
                  quotaRefresh) &&
                sent.length === 1
              )
                return Response.json(
                  {
                    type: 'error',
                    error: {
                      type: 'authentication_error',
                      message: 'Rejected fixture credential',
                    },
                  },
                  { status: 401 },
                )
              return new Response(
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
              )
            },
            { preconnect: originalFetch.preconnect },
          )
          if (quotaRefresh) {
            await quotaRefresh.poll(runtime)
            const result = await streamCortexKitAnthropic(model, context, {
              sessionId: 'quota-refresh',
            }).result()
            expect(result.stopReason).toBe('stop')
            expect(sent).toHaveLength(2)
            expect(sent[1]).toBe(`Bearer ${quotaRefreshAccess}`)
            expect(quotaRefresh.exchanges()).toBe(1)
            expect(await runtime.authorizeLocal('main')).toMatchObject({
              status: 'usable',
              source: 'current',
              access: quotaRefreshAccess,
            })
            return
          }
          if (scenario.startsWith('join-')) {
            const send = (sessionId: string) =>
              streamCortexKitAnthropic(model, context, { sessionId }).result()
            const owner =
              scenario === 'join-proactive'
                ? runtime.authorizeLocal('main', { intent: 'refresh' })
                : send('join-owner')
            void owner.catch(() => {})
            let waiting: ReturnType<typeof send> | undefined
            try {
              await held.entered
              probe.begin()
              waiting = send('join-waiter')
              if (scenario === 'join-proactive') {
                expect(await observeRefreshJoin(waiting)).toMatchObject({
                  status: 'fulfilled',
                  value: { stopReason: 'stop' },
                })
                expect(completedAtDispatch).toEqual([false])
                expect(probe.foreground).toEqual([])
              } else if (scenario === 'join-401') {
                expect((await observeRefreshJoin(waiting, 100)).status).toBe(
                  'pending',
                )
                expect(sent).toHaveLength(1)
                held.release()
                expect(await waiting).toMatchObject({ stopReason: 'stop' })
                expect(await owner).toMatchObject({ stopReason: 'stop' })
                expect(sent.slice(1)).toEqual([
                  `Bearer ${refreshedJoinAccess}`,
                  `Bearer ${refreshedJoinAccess}`,
                ])
              } else {
                expect(await observeRefreshJoin(waiting, 3_500)).toMatchObject({
                  status: 'fulfilled',
                  value: {
                    stopReason: 'error',
                    errorMessage: refreshJoinMessage,
                  },
                })
                expect(held.completed()).toBe(false)
                expect(sent).toHaveLength(1)
              }
            } finally {
              held.release()
              await Promise.allSettled([owner, ...(waiting ? [waiting] : [])])
            }
            return
          }
          probe.begin()
          const result = await streamCortexKitAnthropic(model, context, {
            sessionId: `lock-proof-${directory}`,
          }).result()
          expect(result.stopReason).toBe('stop')
          if (scenario === 'refresh')
            expect(
              probe.foreground.some((event) =>
                event.name.startsWith('native-account-provider-'),
              ),
            ).toBe(true)
          else expect(probe.foreground).toEqual([])
          await closePiNativeRuntime(storagePath)
          expect(probe.detached.some((event) => event.name === 'write')).toBe(
            true,
          )
          expect(probe.afterDispatch.length).toBeGreaterThan(0)
          expect(
            probe.afterDispatch.some(
              (event) => event.name === 'native-runtime',
            ),
          ).toBe(true)
          // Vault bookkeeping after the reply writes runtime state under its own
          // lock only; it must never take the shared roster lock, which other
          // processes need for quota readings and discovery.
          if (scenario === 'vault-healthy')
            expect(
              probe.afterDispatch.some(
                (event) => event.name === 'claustrum-roster-write',
              ),
            ).toBe(false)
        })(),
      ),
    scenario.startsWith('join-') ? 8_000 : undefined,
  )
}
