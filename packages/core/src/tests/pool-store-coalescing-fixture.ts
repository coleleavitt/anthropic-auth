// Shared by the quota-coalescing store tests and their child processes.
// Coalesced stores use Core's production opt-in; the wrapper only supplies a
// drain bound or disables coalescing for independent on-disk control readers.
import { mock } from 'bun:test'
import {
  isQuotaMap,
  type QuotaCodec,
  quotaCodec,
} from '@cortexkit/common-auth/quota'
import * as storeModule from '@cortexkit/common-auth/store'

import type { OAuthQuotaSnapshot } from '../accounts.ts'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../native-quota-codec.ts'
import type { NativePoolStoreOptions } from '../pool-store.ts'

const real = { ...storeModule }
let injected: Record<string, unknown> | undefined
let wrappedOpens = 0

mock.module('@cortexkit/common-auth/store', () => ({
  ...real,
  openPoolStore: (options: storeModule.OpenPoolStoreOptions) => {
    const configured = { ...options, ...injected }
    if (configured.coalesceQuota) wrappedOpens++
    return real.openPoolStore(configured)
  },
}))

// Imported after the wrapper is installed so Core binds to it.
const { createNativePoolStore } = await import('../pool-store.ts')

export type NativeStore = ReturnType<typeof createNativePoolStore>

export type QuotaCommitTimer = NonNullable<
  storeModule.OpenPoolStoreOptions['quotaCommitTimer']
>

/** How many stores were opened with the coalescer switched on. */
export function coalescingOpens(): number {
  return wrappedOpens
}

/**
 * Opens a store through Core's `createNativePoolStore`. With `coalesce`, the
 * store is opened with `coalesceQuota: true` and the given drain bound.
 */
export function openNativeStore(
  options: NativePoolStoreOptions,
  coalesce?: {
    drainTimeoutMs?: number
    quotaCommitTimer?: QuotaCommitTimer
  },
): NativeStore {
  injected = coalesce
    ? {
        ...(coalesce.drainTimeoutMs !== undefined
          ? { quotaDrainTimeoutMs: coalesce.drainTimeoutMs }
          : {}),
        ...(coalesce.quotaCommitTimer !== undefined
          ? { quotaCommitTimer: coalesce.quotaCommitTimer }
          : {}),
      }
    : { coalesceQuota: false }
  try {
    return createNativePoolStore(options)
  } finally {
    injected = undefined
  }
}

/** Drain queued quota readings before removing a fixture's files. */
export function closeStore(store: NativeStore): Promise<void> {
  return store.close()
}

export const FABLE_ID = 'claude-weekly-scoped-fable'

export type Window = { usedPercent: number; checkedAt: number }
/** The quota windows and extra usage the merge assertions compare. */
export type Facts = {
  five_hour?: Window
  seven_day?: Window
  fable?: Window
  extraUsagePercent?: number
}

const EXTRA_USAGE_PERCENT = 19.225

function window(usedPercent: number, checkedAt: number) {
  return { usedPercent, remainingPercent: 100 - usedPercent, checkedAt }
}

/** A usage-endpoint poll: both windows, the Fable weekly window and extra usage. */
export function pollSnapshot(
  identity: string,
  checkedAt: number,
  used: { five_hour: number; seven_day: number; fable: number },
): OAuthQuotaSnapshot {
  return {
    accountIdentity: identity,
    source: 'poll',
    checkedAt,
    five_hour: window(used.five_hour, checkedAt),
    seven_day: window(used.seven_day, checkedAt),
    scoped: [
      {
        id: FABLE_ID,
        title: 'Fable only',
        modelId: 'claude-fable-5',
        modelName: 'Claude Fable 5',
        ...window(used.fable, checkedAt),
      },
    ],
    extraUsage: {
      used: { amountMinor: 192.25, currency: 'USD', exponent: 2 },
      limit: { amountMinor: 1000, currency: 'USD', exponent: 2 },
      utilizationPercent: EXTRA_USAGE_PERCENT,
      exhausted: false,
    },
  }
}

