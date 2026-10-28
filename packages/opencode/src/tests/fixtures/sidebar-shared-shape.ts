import { expect } from 'bun:test'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { version } from '../../../package.json'

export interface SidebarFrameLine {
  text: string
  spans: { text: string; fg: string }[]
}

export function sharedShapeSidebarState(now = Date.now()) {
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
  })
  return {
    main: {
      quota: { five_hour: window(60), seven_day: window(20) },
      quotaBackedOff: true,
      quotaBackoffUntil: now + 10 * 60_000,
    },
    fallbacks: [
      {
        id: 'idle',
        label: 'very-long-idle-account-name',
        enabled: true,
        needsReauth: false,
        quota: { five_hour: window(10), seven_day: window(10) },
      },
      {
        id: 'locked',
        label: 'locked',
        enabled: true,
        needsReauth: true,
        stateLine: 'sign in again',
        quotaDated: true,
        quota: { five_hour: window(30) },
      },
    ],
    activeId: 'main',
    route: 'main-first',
    cacheKeep: { window: '1h', enabled: true, trackedSessions: 2 },
    prime: { enabled: true, accounts: [] },
    lastUpdated: now,
  }
}

export function expectSharedSidebarShape(
  frame: string,
  lines: SidebarFrameLine[],
  width: number,
  collapsed: boolean,
) {
  expect(frame).not.toMatch(/[\u2500-\u257f]/)
  expect(frame).not.toContain('LIMITED')
  const header = frame.split('\n')[0] ?? ''
  expect(header.trimStart()).toStartWith(`${collapsed ? '▶' : '▼'} CLAUDE `)
  expect(header).toEndWith(`v${version}`)
  expect(Bun.stringWidth(header)).toBe(width)
  if (collapsed) {
    const rows = frame.split('\n').filter((line) => line.includes(' left'))
    expect(rows).toHaveLength(3)
    expect(rows[0]?.trimEnd()).toMatch(/^main +5h 40% · 7d 80% left ●$/)
    expect(rows[1]?.trimEnd()).toMatch(
      /^very-long-.*… +5h 90% · 7d 90% left ●$/,
    )
    expect(rows[2]?.trimEnd()).toMatch(/^locked +5h 70% left ⊘$/)
    for (const row of rows) expect(Bun.stringWidth(row.trimEnd())).toBe(width)
    const glyphColors = lines
      .filter((line) => line.text.includes(' left'))
      .map((line) => line.spans.find((span) => /[●⊘]\s*$/.test(span.text))?.fg)
    expect(glyphColors).toEqual([
      'rgba(0.00, 1.00, 0.00, 1.00)',
      'rgba(0.53, 0.53, 0.53, 1.00)',
      'rgba(1.00, 1.00, 0.00, 1.00)',
    ])
  } else {
    for (const section of ['Quota', 'Routing', 'Cache', 'Health'])
      expect(frame).toContain(section)
    for (const detail of ['sign in again', 'Quota API', '1h cache', 'Prime'])
      expect(frame).toContain(detail)
  }
}

export function captureSharedSidebarFrame(
  host: string,
  width: number,
  collapsed: boolean,
  frame: string,
) {
  // An explicit output path lets the render tests produce reviewable text frames.
  const path = process.env.SIDEBAR_FRAME_CAPTURE
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  const text = frame
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd()
  appendFileSync(
    path,
    `=== ${host} | ${width} columns | ${collapsed ? 'collapsed' : 'expanded'} ===\n${text}\n\n`,
  )
}
