import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  createNativePoolStore,
  formatLogLine,
  getLogLevel,
  logger,
  resolveNativePoolPaths,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { PiNativeRuntime } from '../native.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(override = false, vaultMode = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-log-startup-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const keys = [
    'PI_CODING_AGENT_DIR',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
    'OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  ] as const
  const env = keys.map((key) => [key, process.env[key]] as const)
  const previous = getLogLevel()
  cleanups.push(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  const path = join(directory, 'accounts.json')
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      logging: { level: vaultMode ? 'warn' : 'debug' },
    },
    path,
  )
  if (vaultMode) {
    const enrollment = join(directory, 'enrollment.json')
    await writeFile(
      enrollment,
      JSON.stringify({
        token: '01'.repeat(32),
        token_generation: 1,
      }),
      { mode: 0o600 },
    )
    process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = enrollment
    const store = createNativePoolStore({
      paths: nativeVaultPaths(await resolveNativePoolPaths(path)),
      quota: nativeQuotaCodec,
    })
    await store.initialize()
    await store.updateSettings((settings) => ({
      ...settings,
      logging: { level: 'debug' },
    }))
  }
  const lines: string[] = []
  __setLogTestSink(({ level, channel, message, payload }) => {
    lines.push(formatLogLine(level, channel, message, payload))
  })
  if (override) process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = 'warn'
  setLogLevel(override ? 'warn' : 'info')
  const runtime = new PiNativeRuntime(path, {
    connect: async () => {
      throw new Error('No vault discovery needed for startup logging')
    },
    vaultPoll: {
      intervalMs: 2000,
      setInterval: (() => {
        logger.debug('startup-test', 'starting Pi watcher')
        return { unref() {} }
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    },
  })
  cleanups.push(() => runtime.close())
  await runtime.service()
  return lines
}

test('Pi applies saved debug before starting its account watcher', async () => {
  const lines = await start()
  expect(getLogLevel()).toBe('debug')
  expect(
    lines.some(
      (line) => line.includes('DEBUG') && line.includes('starting Pi watcher'),
    ),
  ).toBe(true)
})

test('Pi startup preserves the environment log-level override', async () => {
  const lines = await start(true)
  expect(getLogLevel()).toBe('warn')
  expect(lines.some((line) => line.includes('starting Pi watcher'))).toBe(false)
})

test('Pi startup reads saved logging from vault rather than local settings', async () => {
  const lines = await start(false, true)
  expect(getLogLevel()).toBe('debug')
  expect(
    lines.some(
      (line) => line.includes('DEBUG') && line.includes('starting Pi watcher'),
    ),
  ).toBe(true)
})
