import { expect, test } from 'bun:test'
import {
  createSidebarSchedule,
  type SidebarSchedule,
  sidebarRetryDelay,
} from '../tui/claude-sidebar'

// The OpenCode 2 sidebar schedules its own refresh retries. These run the real
// schedule with its timer functions replaced by a fake clock, so a 30 s
// back-off is checked without waiting for it and without touching the shared
// globals the rest of the test process uses.
const realSetTimeout = globalThis.setTimeout

interface PendingTimer {
  id: number
  at: number
  callback: () => unknown
}

// A timer queue with a clock the test advances by hand. The ids are plain
// numbers so a test can inspect them; the fake keeps the extra arguments
// `setTimeout` passes, so it cannot change how the code under test calls it.
function fakeTimers() {
  let now = 0
  let sequence = 0
  const pending: PendingTimer[] = []
  const setTimeoutImpl = ((
    callback: (...callbackArgs: unknown[]) => unknown,
    delay = 0,
    ...args: unknown[]
  ) => {
    const id = ++sequence
    pending.push({ id, at: now + delay, callback: () => callback(...args) })
    return id
  }) as unknown as typeof setTimeout
  const clearTimeoutImpl = (handle: unknown) => {
    const index = pending.findIndex((timer) => timer.id === handle)
    if (index >= 0) pending.splice(index, 1)
  }
  return {
    now: () => now,
    setTimeoutImpl,
    clearTimeoutImpl,
    pending: () => pending.length,
    // A read is a promise chain: it starts in a later turn, then queues the
    // next timer once it settles. A real event-loop turn lets that finish
    // while the fake queue stays idle, as the clock does not move on its own.
    settle: () => new Promise<void>((resolve) => realSetTimeout(resolve, 5)),
    // Runs every timer due within `ms`, in the order it is due, letting each
    // read it starts finish before the clock moves on.
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const timer = [...pending].sort((a, b) => a.at - b.at)[0]
        if (!timer || timer.at > end) break
        pending.splice(pending.indexOf(timer), 1)
        now = Math.max(timer.at, now)
        timer.callback()
        await this.settle()
      }
      now = end
      await this.settle()
    },
  }
}

interface RunningSchedule {
  timers: ReturnType<typeof fakeTimers>
  reads: number[]
  schedule: SidebarSchedule
}

// Starts the real schedule. `answers[i]` decides whether read `i` succeeds;
// the last entry repeats once the list runs out. Each read is recorded with
// the fake clock's time. With `holdReads`, a read waits for `release()` after
// it starts, so the test can stop the schedule mid-read.
async function start(
  answers: boolean[],
  options: { holdReads?: boolean } = {},
): Promise<RunningSchedule & { release: () => void }> {
  const timers = fakeTimers()
  const reads: number[] = []
  const gates: Array<() => void> = []
  const schedule = createSidebarSchedule({
    sessionId: 'ses_oc2',
    pollRate: () => ({ pollMs: 100, retryMaxMs: 30_000 }),
    onState: () => {},
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    read: async () => {
      const index = reads.length
      reads.push(timers.now())
      await Promise.resolve()
      if (options.holdReads) {
        await new Promise<void>((resolve) => gates.push(resolve))
      }
      if (!answers[Math.min(index, answers.length - 1)]) {
        throw new Error('sidebar refused')
      }
      return {
        main: { quota: null },
        fallbacks: [],
        route: 'main',
        relay: null,
        fastMode: false,
        lastUpdated: timers.now(),
      }
    },
  })
  schedule.start()
  // Let the first read start (and, when held, stop there) before the test
  // moves on.
  for (let turn = 0; turn < 20 && reads.length === 0; turn++)
    await timers.settle()
  if (!options.holdReads) await timers.settle()
  return { timers, reads, schedule, release: () => gates.shift()?.() }
}

test('sidebarRetryDelay keeps the poll rate until a failure', () => {
  expect(sidebarRetryDelay(1500, 0, 30_000)).toBe(1500)
  expect(sidebarRetryDelay(100, 1, 30_000)).toBe(200)
  expect(sidebarRetryDelay(100, 6, 30_000)).toBe(6400)
  // Past the limit the wait stays there instead of doubling without bound.
  expect(sidebarRetryDelay(100, 9, 30_000)).toBe(30_000)
  // A configured poll rate above the limit is never slowed down by it.
  expect(sidebarRetryDelay(60_000, 1, 30_000)).toBe(30_000)
})

test('a successful sidebar poll runs at the configured interval', async () => {
  const run = await start([true])
  try {
    await run.timers.advance(500)
    // The first read is immediate; the timer then fires every 100 ms.
    expect(run.reads).toEqual([0, 100, 200, 300, 400, 500])
    const gaps = run.reads.slice(1).map((at, i) => at - run.reads[i]!)
    expect(gaps).toEqual([100, 100, 100, 100, 100])
  } finally {
    run.schedule.stop()
  }
})

test('a failing sidebar poll backs off, doubling up to half a minute', async () => {
  // The first read succeeds, every later one fails.
  const run = await start([true, false])
  try {
    await run.timers.advance(120_000)
    // 0 succeeds, so the first wait is one poll interval; every wait after it
    // belongs to a failed read: 200, 400, 800, ... 25600, then half a minute.
    expect(run.reads.slice(0, 10)).toEqual([
      0, 100, 300, 700, 1_500, 3_100, 6_300, 12_700, 25_500, 51_100,
    ])
    const gaps = run.reads.slice(1).map((at, i) => at - run.reads[i]!)
    expect(gaps[0]).toBe(100)
    const retries = gaps.slice(1)
    expect(retries[0]).toBe(200)
    for (let i = 1; i < retries.length; i++) {
      // Each wait doubles the previous one, but never past half a minute.
      expect(retries[i]).toBe(Math.min(retries[i - 1]! * 2, 30_000))
    }
    // It reaches the cap rather than stopping short of it.
    expect(Math.max(...retries)).toBe(30_000)
  } finally {
    run.schedule.stop()
  }
})

test('a successful read after failures returns the sidebar to the poll interval', async () => {
  // 0 succeeds, 100 fails, and from the retry at 300 on every read succeeds.
  const run = await start([true, false, true])
  try {
    await run.timers.advance(300)
    // The failure at 100 doubled the wait to 200 ms, so its retry is at 300.
    expect(run.reads).toEqual([0, 100, 300])
    // The success at 300 resets the wait: the next reads are one poll apart.
    await run.timers.advance(300)
    expect(run.reads).toEqual([0, 100, 300, 400, 500, 600])
  } finally {
    run.schedule.stop()
  }
})

test('stopping the sidebar clears its pending retry and reads no more', async () => {
  const run = await start([true, false])
  try {
    // The read at 100 fails, and its retry is due at 300.
    await run.timers.advance(100)
    expect(run.reads).toEqual([0, 100])
    expect(run.timers.pending()).toBe(1)
    run.schedule.stop()
    expect(run.timers.pending()).toBe(0)
    await run.timers.advance(60_000)
    expect(run.reads).toEqual([0, 100])
  } finally {
    run.schedule.stop()
  }
})

test('a read still in flight when the sidebar stops starts no new timer', async () => {
  // The first read is held open, so the sidebar is stopped mid-read.
  const run = await start([true], { holdReads: true })
  expect(run.reads).toEqual([0])
  run.schedule.stop()
  // The answer comes back after the sidebar is gone; it must not queue work.
  run.release()
  await run.timers.settle()
  expect(run.timers.pending()).toBe(0)
  await run.timers.advance(60_000)
  expect(run.reads).toEqual([0])
})
