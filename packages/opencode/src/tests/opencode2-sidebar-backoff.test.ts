import { expect, test } from 'bun:test'

// The OpenCode 2 sidebar's refresh schedule. These drive the same timer
// sequence the sidebar component runs, with the timers under the test's
// control, so a 30 s back-off is checked without waiting for it.

interface Timer {
  at: number
  callback: () => void
  id: number
}

const timers: Timer[] = []
let sequence = 0
let virtualClock = false
let clock = 0
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
// The virtual queue only applies while a test runs; the rest of the test
// process keeps its normal timers.
globalThis.setTimeout = ((callback: () => void, delay = 0) => {
  if (!virtualClock) return realSetTimeout(callback, delay)
  const id = ++sequence
  timers.push({ at: clock + delay, callback, id })
  return id
}) as unknown as typeof setTimeout
globalThis.clearTimeout = ((id: number) => {
  if (!virtualClock) return realClearTimeout(id)
  // The sidebar may clear a timer that has already fired; that is not ours.
  const index = timers.findIndex((timer) => timer.id === id)
  if (index >= 0) timers.splice(index, 1)
  else realClearTimeout(id)
}) as unknown as typeof clearTimeout

const { sidebarRetryDelay } = await import('../tui/claude-sidebar')

// The schedule chains promises; a microtask turn lets each step queue the
// next timer before the test advances the clock again.
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function nextTimer(): Timer | undefined {
  return [...timers].sort((a, b) => a.at - b.at)[0]
}

async function advance(ms: number): Promise<void> {
  const end = clock + ms
  for (;;) {
    const timer = nextTimer()
    if (!timer || timer.at > end) break
    timers.splice(timers.indexOf(timer), 1)
    clock = Math.max(timer.at, clock)
    timer.callback()
    await settle()
  }
  clock = end
  await settle()
}

// The schedule the sidebar component runs: read, then wait `retry` ms, where
// `retry` comes from the helper and counts failed reads in a row. `answers[i]`
// decides whether read `i` succeeds; the last entry repeats once the list runs
// out. Each read is recorded with the time it started.
// Each test gets a fresh clock and timer queue.
function useVirtualClock(): void {
  clock = 0
  timers.length = 0
  virtualClock = true
}

function schedule(
  answers: boolean[],
  pollMs = 100,
  retryMaxMs = 30_000,
): number[] {
  const reads: number[] = []
  let failures = 0
  const refresh = async () => {
    const index = reads.length
    reads.push(clock)
    const ok = answers[Math.min(index, answers.length - 1)] ?? true
    if (!ok) throw new Error('sidebar refused')
  }
  const scheduleNext = () => {
    setTimeout(
      async () => {
        if (
          await refresh().then(
            () => true,
            () => false,
          )
        )
          failures = 0
        else failures += 1
        scheduleNext()
      },
      sidebarRetryDelay(pollMs, failures, retryMaxMs),
    )
  }
  void refresh().then(
    () => {},
    () => {
      failures += 1
    },
  )
  scheduleNext()
  return reads
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
  useVirtualClock()
  const reads = schedule([true])
  await advance(500)
  // The first read is immediate; the timer then fires every 100 ms.
  expect(reads).toEqual([0, 100, 200, 300, 400, 500])
})

test('a failing sidebar poll backs off, doubling up to half a minute', async () => {
  useVirtualClock()
  const reads = schedule([true, false])
  await advance(120_000)
  // The good read at 0 is followed by failures that wait 200, 400, 800, 1600,
  // 3200, 6400 and 12800, then half a minute each instead of 25600.
  expect(reads.slice(0, 9)).toEqual([
    0, 100, 300, 700, 1_500, 3_100, 6_300, 12_700, 25_500,
  ])
  const gaps = reads.map((at, i) => at - (reads[i - 1] ?? 0))
  expect(gaps.slice(2, 9)).toEqual([200, 400, 800, 1600, 3200, 6400, 12800])
  expect(Math.max(...gaps)).toBe(30_000)
  // 25_500 then 51_100, not 25_600 and then 51_200: the wait is 25_600 capped
  // at half a minute.
  expect(reads.slice(8, 10)).toEqual([25_500, 51_100])
  expect(reads.slice(10, 11)).toEqual([81_100])
})

test('a successful read after failures returns the sidebar to the poll interval', async () => {
  useVirtualClock()
  // Failures at 100, 300 and 700, then a success at 1500.
  const reads = schedule([true, false, false, false, true])
  await advance(1_500)
  expect(reads).toEqual([0, 100, 300, 700, 1_500])
  await advance(100)
  expect(reads.at(-1)).toBe(1_600)
})
