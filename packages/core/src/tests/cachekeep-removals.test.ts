import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  CACHE_KEEP_MAX_TARGETS,
  CACHE_KEEP_TTL_MS,
  CacheKeepManager,
} from '../cachekeep.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'

const storage: AccountStorage = {
  version: 1,
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, always: true },
}
const body = JSON.stringify({
  system: [
    { type: 'text', text: 'PRIVATE', cache_control: { type: 'ephemeral' } },
  ],
})
let now: number
let logs: LogTestRecord[]
let level: ReturnType<typeof getLogLevel>
const managers: CacheKeepManager[] = []

beforeEach(() => {
  now = new Date('2026-05-18T10:00:00').getTime()
  logs = []
  level = getLogLevel()
  setLogLevel('info')
  __setLogTestSink((record) => logs.push(record))
})
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop()
  __setLogTestSink(null)
  setLogLevel(level)
})

function fixture() {
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
  })
  managers.push(manager)
  const track = (id: string, bodyText = body, settings = storage) =>
    manager.track({
      sessionId: id,
      bodyText,
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      storage: settings,
      cacheMode: 'hybrid',
    })
  return { manager, track }
}

function warning(session: string, reason: string, bodyBytes: number) {
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatchObject({
    level: 'warn',
    channel: 'cachekeep',
    payload: {
      session,
      reason,
      bodyBytes,
      budgetBytes: 67_108_864,
      targets: expect.any(Number),
      maxTargets: 32,
    },
  })
  expect(JSON.stringify(logs)).not.toContain('PRIVATE')
  expect(JSON.stringify(logs)).not.toContain('bodyText')
}

test('budget eviction counts real UTF-8 bodies near 64 MiB and evicts user LRU', () => {
  expect(CACHE_KEEP_MAX_BODY_BYTES).toBe(64 * 1024 * 1024)
  const { manager, track } = fixture()
  const large = 'é'.repeat(16 * 1024 * 1024)
  expect(track('first', large).tracked).toBe(true)
  now++
  expect(track('second', large).tracked).toBe(true)
  expect(manager.trackedCount()).toBe(2)
  expect(logs).toEqual([])
  // Refreshing first makes second least recently used, despite insertion age.
  now++
  track('first', large)
  now++
  track('new', 'x')
  warning('second', 'budget', 32 * 1024 * 1024)
  expect(logs[0]?.payload).toMatchObject({
    totalBodyBytes: 67_108_865,
    targets: 3,
    cacheExpiresAt: now - 2 + CACHE_KEEP_TTL_MS,
  })
  expect(manager.trackedSessions().map((s) => s.id)).toEqual(['first', 'new'])
})

test('count eviction warns once with expiry and capacity numbers', () => {
  const { manager, track } = fixture()
  for (let i = 0; i <= CACHE_KEEP_MAX_TARGETS; i++) track(`s${i}`)
  warning('s0', 'count', Buffer.byteLength(body))
  expect(logs[0]?.payload).toMatchObject({
    targets: 33,
    totalBodyBytes: 33 * Buffer.byteLength(body),
    cacheExpiresAt: now + CACHE_KEEP_TTL_MS,
  })
  expect(manager.trackedCount()).toBe(32)
})

test('imminent prewarm protection can evict the new session instead of the oldest', () => {
  const { manager, track } = fixture()
  track('due', 'x'.repeat(32 * 1024 * 1024))
  now += 54 * 60_000
  const result = track('new', 'x'.repeat(32 * 1024 * 1024 + 1))
  warning('new', 'budget', 32 * 1024 * 1024 + 1)
  expect(logs[0]?.payload).toMatchObject({
    selection: 'imminent-protected',
    cacheExpiresAt: now + CACHE_KEEP_TTL_MS,
  })
  expect(result.tracked).toBe(false)
  expect(manager.trackedSessions().map((s) => s.id)).toEqual(['due'])
})

