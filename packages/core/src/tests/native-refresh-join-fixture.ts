import type { createTestLifetimeSuite } from './test-lifetime.ts'

export const refreshedJoinAccess = 'sk-ant-oat01-refresh-join-successor'
export const refreshJoinMessage =
  'Anthropic account update in progress; retry the request'

/** Hold the real coordinator inside its provider callback, with its leases intact. */
export function holdRefreshJoin(
  lifetime: ReturnType<typeof createTestLifetimeSuite>,
) {
  const entered = lifetime.gate()
  const release = lifetime.gate()
  let completed = false
  return {
    entered: entered.wait,
    release: release.open,
    completed: () => completed,
    refreshToken: async () => {
      entered.open()
      await release.wait
      completed = true
      return {
        access: refreshedJoinAccess,
        refresh: 'synthetic-refresh-join-successor',
        expires: Date.now() + 3600_000,
        expiresIn: 3600,
      }
    },
  }
}

/** A watchdog only: it never releases the provider or advances a mocked clock. */
export async function observeRefreshJoin<T>(
  work: Promise<T>,
  budgetMs = 1_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'pending' }), budgetMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
