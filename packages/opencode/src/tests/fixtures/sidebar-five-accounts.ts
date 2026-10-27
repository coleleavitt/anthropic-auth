import { expect } from 'bun:test'

// A sidebar state shaped like a real five-account setup: each account has a
// 5h, a 7d and a Fable-only window, several windows are off pace (reserve and
// deficit sublines), `team` carries a 30-hour-old reading, and `main` has a
// credit budget. Every reset is in the future relative to `now`.
export function fiveAccountSidebarState(now = Date.now()) {
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const window = (used: number, resetIn: number, checkedAt = now) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
    resetsAt: new Date(now + resetIn).toISOString(),
  })
  const fable = (used: number, resetIn: number, checkedAt = now) => ({
    id: 'fable',
    title: 'Fable only',
    modelName: 'Fable',
    ...window(used, resetIn, checkedAt),
  })
  const account = (id: string, quota: unknown) => ({
    id,
    label: id,
    enabled: true,
    needsReauth: false,
    quota,
  })
  const week = 6 * day + 23 * hour + 30 * minute
  return {
    main: {
      quota: {
        five_hour: window(3, 4 * hour + 39 * minute),
        // Two of seven days gone with 40% used: a deficit that runs out early.
        seven_day: window(40, 5 * day),
        scoped: [fable(0, week)],
        extraUsage: {
          used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
        bindingWindow: 'seven_day',
      },
    },
    fallbacks: [
      account('work', {
        five_hour: window(0, 4 * hour + 39 * minute),
        seven_day: window(25, 5 * day),
        scoped: [fable(0, week)],
        bindingWindow: 'five_hour',
      }),
      account('personal', {
        five_hour: window(52, 3 * hour),
        seven_day: window(40, 5 * day - 23 * hour),
        scoped: [fable(10, week)],
      }),
      account('team', {
        five_hour: window(8, 2 * hour, now - 30 * hour),
        seven_day: window(93, 3 * day, now - 30 * hour),
        scoped: [fable(50, 3 * day, now - 30 * hour)],
      }),
      account('backup', {
        five_hour: window(0, 4 * hour + 39 * minute),
        seven_day: window(1, week),
        scoped: [fable(0, week)],
      }),
    ],
    activeId: 'main',
    route: 'main',
    lastUpdated: now,
  }
}

const BAR = '[█░▒▓]'
// A whole quota row: label, bar, figure, optional binding dot, then either
// nothing or at least one space and a reset such as `6d23h`, `6d` or `37m`.
const QUOTA_ROW = new RegExp(
  `^(\\S+) +(${BAR}+ )?\\d+% left( •)?( +\\d+[a-z]+(\\d+[a-z]+)?)?$`,
)
// A whole pacing subline, or one cut to fit that ends in `…`. A wrapped
// subline leaves a piece without either ending. An exhausted window names
// itself used up until its reset instead of reporting a deficit runout, and
// a runout under a minute away reads `<1m`, never `now` or `0m`.
const PACE_LINE =
  /^ +((reserve|deficit) \d+%( · (lasts to reset|out in (<1m|\d+[a-z]+(\d+[a-z]+)?))| ·[^…]*…)?|used up( · resets in \S+| ·[^…]*…)?)$/

/**
 * Checks every line of the expanded sidebar's Quota section: each one is a
 * complete quota row, pacing subline, account header, credit line, reading
 * age or blank. A wrapped row leaves a fragment that matches none of them.
 * Returns the quota rows so callers can check labels and columns.
 */
export function expectOneLineQuotaRows(
  frame: string,
  accounts: readonly string[],
): string[] {
  const lines = frame.split('\n').map((line) => line.trimEnd())
  const start = lines.findIndex((line) => line.trim() === 'Quota')
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === 'Routing',
  )
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const rows: string[] = []
  const unexpected: string[] = []
  for (const line of lines.slice(start + 1, end)) {
    const text = line.trim()
    if (text === '') continue
    if (QUOTA_ROW.test(text)) rows.push(line)
    else if (PACE_LINE.test(line)) continue
    else if (
      accounts.some((name) =>
        new RegExp(`^${name} +(active|idle|dated)$`).test(text),
      )
    )
      continue
    else if (/^credits \d+% left( · \$[\d,.]+\/\$[\d,.]+)?$/.test(text))
      continue
    else if (/^checked \S+ ago$/.test(text)) continue
    else unexpected.push(line)
  }
  expect(unexpected).toEqual([])
  for (const row of rows) {
    // A figure never touches its reset.
    expect(row).not.toMatch(/left\d/)
    expect(row).not.toMatch(/•\d/)
  }
  return rows
}
