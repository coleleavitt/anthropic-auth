/**
 * Report on the shared account store (read-only).
 *
 *   bun run scripts/repair-accounts.ts
 *
 * The store is owned by the Rust binding now; this script only lists what it
 * reports per row (never a token). The old `--fix` mode rewrote
 * accounts.json from TypeScript (identity backfill, quota reset) and was
 * removed with the TypeScript store writer: a second writer of the same file
 * is how the stale `invalid_grant` flags and lost updates happened. Use the
 * Rust tooling (`ckl auth doctor`) for repairs.
 */
import {
  getSharedAccountStorePath,
  listSharedAccounts,
} from '../packages/core/src/index.ts'

function when(ms: number | undefined) {
  return typeof ms === 'number' ? new Date(ms).toISOString() : '-'
}

if (process.argv.includes('--fix')) {
  console.error(
    '--fix is no longer supported: the account store is written only by the Rust binding.',
  )
  process.exit(2)
}

const accounts = await listSharedAccounts()
console.log(`store: ${getSharedAccountStorePath()} (${accounts.length} rows)`)
for (const account of accounts) {
  const flags = [
    account.current ? 'current' : '',
    account.enabled ? '' : 'disabled',
    account.available ? '' : 'unavailable',
    account.accessLive ? 'access-live' : 'access-expired',
    account.refreshDead ? 'REFRESH-DEAD (re-login)' : '',
  ].filter(Boolean)
  console.log(
    `- ${account.id}${account.label ? ` "${account.label}"` : ''}${account.email ? ` <${account.email}>` : ''}: ${flags.join(', ')}`,
  )
  console.log(
    `    access expires ${when(account.expiresAt)}, refresh expires ${when(account.refreshExpiresAt)}, last refreshed ${when(account.lastRefreshedAt)}`,
  )
  if (account.lastError) console.log(`    last error: ${account.lastError}`)
  if (account.quota) {
    console.log(
      `    quota: 5h ${account.quota.fiveHourPercent ?? '-'}%, 7d ${account.quota.sevenDayPercent ?? '-'}% at ${when(account.quota.checkedAt)}`,
    )
  }
}
