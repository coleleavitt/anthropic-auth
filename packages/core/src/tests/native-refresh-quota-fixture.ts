import { expect, spyOn } from 'bun:test'
import type { NativeQuotaObservation } from '../native-quota-observations.ts'
import type { createTestLifetimeSuite } from './test-lifetime.ts'

export const quotaRefreshAccess = 'sk-ant-oat01-quota-refresh-successor'

interface QuotaRuntime {
  read(): Promise<{
    accounts: Array<{ id: string; quotaErrorClearedAt?: number }>
  }>
  fetchQuota(routeId: string, transport: typeof fetch): Promise<unknown>
  drainQuotaPublications(): Promise<void>
  quotaObservations: {
    publish(
      accountId: string,
      observation: NativeQuotaObservation,
      write: () => Promise<boolean>,
    ): Promise<void>
  }
}

/** Order a real pending quota write between refresh context capture and validation. */
export function holdQuotaPublicationForRefresh(
  lifetime: ReturnType<typeof createTestLifetimeSuite>,
) {
  const held = lifetime.gate()
  const arrived = lifetime.gate()
  let runtime: QuotaRuntime
  let previousMarker: number | undefined
  let exchanges = 0
  return {
    exchanges: () => exchanges,
    async poll(service: QuotaRuntime) {
      runtime = service
      previousMarker = (await runtime.read()).accounts.find(
        (row) => row.id === 'main',
      )?.quotaErrorClearedAt
      // The observation queue is shared by leased runtime facades as well as
      // direct runtimes. Wrap its existing writer, not a facade's forwarding method.
      const observations = runtime.quotaObservations
      const publish = observations.publish.bind(observations)
      const delayed = spyOn(observations, 'publish').mockImplementation(
        (accountId, observation, write) =>
          publish(accountId, observation, async () => {
            arrived.open()
            await held.wait
            return write()
          }),
      )
      lifetime.deferCleanup(async () => {
        held.open()
        await runtime.drainQuotaPublications()
        delayed.mockRestore()
      })
      await runtime.fetchQuota(
        'main',
        Object.assign(async () => Response.json({}), {
          preconnect: fetch.preconnect,
        }),
      )
      await arrived.wait
    },
    refreshToken: async () => {
      exchanges++
      held.open()
      await runtime.drainQuotaPublications()
      const account = (await runtime.read()).accounts.find(
        (row) => row.id === 'main',
      )
      expect(account?.quotaErrorClearedAt).toBeGreaterThan(previousMarker ?? -1)
      return {
        access: quotaRefreshAccess,
        refresh: 'synthetic-quota-refresh-successor',
        expires: Date.now() + 3600_000,
        expiresIn: 3600,
      }
    },
  }
}