test('count protection chooses the oldest non-imminent session', () => {
  const { manager, track } = fixture()
  track('due')
  now += 54 * 60_000
  for (let i = 0; i < CACHE_KEEP_MAX_TARGETS; i++) track(`new${i}`)
  warning('new0', 'count', Buffer.byteLength(body))
  expect(logs[0]?.payload?.selection).toBe('imminent-protected')
  expect(manager.trackedSessions().some((s) => s.id === 'due')).toBe(true)
})

test('successful prewarms do not refresh user LRU order', async () => {
  const { manager, track } = fixture()
  track('s0')
  now += 2 * 60_000
  for (let i = 1; i < CACHE_KEEP_MAX_TARGETS; i++) track(`s${i}`)
  now += 53 * 60_000
  await manager.tick()
  // Only s0 was warmed. It must remain older than the later user turns.
  track('new')
  warning('s0', 'count', Buffer.byteLength(body))
  expect(logs[0]?.payload?.selection).toBeUndefined()
})

test.each([
  ['invalid-json', 'PRIVATE{'],
  ['no-breakpoints', '{"system":"PRIVATE"}'],
])(
  'skipped prewarm warns once for %s with live expiry',
  async (reason, text) => {
    const { manager, track } = fixture()
    track('skipped', text)
    now += 55 * 60_000
    await manager.tick()
    await manager.tick()
    warning('skipped', reason, Buffer.byteLength(text))
    expect(logs[0]?.payload?.cacheExpiresAt).toBe(now + 5 * 60_000)
    expect(manager.trackedCount()).toBe(0)
  },
)

test('schedule period changes warn when pruning a still-live session', () => {
  const { track } = fixture()
  const scheduled: AccountStorage = {
    ...storage,
    cacheKeep: { enabled: true, startHour: 9, endHour: 17 },
  }
  track('scheduled', body, scheduled)
  now += 60_000
  track('always', body)
  warning('scheduled', 'schedule-period-ended', Buffer.byteLength(body))
})

test('expiry pruning is not a live removal and emits no warning', () => {
  const { manager, track } = fixture()
  track('expired')
  now += CACHE_KEEP_TTL_MS
  manager.dropExpiredTargets()
  expect(manager.trackedCount()).toBe(0)
  expect(logs).toEqual([])
})

test.each([
  ['missing-session', 'missing session id'],
  ['disabled', 'cachekeep disabled'],
  ['not-hybrid', 'cache mode is not hybrid'],
  ['body-budget', 'body exceeds cachekeep memory budget'],
  ['outside-schedule', 'outside configured schedule'],
])('tracking refusal reports %s and the returned reason', (code, reason) => {
  setLogLevel('debug')
  const { manager } = fixture()
  const text = code === 'body-budget' ? 'é'.repeat(34 * 1024 * 1024) : body
  const result = manager.track({
    sessionId: code === 'missing-session' ? undefined : 'refused',
    bodyText: text,
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    cacheMode: code === 'not-hybrid' ? 'explicit' : 'hybrid',
    storage:
      code === 'disabled'
        ? { ...storage, cacheKeep: { enabled: false } }
        : code === 'outside-schedule'
          ? {
              ...storage,
              cacheKeep: { enabled: true, startHour: 12, endHour: 13 },
            }
          : storage,
  })
  expect(result).toEqual({ tracked: false, reason })
  expect(logs).toHaveLength(1)
  // Only the over-budget refusal is a warning, with the sizes that explain
  // it; normal policy exclusions are a short debug line.
  expect(logs[0]).toMatchObject(
    code === 'body-budget'
      ? {
          level: 'warn',
          payload: {
            session: 'refused',
            reason: code,
            detail: reason,
            bodyBytes: Buffer.byteLength(text),
            budgetBytes: 67_108_864,
            targets: 0,
          },
        }
      : {
          level: 'debug',
          payload: {
            session: code === 'missing-session' ? null : 'refused',
            reason: code,
          },
        },
  )
  expect(JSON.stringify(logs)).not.toContain('PRIVATE')
})
