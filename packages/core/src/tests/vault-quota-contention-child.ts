// One host runtime publishing vault quota readings in its own process, for the
// roster contention test. Arguments: roster path, runtime index, a directory
// to mark readiness in, and the number of readings to publish. Prints one JSON
// report line on stdout.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as claustrum from '@cortexkit/common-auth/claustrum'
import { createCaptureSink, initLogger } from '@cortexkit/common-auth/logger'

const [path, indexText, readyDir, countText] = process.argv.slice(2)
if (!path || !indexText || !readyDir || !countText)
  throw new Error('usage: roster index ready-dir count')
const index = Number(indexText)
const count = Number(countText)
const capture = createCaptureSink()
initLogger({ captureSink: capture.sink, level: 'warn' })

const routeId = `route-${index}`
const receipt = {
  credentialId: `oauth:anthropic:${index}`,
  accountIdentity: `account-${index}`,
  accountIdentitySource: 'asserted' as const,
  expectedAccountIdentity: `account-${index}`,
}

// Mark readiness immediately before the writes start, so the parent holds the
// roster write lock for longer than a writer's whole lock wait from here on.
await writeFile(join(readyDir, `ready-${index}`), '')
const outcomes = await Promise.allSettled(
  Array.from({ length: count }, (_, reading) =>
    claustrum.recordVaultQuota(path, {
      routeId,
      ...receipt,
      observation: {
        checkedAt: Date.now(),
        readings: [
          { label: `window-${reading}`, usedPercent: 10 * index + reading },
        ],
      },
    }),
  ),
)
const accepted = outcomes.filter(
  (outcome) => outcome.status === 'fulfilled' && outcome.value,
).length
const rejected = outcomes.flatMap((outcome) =>
  outcome.status === 'rejected'
    ? [
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
      ]
    : [],
)

// An accepted reading has only been queued in this process for writing to the
// roster. Stay alive until every accepted reading is in the roster file, as a
// host would until exit.
const landed = async () => {
  const row = (await claustrum.readVaultRoster(path))?.rows.find(
    (entry) => entry.routeId === routeId,
  )
  return (
    row?.quota?.limits.filter(
      (entry) => entry.kind === 'reading' && entry.label.startsWith('window-'),
    ).length ?? 0
  )
}
const deadline = Date.now() + 25_000
let written = await landed()
while (accepted && written < accepted && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  written = await landed()
}
// Flush and release this process's queued quota writes. If common-auth does
// not export `drainVaultQuota`, its quota writes are already finished or have
// failed by this point.
const drain = (claustrum as { drainVaultQuota?: (path: string) => unknown })
  .drainVaultQuota
await drain?.(path)
process.stdout.write(
  `${JSON.stringify({
    index,
    accepted,
    rejected,
    written,
    warnings: capture.records.map(
      (record) => `${record.message} ${JSON.stringify(record.data ?? null)}`,
    ),
  })}\n`,
)
