import { expect } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  readVaultRoster,
  type VaultRosterFile,
} from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const lifetimes = createTestLifetimeSuite()

const RUNTIMES = 4
const READINGS = 3
// common-auth gives up one wait for the roster write lock after this long.
const WRITER_LOCK_WAIT_MS = 5_000
const TIMEOUT = 'Timed out acquiring claustrum-roster-write'
const child = new URL('./vault-quota-contention-child.ts', import.meta.url)
  .pathname

type Report = {
  index: number
  accepted: number
  rejected: string[]
  written: number
  warnings: string[]
}

function seed(): VaultRosterFile {
  return {
    version: 1,
    complete: true,
    declined: [],
    rows: Array.from({ length: RUNTIMES }, (_, index) => ({
      routeId: `route-${index}`,
      credentialId: `oauth:anthropic:${index}`,
      credentialType: 'oauth' as const,
      accountIdentity: `account-${index}`,
      state: 'active',
      label: `Account ${index}`,
      enabled: true,
      addedAt: 1,
    })),
  }
}

lifetimes.test(
  'quota readings from four runtimes all land after the roster lock is held past a writer wait',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vault-quota-contention-'))
    const roster = join(directory, 'roster.json')
    const ready = join(directory, 'ready')
    const runtimes: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = []
    let lock: Awaited<ReturnType<typeof acquireRefreshFileLock>>
    lifetimes.deferCleanup(async () => {
      for (const runtime of runtimes) runtime.kill()
      await Promise.all(runtimes.map((runtime) => runtime.exited))
      await lock?.release()
      await rm(directory, { recursive: true, force: true })
    })
    await mkdir(ready)
    await writeFile(roster, JSON.stringify(seed()), { mode: 0o600 })
    // Hold the same lock the roster writers take, as another host mid-write.
    lock = await acquireRefreshFileLock({
      path: roster,
      name: 'claustrum-roster-write',
      ttlMs: 60_000,
      renew: true,
    })
    if (!lock) throw new Error('Fixture roster lock not acquired')
    for (let index = 0; index < RUNTIMES; index++)
      runtimes.push(
        Bun.spawn(
          [
            process.execPath,
            child,
            roster,
            String(index),
            ready,
            String(READINGS),
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        ),
      )
    const reports = Promise.all(
      runtimes.map(async (runtime): Promise<Report> => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(runtime.stdout).text(),
          new Response(runtime.stderr).text(),
          runtime.exited,
        ])
        if (code !== 0)
          throw new Error(`runtime exited with ${code}: ${stderr.trim()}`)
        return JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
      }),
    )
    lifetimes.trackDetached(reports)

    // The readiness marks show that every runtime is about to start publishing.
    const readyBy = Date.now() + 20_000
    while ((await readdir(ready)).length < RUNTIMES) {
      if (Date.now() > readyBy || runtimes.some((r) => r.exitCode !== null))
        throw new Error('Quota runtimes did not start publishing')
      await sleep(25)
    }
    // Keep the lock past each writer's whole wait, then confirm that nothing
    // reached the file while it was held.
    await sleep(WRITER_LOCK_WAIT_MS + 1_500)
    await lock.assertOwned()
    expect(
      (await readVaultRoster(roster))?.rows.map((row) => row.quota),
    ).toEqual(Array(RUNTIMES).fill(undefined))
    await lock.release()
    lock = null

    const settled = await reports
    const timeouts = settled.map(
      (report) =>
        [...report.rejected, ...report.warnings].filter((text) =>
          text.includes(TIMEOUT),
        ).length,
    )
    expect({
      accepted: settled.reduce((sum, report) => sum + report.accepted, 0),
      rejected: settled.reduce(
        (sum, report) => sum + report.rejected.length,
        0,
      ),
      written: settled.reduce((sum, report) => sum + report.written, 0),
      // A runtime may warn once that its publication is delayed, never once
      // per reading it holds.
      timeoutRepeated: timeouts.some((count) => count > 1),
    }).toEqual({
      accepted: RUNTIMES * READINGS,
      rejected: 0,
      written: RUNTIMES * READINGS,
      timeoutRepeated: false,
    })
    const rows = (await readVaultRoster(roster))?.rows ?? []
    for (let index = 0; index < RUNTIMES; index++) {
      const limits = rows.find((row) => row.routeId === `route-${index}`)?.quota
        ?.limits
      expect(
        Array.from({ length: READINGS }, (_, reading) => {
          const entry = limits?.find(
            (limit) => limit.label === `window-${reading}`,
          )
          return entry?.kind === 'reading' ? entry.usedPercent : undefined
        }),
      ).toEqual(
        Array.from({ length: READINGS }, (_, reading) => 10 * index + reading),
      )
    }
  },
  45_000,
)
