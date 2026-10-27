// Every settings write must be visible to the next settings read, in the
// writing process and in any other process. common-auth 0.27.1 caches
// readSettings() per process, keyed on the settings file's identity (device,
// inode, size, mtime, ctime). These tests write through the real native pool
// store and read back through it. Each write keeps the file the same size, so
// a hit can only be told apart by inode and timestamps, which is the case a
// cache keyed on identity is most likely to miss. They pass on 0.25.0 too,
// which reads the file every time.

import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'

const roots: string[] = []
const quota = {
  validate: (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value),
  merge: (_stored: unknown, observation: unknown) => observation,
}

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

type StorePaths = { config: string; state: string }

async function storePaths(kind: 'local' | 'vault'): Promise<StorePaths> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-settings-cache-')),
  )
  roots.push(root)
  const local = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  return kind === 'local' ? local : nativeVaultPaths(local)
}

async function mainAccountId(
  store: ReturnType<typeof createNativePoolStore>,
): Promise<unknown> {
  const read = await store.readSettings()
  if (read.status !== 'ready') throw new Error(`settings ${read.status}`)
  return read.settings.mainAccountId
}

const storeModule = new URL('../pool-store.ts', import.meta.url).href

/** Run one store operation in a separate Bun process and return its stdout. */
async function inChild(paths: StorePaths, body: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { createNativePoolStore } from ${JSON.stringify(storeModule)};
    const quota = { validate: () => true, merge: (_stored, next) => next };
    const store = createNativePoolStore({ paths: ${JSON.stringify(paths)}, quota });
    ${body}
  `,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const [exit, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`child exited ${exit}: ${error}`)
  return out.trim()
}

const childRead = `
    const read = await store.readSettings();
    console.log(JSON.stringify(read.status === 'ready' ? read.settings.mainAccountId : read.status));
`
const childWrite = (value: string) => `
    await store.updateSettings((settings) => { settings.mainAccountId = ${JSON.stringify(value)} });
    console.log('written');
`

for (const kind of ['local', 'vault'] as const) {
  test(`${kind} settings: every same-size write is seen by the next read in this process and in another`, async () => {
    const paths = await storePaths(kind)
    const writer = createNativePoolStore({ paths, quota })
    // A second handle on the same files, as the runtime keeps several (the
    // refresh coordinator, vault settings writers, migration).
    const reader = createNativePoolStore({ paths, quota })
    await writer.initialize()
    // Warm both handles' view of the file before the first write.
    expect(await mainAccountId(writer)).toBeUndefined()
    expect(await mainAccountId(reader)).toBeUndefined()

    for (let index = 0; index < 40; index++) {
      const value = index % 2 ? 'account-a' : 'account-b'
      await writer.updateSettings((settings) => {
        settings.mainAccountId = value
      })
      expect(await mainAccountId(writer)).toBe(value)
      expect(await mainAccountId(reader)).toBe(value)
    }
    // Last write was index 39: 'account-a'.
    expect(JSON.parse(await inChild(paths, childRead))).toBe('account-a')

    // Another process writes while this one holds a warm entry.
    for (const value of ['account-c', 'account-d', 'account-c']) {
      expect(await inChild(paths, childWrite(value))).toBe('written')
      expect(await mainAccountId(writer)).toBe(value)
      expect(await mainAccountId(reader)).toBe(value)
    }
  }, 60_000)
}

test('settings that become unreadable and then valid again are re-read, not served from an earlier read', async () => {
  const paths = await storePaths('local')
  const store = createNativePoolStore({ paths, quota })
  await store.initialize()
  await store.updateSettings((settings) => {
    settings.mainAccountId = 'account-a'
  })
  expect(await mainAccountId(store)).toBe('account-a')
  const original = await Bun.file(paths.config).text()
  // An in-place overwrite (same inode) with malformed bytes.
  await Bun.write(paths.config, '{')
  expect((await store.readSettings()).status).toBe('error')
  // And back to the same valid bytes, again in place.
  await Bun.write(paths.config, original)
  expect(await mainAccountId(store)).toBe('account-a')
})