/** A response-header reading: only the five-hour and seven-day windows. */
export function headerSnapshot(
  identity: string,
  checkedAt: number,
  used: { five_hour: number; seven_day: number },
): OAuthQuotaSnapshot {
  return {
    accountIdentity: identity,
    source: 'headers',
    checkedAt,
    five_hour: window(used.five_hour, checkedAt),
    seven_day: window(used.seven_day, checkedAt),
  }
}

/**
 * The codec under test and how Core would hand it a reading. `native` is
 * production: `nativeQuotaCodec` with the `toNativeQuotaMap` observations
 * `publishLocal` records. `library` is a control that feeds the same readings
 * to common-auth's own `quotaCodec` as `QuotaObservation`s; it shows what the
 * coalescer itself does when the codec speaks its observation format.
 */
export interface Lane {
  name: 'native' | 'library'
  codec: QuotaCodec
  observe(snapshot: OAuthQuotaSnapshot): unknown
  facts(quota: unknown): Facts
}

function pick(value: { usedPercent: number; checkedAt: number } | undefined) {
  return value
    ? { usedPercent: value.usedPercent, checkedAt: value.checkedAt }
    : undefined
}

function defined(facts: Facts): Facts {
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== undefined),
  )
}

export const nativeLane: Lane = {
  name: 'native',
  codec: nativeQuotaCodec,
  observe: toNativeQuotaMap,
  facts(quota) {
    if (quota === undefined) return {}
    const snapshot = fromNativeQuotaMap(quota)
    return defined({
      five_hour: pick(snapshot.five_hour),
      seven_day: pick(snapshot.seven_day),
      fable: pick(snapshot.scoped?.find((entry) => entry.id === FABLE_ID)),
      extraUsagePercent: snapshot.extraUsage?.utilizationPercent,
    })
  },
}

export const libraryLane: Lane = {
  name: 'library',
  codec: quotaCodec,
  observe(snapshot) {
    const readings: Array<Record<string, unknown>> = []
    for (const label of ['five_hour', 'seven_day'] as const) {
      const entry = snapshot[label]
      if (entry) readings.push({ label, usedPercent: entry.usedPercent })
    }
    for (const entry of snapshot.scoped ?? [])
      readings.push({
        scope: 'fable',
        label: `seven_day:${entry.id}`,
        usedPercent: entry.usedPercent,
      })
    return {
      checkedAt: snapshot.checkedAt,
      readings,
      ...(snapshot.extraUsage
        ? {
            budget: {
              kind: 'reading',
              reached: snapshot.extraUsage.exhausted,
              usedPercent: snapshot.extraUsage.utilizationPercent,
            },
          }
        : {}),
    }
  },
  facts(quota) {
    if (quota === undefined) return {}
    if (!isQuotaMap(quota)) throw new Error('Stored quota is not a quota map')
    const find = (scope: string, label: string) => {
      const entry = quota.limits.find(
        (limit) => limit.scope === scope && limit.label === label,
      )
      return entry?.kind === 'reading' ? pick(entry) : undefined
    }
    return defined({
      five_hour: find('all', 'five_hour'),
      seven_day: find('all', 'seven_day'),
      fable: find('fable', `seven_day:${FABLE_ID}`),
      extraUsagePercent:
        quota.budget?.kind === 'reading' ? quota.budget.usedPercent : undefined,
    })
  },
}

export const lanes = [nativeLane, libraryLane] as const

export function laneNamed(name: string): Lane {
  const lane = lanes.find((candidate) => candidate.name === name)
  if (!lane) throw new Error(`Unknown codec lane ${name}`)
  return lane
}

export function credential(suffix: string) {
  return {
    type: 'oauth' as const,
    access: `access-${suffix}`,
    refresh: `refresh-${suffix}`,
    expires: 4_000_000_000_000,
  }
}
