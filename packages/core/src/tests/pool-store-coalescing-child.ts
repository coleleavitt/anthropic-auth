// One process publishing quota readings for its own account through a
// coalescing native pool store, for the multi-process test in
// pool-store-quota-coalescing.test.ts. Arguments: codec lane name, config path,
// state path, process index, number of readings, and a directory to mark
// readiness in. Waits for a `go` file there, so all processes publish at once,
// and marks `done-<index>` there once every reading is recorded, before the
// shutdown drain. Prints one JSON report line on stdout.
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  closeStore,
  headerSnapshot,
  laneNamed,
  openNativeStore,
} from './pool-store-coalescing-fixture.ts'

const [laneName, config, state, indexText, countText, ready] =
  process.argv.slice(2)
if (!laneName || !config || !state || !indexText || !countText || !ready)
  throw new Error('usage: lane config state index count ready-dir')
const lane = laneNamed(laneName)
const index = Number(indexText)
const count = Number(countText)
const id = `r${index}`
const identity = `acct-${index}`
const warnings: string[] = []
let merges = 0

const store = openNativeStore(
  {
    paths: { config, state },
    // Count calls to this codec's merge, to show the store used the codec
    // passed in rather than common-auth's built-in `quotaCodec`.
    quota: {
      validate: (value) => lane.codec.validate(value),
      merge: (stored, observation) => {
        merges++
        return lane.codec.merge(stored, observation)
      },
    },
    logger: { warn: (message) => void warnings.push(message) },
  },
  { drainTimeoutMs: 10_000 },
)

await writeFile(join(ready, `ready-${index}`), '')
for (;;) {
  try {
    await access(join(ready, 'go'))
    break
  } catch {
    await sleep(10)
  }
}

let accepted = 0
const rejected: string[] = []
for (let reading = 0; reading < count; reading++) {
  try {
    await store.recordQuota(
      id,
      { credentialEpoch: 1, identity },
      lane.observe(
        headerSnapshot(identity, 1_000_000 + reading, {
          five_hour: index * 10 + (reading % 10),
          seven_day: reading,
        }),
      ),
    )
    accepted++
  } catch (error) {
    rejected.push(error instanceof Error ? error.message : String(error))
  }
  // Spread the readings over several flushes.
  await sleep(5)
}
await writeFile(join(ready, `done-${index}`), '')
const started = performance.now()
await closeStore(store)
console.log(
  JSON.stringify({
    index,
    accepted,
    rejected: [...new Set(rejected)],
    warnings,
    merges,
    usesNativeCodec: lane.codec === nativeQuotaCodec,
    closeMs: Math.round(performance.now() - started),
  }),
)
