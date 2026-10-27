import { expect } from 'bun:test'
import { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { getSidebarStateFile } from '../sidebar-state'
import { restoreProcessTestFiles } from './support/opencode1-state-observers.ts'
import {
  cleanupTempConfigDirs,
  createOpencode1Test,
  createOpencode1TestContext,
  deferred,
  drainBeforeReset,
  installOpencode1TestHooks,
  withDeadlockGuard,
} from './support/opencode1-test-context.ts'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)

function cleanupTempConfigDirsForTest(drainTimeoutMs?: number) {
  return drainTimeoutMs === undefined
    ? cleanupTempConfigDirs(ctx)
    : cleanupTempConfigDirs(ctx, drainTimeoutMs)
}

test('withDeadlockGuard clears its timeout after the primary settles', async () => {
  // Count only the timer injected into this guard so concurrent suites cannot
  // affect the probe.
  const sentinelDelayMs = 47
  const guardTimers = new Set<unknown>()
  let timeoutFired = 0
  let timeoutCleared = 0
  let unhandled = 0
  const guardMessage = 'late guard'
  const onUnhandled = (reason: unknown) => {
    if (reason instanceof Error && reason.message === guardMessage) {
      unhandled += 1
    }
  }
  const setTimeoutImpl = ((
    callback: (...args: any[]) => void,
    delay?: number,
  ) => {
    const isGuardTimer = delay === sentinelDelayMs
    const handle = globalThis.setTimeout(() => {
      if (isGuardTimer) timeoutFired += 1
      callback()
    }, delay)
    if (isGuardTimer) guardTimers.add(handle)
    return handle
  }) as typeof globalThis.setTimeout
  const clearTimeoutImpl = ((
    timeout: ReturnType<typeof globalThis.setTimeout>,
  ) => {
    if (guardTimers.delete(timeout)) timeoutCleared += 1
    globalThis.clearTimeout(timeout)
  }) as typeof globalThis.clearTimeout
  process.on('unhandledRejection', onUnhandled)
  try {
    await withDeadlockGuard(
      Promise.resolve('primary'),
      sentinelDelayMs,
      guardMessage,
      { setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl },
    )
    await Bun.sleep(100)
    expect(timeoutFired).toBe(0)
    expect(timeoutCleared).toBe(1)
    expect(unhandled).toBe(0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('withDeadlockGuard rejects with its message at the deadline', async () => {
  await expect(
    withDeadlockGuard(new Promise<never>(() => {}), 20, 'deadline'),
  ).rejects.toThrow('deadline')
})

test('cleanup retries a fallback refresh that outlives its bounded wait', async () => {
  const slowRefresh = deferred()
  let settled = false
  const refresh = slowRefresh.promise.then(() => {
    settled = true
  })
  ctx.fallbackRefreshes.add(refresh)

  const firstStartedAt = Date.now()
  await cleanupTempConfigDirsForTest(50)
  expect(Date.now() - firstStartedAt).toBeLessThan(500)
  expect(settled).toBe(false)
  expect(ctx.fallbackRefreshes.has(refresh)).toBe(true)

  const releaseTimer = setTimeout(() => slowRefresh.resolve(), 20)
  try {
    await cleanupTempConfigDirsForTest(50)
  } finally {
    clearTimeout(releaseTimer)
  }
  expect(settled).toBe(true)
  expect(ctx.fallbackRefreshes.size).toBe(0)
})

test('test setup keeps sidebar state off the production default path', () => {
  const testDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  expect(typeof testDir).toBe('string')
  if (!testDir) throw new Error('missing test directory')
  restoreProcessTestFiles()
  expect(getSidebarStateFile().startsWith(`${testDir}/`)).toBe(true)
  expect(
    process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR?.startsWith(
      `${testDir}/`,
    ),
  ).toBe(true)
})

test('teardown drains an interrupted body before resetting its request transport', async () => {
  const scope = new TestLifetime()
  const resume = scope.gate()
  const events: string[] = []
  let transport = () => events.push('owned-request')
  const body = scope.runBody(async () => {
    await resume.wait
    events.push('body-resumed')
    transport()
  })
  await drainBeforeReset(scope, () => {
    events.push('transport-reset')
    transport = () => events.push('network-guard')
  })
  await body
  expect(events).toEqual(['body-resumed', 'owned-request', 'transport-reset'])
})
