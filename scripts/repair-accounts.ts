/**
 * Diagnose and repair the shared account store.
 *
 * Three problems compound here, and each hides the next:
 *
 *  - A credential imported from the native Claude Code keychain carries no
 *    account uuid or email, so identity matching cannot recognise it. The same
 *    login added another way sits in the store twice, and the imported row keeps
 *    whatever name it was created with — so a row called `native-claude` can
 *    turn out to be a different account entirely.
 *  - A misattributed quota reading marks a healthy account exhausted. Because a
 *    marked account is then skipped, the next one inherits the same figures,
 *    cascading until routing reports no account available at all.
 *  - Rows whose refresh token Anthropic has revoked stay in the rotation.
 *
 *   bun run scripts/repair-accounts.ts          # report only
 *   bun run scripts/repair-accounts.ts --fix    # backfill identity, clear quota
 */
import {
  backfillSharedAccountIdentities,
  fetchOAuthAccountIdentity,
  loadSharedAccountStore,
  updateSharedAccountStore,
} from '../packages/core/src/index.ts'

const FIX = process.argv.includes('--fix')

async function report(label: string) {
  const loaded = await loadSharedAccountStore()
  console.log(`\n=== ${label} ===`)
  const identities = new Map<string, string[]>()
  for (const account of loaded.store.accounts) {
    const credential = account.credential
    const uuid =
      credential.type === 'oauth' ? credential.account?.uuid : undefined
    const org =
      credential.type === 'oauth' ? credential.organization?.uuid : undefined
    const email =
      account.email ??
      (credential.type === 'oauth'
        ? credential.account?.email_address
        : undefined)
    const quota = account.quota
    const dead = account.dead_refresh_fingerprint ? '  DEAD-TOKEN' : ''
    console.log(
      `  ${account.id.padEnd(38)} ${(email ?? '(no email)').padEnd(34)} ` +
        `uuid=${uuid ? uuid.slice(0, 8) : '--------'} ` +
        `quota=${quota ? `${quota.five_hour_percent ?? '?'}/${quota.seven_day_percent ?? '?'}` : '-'}${dead}`,
    )
    if (uuid) {
      const key = `${uuid}@${org ?? ''}`
      identities.set(key, [...(identities.get(key) ?? []), account.id])
    }
  }

  const dupes = [...identities.entries()].filter(([, ids]) => ids.length > 1)
  if (dupes.length) {
    console.log('\n  duplicate accounts (same account+org under two rows):')
    for (const [key, ids] of dupes) {
      console.log(`    ${key.slice(0, 8)}…  ${ids.join('  <->  ')}`)
    }
  }

  const unidentified = loaded.store.accounts.filter(
    (a) => a.credential.type === 'oauth' && !a.credential.account?.uuid,
  )
  if (unidentified.length) {
    console.log(
      `\n  unidentified (invisible to dedupe): ${unidentified.map((a) => a.id).join(', ')}`,
    )
  }
  return { dupes, unidentified }
}

const before = await report('before')

if (!FIX) {
  console.log('\nrerun with --fix to backfill identity and clear stale quota')
  process.exit(before.dupes.length || before.unidentified.length ? 1 : 0)
}

console.log('\n=== backfilling identity from /api/oauth/profile ===')
for (const result of await backfillSharedAccountIdentities({
  fetchIdentity: fetchOAuthAccountIdentity,
})) {
  console.log(
    result.skipped
      ? `  ${result.id.padEnd(38)} skipped: ${result.skipped}`
      : `  ${result.id.padEnd(38)} -> ${result.email ?? '(no email)'}  uuid=${result.accountUuid?.slice(0, 8)}`,
  )
}

// Backfilled identity makes duplicates visible for the first time. Collapse
// them, keeping the row whose token still works and naming it after the account
// rather than whatever label the import happened to use.
console.log('\n=== merging duplicate accounts ===')
const merged = await updateSharedAccountStore((store) => {
  const byIdentity = new Map<string, typeof store.accounts>()
  for (const account of store.accounts) {
    if (account.credential.type !== 'oauth') continue
    const uuid = account.credential.account?.uuid
    if (!uuid) continue
    const key = `${uuid}@${account.credential.organization?.uuid ?? ''}`
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), account])
  }

  const removed: string[] = []
  for (const [, group] of byIdentity) {
    if (group.length < 2) continue
    // A row Anthropic has already rejected is never the one to keep.
    const live = group.filter((a) => !a.dead_refresh_fingerprint)
    const keep = live[0] ?? group[0]!
    const email =
      keep.email ??
      (keep.credential.type === 'oauth'
        ? keep.credential.account?.email_address
        : undefined)
    for (const account of group) {
      if (account === keep) continue
      removed.push(account.id)
      store.accounts = store.accounts.filter((a) => a !== account)
      if (store.current === account.id) store.current = keep.id
    }
    if (email && keep.id !== email) {
      removed.push(`${keep.id} -> ${email}`)
      if (store.current === keep.id) store.current = email
      keep.id = email
      keep.label = email
      keep.email = email
    }
  }
  return removed
})
console.log(
  merged.result.length
    ? merged.result.map((r) => `  ${r}`).join('\n')
    : '  no duplicates',
)

// A reading taken before attribution was fixed may sit on the wrong account;
// dropping it lets the next request re-read the truth.
console.log('\n=== clearing quota readings ===')
const cleared = await updateSharedAccountStore((store) => {
  let n = 0
  for (const account of store.accounts) {
    if (account.quota) {
      account.quota = undefined
      n += 1
    }
  }
  return n
})
console.log(`  cleared ${cleared.result} reading(s)`)

await report('after')
