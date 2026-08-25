/**
 * Reconstruct refresh-token lifetimes from the plugin log.
 *
 * A revoked token family means one refresh token reached the endpoint twice.
 * That is invisible at the moment it happens — the failure shows up later, on a
 * different request, as `invalid_grant`. This walks the `refresh.spend` records
 * and reports the two things that actually distinguish a double-spend from
 * ordinary churn: a fingerprint spent more than once, and spends of the same
 * fingerprint from more than one PID.
 *
 *   bun run scripts/analyze-refresh-spends.ts [logfile]
 */
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Record_ = {
  ts?: string
  level?: string
  channel?: string
  message?: string
  spendId?: string
  refreshFp?: string
  rotatedToFp?: string
  pid?: number
  selfPid?: number
  holderPid?: number
  accountId?: string
  status?: number
  callSite?: string
  body?: string
}

const path = process.argv[2] ?? join(tmpdir(), 'opencode-anthropic-auth.log')
const raw = await readFile(path, 'utf8').catch(() => '')
if (!raw.trim()) {
  console.log(`no log at ${path}`)
  process.exit(0)
}

// Text lines are `[ts] LEVEL [channel] message {json}`.
const records: Record_[] = []
for (const line of raw.split('\n')) {
  const at = line.indexOf('{')
  if (at < 0) continue
  const head = line.slice(0, at)
  if (!head.includes('refresh')) continue
  try {
    const payload = JSON.parse(line.slice(at)) as Record_
    const match = /^\[([^\]]+)\]\s+(\w+)\s+\[([\w.]+)\]\s+(.*?)\s*$/.exec(head)
    records.push({
      ...payload,
      ts: match?.[1],
      level: match?.[2],
      channel: match?.[3],
      message: match?.[4],
    })
  } catch {
    // A truncated final line during a live tail is expected; skip it.
  }
}

const spends = records.filter((r) => r.message === 'presenting a refresh token')
const revoked = records.filter((r) => r.message?.includes('family is revoked'))
const contended = records.filter(
  (r) => r.message === 'claim held by another process',
)
const unclaimed = records.filter((r) =>
  r.message?.includes('refreshing unclaimed'),
)

console.log(`log: ${path}`)
console.log(`refresh.spend records: ${records.length}`)
console.log(`  token presentations : ${spends.length}`)
console.log(`  revoked families    : ${revoked.length}`)
console.log(`  claim contentions   : ${contended.length}`)
console.log(
  `  UNCLAIMED refreshes : ${unclaimed.length}   <-- these can double-spend`,
)

const byFingerprint = new Map<string, Record_[]>()
for (const spend of spends) {
  if (!spend.refreshFp) continue
  const list = byFingerprint.get(spend.refreshFp) ?? []
  list.push(spend)
  byFingerprint.set(spend.refreshFp, list)
}

const doubleSpent = [...byFingerprint.entries()].filter(([, v]) => v.length > 1)
console.log(`\ndouble-spent fingerprints: ${doubleSpent.length}`)
for (const [fp, list] of doubleSpent) {
  const pids = new Set(list.map((s) => s.pid))
  console.log(
    `\n  ${fp}  spent ${list.length}x by pid(s) ${[...pids].join(', ')}`,
  )
  for (const spend of list) {
    console.log(
      `    ${spend.ts ?? '?'}  pid=${spend.pid}  ${spend.callSite ?? '(no call site)'}`,
    )
  }
}

const pidCounts = new Map<number, number>()
for (const spend of spends) {
  if (spend.pid === undefined) continue
  pidCounts.set(spend.pid, (pidCounts.get(spend.pid) ?? 0) + 1)
}
console.log('\nspends per pid:')
for (const [pid, count] of [...pidCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  pid ${pid}: ${count}`)
}

if (contended.length) {
  console.log('\ncontention (who waited on whom):')
  for (const c of contended.slice(-15)) {
    console.log(
      `  ${c.ts ?? '?'}  pid ${c.selfPid} waited on pid ${c.holderPid}  account=${c.accountId}`,
    )
  }
}

if (revoked.length) {
  console.log('\nrevocations:')
  for (const r of revoked) {
    console.log(
      `  ${r.ts ?? '?'}  pid=${r.pid}  fp=${r.refreshFp}  ${(r.body ?? '').slice(0, 120)}`,
    )
  }
}
