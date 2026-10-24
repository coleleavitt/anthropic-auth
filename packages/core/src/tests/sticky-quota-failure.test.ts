import { describe, expect, test } from 'bun:test'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import {
  decideStickyQuotaFailure,
  stickyRetryAfterWithJitter,
} from '../sticky-routing.ts'

const NOW = Date.parse('2026-10-24T08:00:00Z')
const MODEL = 'claude-fable-5'
const kinds = ['five-hour', 'seven-day', 'model-scoped'] as const
type Kind = (typeof kinds)[number]

function exhausted(kind: Kind, reset: string | undefined): OAuthQuotaSnapshot {
  const window = {
    usedPercent: 100,
    remainingPercent: 0,
    resetsAt: reset,
    checkedAt: NOW,
  }
  if (kind === 'five-hour') return { five_hour: window }
  if (kind === 'seven-day') return { seven_day: window }
  return {
    scoped: [
      {
        ...window,
        id: 'fable-weekly',
        title: 'Fable only',
        modelName: 'Fable',
      },
    ],
  }
}

function decide(quota: OAuthQuotaSnapshot, modelId = MODEL) {
  return decideStickyQuotaFailure({ quota, modelId, now: NOW })
}

const resetIn = (ms: number) => new Date(NOW + ms).toISOString()

describe('sticky quota hold', () => {
  for (const kind of kinds) {
    test(`${kind} holds within fifteen minutes including the boundary`, () => {
      for (const ms of [1, 10 * 60_000, 15 * 60_000]) {
        expect(decide(exhausted(kind, resetIn(ms)))).toEqual({
          action: 'hold',
          reason: `${kind}-short-reset`,
          retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)),
        })
      }
    })

    test(`${kind} moves beyond fifteen minutes`, () => {
      expect(decide(exhausted(kind, resetIn(15 * 60_000 + 1)))).toEqual({
        action: 'migrate',
        reason: kind,
      })
    })

    test(`${kind} moves for unknown invalid or past resets even with another short reset`, () => {
      for (const reset of [undefined, '', 'invalid', resetIn(0), resetIn(-1)]) {
        const other = kind === 'five-hour' ? 'seven-day' : 'five-hour'
        expect(
          decide({
            ...exhausted(other, resetIn(60_000)),
            ...exhausted(kind, reset),
          }),
        ).toEqual({ action: 'migrate', reason: kind })
      }
    })
  }

  test('uses the latest blocking reset for both the hold and its duration', () => {
    for (const first of kinds) {
      for (const second of kinds.filter((kind) => kind !== first)) {
        const quota = {
          ...exhausted(first, resetIn(5 * 60_000)),
          ...exhausted(second, resetIn(12 * 60_000)),
        }
        expect(decide(quota)).toEqual({
          action: 'hold',
          reason: `${second}-short-reset`,
          retryAfterSeconds: 12 * 60,
        })
        expect(
          decide({ ...quota, ...exhausted(second, resetIn(16 * 60_000)) }),
        ).toEqual({ action: 'migrate', reason: second })
      }
    }
    expect(
      decide({
        ...exhausted('five-hour', resetIn(14 * 60_000)),
        ...exhausted('seven-day', resetIn(10 * 60_000)),
        ...exhausted('model-scoped', resetIn(2 * 60_000)),
      }),
    ).toEqual({
      action: 'hold',
      reason: 'five-hour-short-reset',
      retryAfterSeconds: 14 * 60,
    })
  })

  test('ignores an exhausted scope for a different model including an unknown reset', () => {
    for (const reset of [undefined, resetIn(60 * 60_000)]) {
      const scoped = exhausted('model-scoped', reset)
      expect(decide(scoped, 'claude-opus-5')).toEqual({
        action: 'retain',
        reason: 'not-exhausted',
      })
      expect(
        decide(
          { ...scoped, ...exhausted('five-hour', resetIn(10 * 60_000)) },
          'claude-opus-5',
        ),
      ).toEqual({
        action: 'hold',
        reason: 'five-hour-short-reset',
        retryAfterSeconds: 600,
      })
    }
  })

  test('retains unknown and non-exhausted quotas unchanged', () => {
    for (const quota of [undefined, { kind: 'unknown' as const }]) {
      expect(decideStickyQuotaFailure({ quota, now: NOW })).toEqual({
        action: 'retain',
        reason: 'unknown',
      })
    }
    expect(decide({})).toEqual({ action: 'retain', reason: 'not-exhausted' })
    expect(
      decide({
        five_hour: { usedPercent: 99, remainingPercent: 1, checkedAt: NOW },
      }),
    ).toEqual({ action: 'retain', reason: 'not-exhausted' })
  })

  test('keeps the existing deterministic SHA256 session jitter', () => {
    expect(stickyRetryAfterWithJitter('session-a', 840)).toBe(856)
    expect(stickyRetryAfterWithJitter('session-a', 0)).toBe(17)
    expect(stickyRetryAfterWithJitter('session-a', 1.1)).toBe(18)
  })
})
