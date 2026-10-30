import {
  type AccountStorage,
  logger,
  type OAuthQuotaSnapshot,
  type StickyRouteCandidate,
  stickyRouteFamilyForModel,
  stickyRouteKnownFableExhausted,
} from '@cortexkit/anthropic-auth-core'

export const ROUTING_HOLD_LIMIT_MS = 15 * 60_000 + 20_000
export type RoutingChoice = {
  account_id: string
  credential_id: string
  hold?: { retry_after_ms: number }
}
type RoutingSubject = { accountIdentity?: string; credentialId?: string }
type RoutingReport = {
  account_id: string
  credential_id?: string
} & (
  | { outcome: 'served'; headers: Record<string, string> }
  | { outcome: 'exhausted'; window: string; resets_at?: string }
)
type Handle = {
  accountFor(input: {
    provider: 'anthropic'
    modelId: string
  }): Promise<unknown>
  report(input: RoutingReport): unknown
}

// The runner's bridge loads after the auth plugin, so never cache the global.
function handleFor(sessionId: string): Handle | undefined {
  const routing = (globalThis as Record<symbol, unknown>)[
    Symbol.for('cortexkit.routing')
  ]
  if (typeof routing !== 'function') return undefined
  return routing(sessionId) ?? undefined
}

export function routingChoiceMatches(
  choice: RoutingChoice,
  account: RoutingSubject,
) {
  return (
    account.accountIdentity === choice.account_id &&
    (!account.credentialId || account.credentialId === choice.credential_id)
  )
}

/** Opus model requests spend accounts with exhausted Fable quota first, preserving the others for Fable requests. */
export function routingReserveAllows(
  accountId: string,
  candidates: readonly StickyRouteCandidate[],
  storage: AccountStorage | null,
  modelId: string,
) {
  if (stickyRouteFamilyForModel(modelId) !== 'opus') return true
  const depleted = candidates.filter((candidate) =>
    stickyRouteKnownFableExhausted(candidate, storage),
  )
  return !depleted.length || depleted.some((row) => row.accountId === accountId)
}

export function createRoutingRelay() {
  const overridden = new Set<string>()
  const override = (sessionId: string, reason: string) => {
    if (overridden.has(sessionId)) return
    if (overridden.size >= 512) {
      const first = overridden.values().next()
      if (!first.done) overridden.delete(first.value)
    }
    overridden.add(sessionId)
    logger.debug('routing-relay', 'Using local account choice', {
      sessionId,
      reason,
    })
  }
  return {
    override,
    async accountFor(
      sessionId: string,
      modelId: string,
    ): Promise<RoutingChoice | null> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const handle = handleFor(sessionId)
        if (!handle) return null
        const result = await Promise.race([
          Promise.resolve().then(() =>
            handle.accountFor({ provider: 'anthropic', modelId }),
          ),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 2000)
          }),
        ])
        if (
          !result ||
          typeof result !== 'object' ||
          !('account_id' in result) ||
          typeof result.account_id !== 'string' ||
          !('credential_id' in result) ||
          typeof result.credential_id !== 'string'
        ) {
          override(sessionId, 'no valid answer within routing deadline')
          return null
        }
        const hold = 'hold' in result ? result.hold : undefined
        return {
          account_id: result.account_id,
          credential_id: result.credential_id,
          ...(hold &&
          typeof hold === 'object' &&
          'retry_after_ms' in hold &&
          typeof hold.retry_after_ms === 'number' &&
          Number.isFinite(hold.retry_after_ms) &&
          hold.retry_after_ms > 0
            ? {
                hold: {
                  retry_after_ms: Math.min(
                    hold.retry_after_ms,
                    ROUTING_HOLD_LIMIT_MS,
                  ),
                },
              }
            : {}),
        }
      } catch {
        override(sessionId, 'routing unavailable')
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    report(
      sessionId: string,
      subject: RoutingSubject,
      headers: Headers,
      status: number,
      quota?: OAuthQuotaSnapshot,
      served = status < 400,
    ) {
      if (!subject.accountIdentity) return
      const identity = {
        account_id: subject.accountIdentity,
        ...(subject.credentialId
          ? { credential_id: subject.credentialId }
          : {}),
      }
      const reports: RoutingReport[] = []
      if (served) {
        const rateHeaders: Record<string, string> = {}
        headers.forEach((value, name) => {
          if (name.toLowerCase().startsWith('anthropic-ratelimit-'))
            rateHeaders[name.toLowerCase()] = value
        })
        reports.push({ ...identity, outcome: 'served', headers: rateHeaders })
      }
      for (const [window, reading] of [
        ['5h', quota?.five_hour],
        ['7d', quota?.seven_day],
        ...(quota?.scoped?.map((row) => [row.id.toLowerCase(), row] as const) ??
          []),
      ] as const) {
        if (
          reading &&
          (reading.remainingPercent <= 0 || reading.usedPercent >= 100)
        )
          reports.push({
            ...identity,
            outcome: 'exhausted',
            window,
            ...(reading.resetsAt ? { resets_at: reading.resetsAt } : {}),
          })
      }
      if (
        status === 429 &&
        !reports.some((row) => row.outcome === 'exhausted')
      ) {
        const binding = quota?.bindingWindow?.toLowerCase()
        reports.push({
          ...identity,
          outcome: 'exhausted',
          window:
            binding === 'five_hour'
              ? '5h'
              : binding === 'seven_day'
                ? '7d'
                : (binding ?? '7d'),
        })
      }
      // Neither synchronous bridge errors nor rejected report promises can fail a send.
      void Promise.resolve()
        .then(() => {
          const handle = handleFor(sessionId)
          for (const report of reports) {
            try {
              void Promise.resolve(handle?.report(report)).catch(() => {})
            } catch {}
          }
        })
        .catch(() => {})
    },
  }
}
