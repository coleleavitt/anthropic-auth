import { fileURLToPath } from 'node:url'
import {
  acquireRefreshFileLock,
  type RefreshFileLock,
} from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'
import type { NativePoolStorePaths } from '../pool-store.ts'

/** Keep real store leases renewed independently of a test's codec-heavy work. */
export function holdPoolStoreLocks(
  paths: NativePoolStorePaths,
  owner: { deferCleanup(cleanup: () => void | Promise<void>): void },
) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(import.meta.url),
      paths.config,
      paths.state,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  const errors = new Response(child.stderr).text()
  owner.deferCleanup(async () => {
    if (child.exitCode === null) child.kill()
    await child.exited
  })
  const ready = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done)
          throw new Error(
            `Pool lock holder stopped before acquiring locks: ${await errors}`,
          )
        output += decoder.decode(next.value, { stream: true })
        if (output.includes('pool-locks-held\n')) return
      }
    } finally {
      reader.releaseLock()
    }
  })()
  let closing: Promise<void> | undefined
  return {
    ready,
    release() {
      closing ??= (async () => {
        if (child.exitCode === null) child.stdin.end()
        const code = await child.exited
        if (code !== 0)
          throw new Error(`Pool lock holder exited ${code}: ${await errors}`)
      })()
      return closing
    },
  }
}

if (import.meta.main) {
  const { nativePoolStoreLocks } = await import('../pool-store.ts')
  const [config, state] = process.argv.slice(2)
  if (!config || !state) throw new Error('Expected pool config and state paths')
  const leases: RefreshFileLock[] = []
  try {
    for (const lock of nativePoolStoreLocks({ config, state })) {
      const lease = await acquireRefreshFileLock({
        path: lock.path,
        name: lock.name,
        ttlMs: POOL_LOCK_DEFAULTS.ttlMs,
        renew: true,
      })
      if (!lease) throw new Error(`Could not acquire ${lock.name}`)
      leases.push(lease)
    }
    console.log('pool-locks-held')
    await Bun.stdin.text()
    for (const lease of leases) await lease.assertOwned()
  } finally {
    await Promise.allSettled(leases.reverse().map((lease) => lease.release()))
  }
}
