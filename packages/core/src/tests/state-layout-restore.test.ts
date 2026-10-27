import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOLDER_FILE_NAME,
  type HolderLiveness,
  resetNativeHolderRegistryForTests,
} from '../holder-registry.ts'
import type { PreNArtifactLocations } from '../layout-fence.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import {
  beginNativeEmptyInit,
  readNativeMigrationJournal,
} from '../pool-authority.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { resetStateHomeServingGuardForTests } from '../state-home-serving-guard.ts'
import {
  type DecideStateLayoutOptions,
  decideOpenCodeStateLayout,
  RELOCATION_MOVE_DISABLED_REASON,
  type StateLayoutDecision,
} from '../state-layout-decision.ts'
import {
  defaultStateLayoutFs,
  type StateLayoutFs,
  syncFile,
} from '../state-layout-io.ts'
import {
  resolveRelocationDataset,
  StateLayoutCrash,
  type StateLayoutStep,
  stateLayoutDataLockOrder,
} from '../state-layout-move.ts'
import {
  LEGACY_STATE_LAYOUT,
  readRelocationPointer,
  resetProcessStateLayoutsForTests,
} from '../state-layout-paths.ts'
import { readStateLayoutRecord } from '../state-layout-record.ts'
import {
  type RestoreLegacyOptions,
  restoreLegacyLayout,
} from '../state-layout-restore.ts'

const roots: string[] = []

beforeEach(() => {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
})

afterEach(async () => {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

type Role =
  | 'localPoolState'
  | 'localRuntime'
  | 'journal'
  | 'localRoster'
  | 'vaultStoreState'
  | 'vaultRuntime'
  | 'vaultRoster'
  | 'vaultRouting'

/** The data files of the closed list, by role, in the legacy layout. */
function oldFiles(paths: NativePoolPaths): Record<Role, string> {
  const vault = nativeVaultPaths(paths, LEGACY_STATE_LAYOUT)
  return {
    localPoolState: paths.state,
    localRuntime: paths.runtime,
    journal: paths.journal,
    localRoster: paths.roster,
    vaultStoreState: vault.state,
    vaultRuntime: vault.runtime,
    vaultRoster: vault.roster,
    vaultRouting: vault.routing,
  }
}

interface Machine {
  root: string
  home: string
  configDir: string
  env: NodeJS.ProcessEnv
  sub: string
  oldPaths: NativePoolPaths
  newPaths: NativePoolPaths
  artifacts: PreNArtifactLocations
}

/**
 * A home folder whose default OpenCode config folder holds a migrated local
 * pool with one row, both runtimes, a custody roster and the vault files,
 * minus any role in `absent`. `fresh` leaves the folder empty.
 */
async function machine(
  options: { absent?: Role[]; fresh?: boolean } = {},
): Promise<Machine> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'state-restore-')))
  roots.push(root)
  const home = join(root, 'home')
  const configDir = join(home, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  const state = join(root, 'state')
  const env = { XDG_STATE_HOME: state }
  const oldPaths = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  if (!options.fresh) {
    const store = createNativePoolStore({
      paths: oldPaths,
      quota: nativeQuotaCodec,
    })
    await store.initialize()
    await store.add({
      id: 'a',
      credential: {
        type: 'oauth',
        access: 'access-a',
        refresh: 'refresh-a',
        expires: 4_000_000_000_000,
      },
    })
    await store.close()
    await beginNativeEmptyInit(oldPaths)
    const files = oldFiles(oldPaths)
    const contents: Partial<Record<Role, string>> = {
      localRuntime: '{"version":1,"note":"local runtime"}\n',
      localRoster: '{"roster":"local"}\n',
      vaultStoreState: '{"accounts":{},"version":1}\n',
      vaultRuntime: '{"version":1,"note":"vault runtime"}\n',
      vaultRoster: '{"roster":"vault"}\n',
      vaultRouting: '{"routing":"vault","seeded":true}\n',
    }
    for (const [role, text] of Object.entries(contents))
      await writeFile(files[role as Role], text, { mode: 0o600 })
    for (const role of options.absent ?? [])
      await rm(files[role], { force: true })
  }
  const sub = join(state, 'cortexkit', 'anthropic-auth', 'opencode')
  const newPaths = await resolveNativePoolPaths(
    oldPaths.legacyConfig,
    oldPaths.legacyState,
    { kind: 'state-home', dir: sub },
  )
  return {
    root,
    home,
    configDir,
    env,
    sub,
    oldPaths,
    newPaths,
    artifacts: {
      rpcRoots: [join(root, 'rpc')],
      rpcDirs: [],
      cacheKeepDirs: [join(root, 'cachekeep')],
    },
  }
}

/** Every pid is alive unless listed as dead. */
function liveness(dead: number[] = []): HolderLiveness {
  return {
    pidAlive: (pid) => !dead.includes(pid),
    incarnation: async () => null,
  }
}

/** A fresh process deciding the layout; this test's own pid counts as exited. */
async function decide(
  m: Machine,
  options: Partial<DecideStateLayoutOptions> = {},
): Promise<StateLayoutDecision> {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
  return decideOpenCodeStateLayout({
    role: 'opencode2',
    env: m.env,
    home: m.home,
    artifacts: m.artifacts,
    liveness: liveness([process.pid]),
    timeouts: { layoutMs: 3_000, holderMs: 3_000, dataMs: 3_000 },
    moveEnabled: true,
    ...options,
  })
}

/** The restore command, run as its own process would. */
function restore(m: Machine, options: Partial<RestoreLegacyOptions> = {}) {
  resetProcessStateLayoutsForTests()
  resetStateHomeServingGuardForTests()
  return restoreLegacyLayout({
    env: m.env,
    home: m.home,
    artifacts: m.artifacts,
    liveness: liveness([process.pid]),
    timeouts: { layoutMs: 3_000, holderMs: 3_000, dataMs: 3_000 },
    ...options,
  })
}

function crashAt(step: StateLayoutStep) {
  return async (current: StateLayoutStep) => {
    if (current === step) throw new StateLayoutCrash(step)
  }
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Every file of the config folder by name, with its bytes and mode, except
 * the holder file, which records who used the folder and is expected to
 * differ.
 */
async function configTree(m: Machine) {
  const tree: Record<string, string> = {}
  for (const name of (await readdir(m.configDir)).sort()) {
    if (name === HOLDER_FILE_NAME) continue
    const path = join(m.configDir, name)
    const info = await stat(path)
    tree[name] =
      `${(info.mode & 0o777).toString(8)} ${await readFile(path, 'utf8')}`
  }
  return tree
}

/**
 * Which copies a process could serve now: the legacy copy (no barrier is up
 * and the journal, or a vault runtime, authorizes it) and the state-home copy
 * (a committed record). At most one may ever be usable.
 */
async function usableCopies(m: Machine) {
  const files = oldFiles(m.oldPaths)
  const copies: string[] = []
  const tombstoned =
    (await readRelocationPointer(files.localRuntime)) !== undefined ||
    (await readRelocationPointer(files.vaultRuntime)) !== undefined
  const journal = await readNativeMigrationJournal(m.oldPaths).catch(
    () => undefined,
  )
  if (!tombstoned && journal !== undefined) copies.push('legacy')
  const record = await readStateLayoutRecord(m.sub).catch(() => undefined)
  if (record?.phase === 'committed') copies.push('state-home')
  return copies
}

/** Data files of the closed list, and restore staging files, in `<sub>` and the config folder. */
async function strayFiles(m: Machine) {
  const names = new Set(
    Object.values(oldFiles(m.oldPaths)).map((path) => path.split('/').pop()),
  )
  return {
    sub: (await readdir(m.sub).catch(() => [] as string[])).filter((name) =>
      names.has(name),
    ),
    staging: (await readdir(m.configDir)).filter((name) =>
      name.includes('.restoring-'),
    ),
  }
}

/** A machine whose dataset has been moved, with the config folder as it was before. */
async function moved(options: Parameters<typeof machine>[0] = {}) {
  const m = await machine(options)
  const before = await configTree(m)
  const decision = await decide(m)
  expect(decision.kind).toBe('state-home')
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
  return { m, before }
}

for (const variant of [
  { name: 'a full dataset', options: {} },
  { name: 'no local runtime', options: { absent: ['localRuntime'] as Role[] } },
  { name: 'no vault runtime', options: { absent: ['vaultRuntime'] as Role[] } },
  { name: 'a fresh install', options: { fresh: true } },
]) {
  test(`a move followed by a restore leaves the config folder byte for byte as before the move: ${variant.name}`, async () => {
    const { m, before } = await moved(variant.options)
    const outcome = await restore(m)
    expect(outcome).toMatchObject({
      status: 'restored',
      oldDir: m.configDir,
      sub: m.sub,
      kept: [],
    })
    expect(await configTree(m)).toEqual(before)
    expect(await strayFiles(m)).toEqual({ sub: [], staging: [] })
    expect(await readStateLayoutRecord(m.sub)).toMatchObject({
      phase: 'restored',
      restore: { cleanup: 'done' },
    })
    // With moving off, the next start serves the old folder again.
    const decision = await decide(m, { moveEnabled: false })
    expect(decision.kind).toBe('legacy')
    if (!variant.options.fresh)
      expect(await usableCopies(m)).toEqual(['legacy'])
    // Running the command again has nothing to do.
    expect((await restore(m)).status).toBe('not-moved')
  })
}

test('restore takes the layout and holder locks, then the move’s data locks without its row and provider locks, each once and in the move’s order', async () => {
  const { m } = await moved()
  const events: NativeLockEvent[] = []
  await restore(m, { onLockEvent: (event) => events.push(event) })
  const acquired = events
    .filter((event) => event.type === 'acquired')
    .map((event) => `${event.name}@${event.path}`)
  const dataset = await resolveRelocationDataset({
    configDir: m.configDir,
    identity: m.configDir,
    stateRoot: join(m.root, 'state', 'cortexkit', 'anthropic-auth'),
    sub: m.sub,
  })
  const data = stateLayoutDataLockOrder(dataset).map(
    (spec) => `${spec.name}@${spec.path}`,
  )
  expect(acquired).toEqual([
    `runtime-layout@${join(m.sub, 'layout.json')}`,
    ...[join(m.configDir, HOLDER_FILE_NAME), join(m.sub, HOLDER_FILE_NAME)]
      .sort()
      .map((path) => `holders@${path}`),
    ...data,
  ])
  expect(new Set(acquired).size).toBe(acquired.length)
  // No row or provider lock, on either side.
  expect(
    acquired.filter(
      (name) => name.startsWith('row-') || name.startsWith('provider-'),
    ),
  ).toEqual([])
  // The restore order is a subsequence of the move's.
  const forward = stateLayoutDataLockOrder(dataset, {
    refresh: {
      local: { rows: ['row-a'], providers: [], identities: [] },
      vault: { rows: [], providers: [], identities: [] },
    },
  }).map((spec) => `${spec.name}@${spec.path}`)
  let at = 0
  for (const lock of data) {
    at = forward.indexOf(lock, at)
    expect(at).toBeGreaterThanOrEqual(0)
  }
})

/** The steps a complete restore of `m`'s dataset passes, in order. */
async function restoreSteps() {
  const { m } = await moved()
  const steps: StateLayoutStep[] = []
  await restore(m, { onStep: (step) => void steps.push(step) })
  return steps.filter((step) => step.startsWith('restore:'))
}

test('a crash at every restore step recovers to exactly one usable copy', async () => {
  const steps = await restoreSteps()
  expect(steps[0]).toBe('restore:locks-held')
  expect(steps).toContain('restore:staged-written')
  expect(steps.at(-1)).toBe('restore:done')
  const boundary = steps.indexOf('restore:staged-written')
  for (const [index, step] of steps.entries()) {
    const { m, before } = await moved()
    await expect(restore(m, { onStep: crashAt(step) })).rejects.toBeInstanceOf(
      StateLayoutCrash,
    )
    // Never two usable copies, at any crash point.
    expect((await usableCopies(m)).length).toBeLessThanOrEqual(1)
    const phase = (await readStateLayoutRecord(m.sub))?.phase
    if (index < boundary) {
      // Before the boundary nothing at a legacy name changed: an ordinary
      // start discards the staging and keeps serving the state folder.
      expect(phase === 'committed' || phase === 'restoring').toBe(true)
      const decision = await decide(m)
      expect(decision.kind).toBe('state-home')
      expect(await usableCopies(m)).toEqual(['state-home'])
      expect((await strayFiles(m)).staging).toEqual([])
    } else if (phase === 'restore-staged') {
      // Past the boundary only the command may finish; a start refuses.
      await expect(decide(m)).rejects.toMatchObject({
        code: 'restore-unfinished',
      })
    } else {
      // `restored` with its copies still to remove: the old folder is
      // complete, and a start with moving off serves it without looking at
      // the state folder, so the removal waits for the command's rerun.
      expect(phase).toBe('restored')
      expect(await usableCopies(m)).toEqual(['legacy'])
      const record = await readStateLayoutRecord(m.sub)
      expect((await decide(m, { moveEnabled: false })).kind).toBe('legacy')
      expect(await readStateLayoutRecord(m.sub)).toEqual(record)
    }
    // A rerun of the command (needed only before `restored`) ends restored.
    expect((await restore(m)).status).toMatch(/^(restored|not-moved)$/)
    expect(await usableCopies(m)).toEqual(['legacy'])
    expect(await configTree(m)).toEqual(before)
    expect(await strayFiles(m)).toEqual({ sub: [], staging: [] })
  }
  // One full move and restore per step.
}, 30_000)

test('a rerun of the command discards an abandoned restore and starts again', async () => {
  const { m, before } = await moved()
  await expect(
    restore(m, { onStep: crashAt('restore:staging-flushed') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('restoring')
  const abandoned = (await readStateLayoutRecord(m.sub))?.restore?.attempt
  const steps: StateLayoutStep[] = []
  expect(
    (await restore(m, { onStep: (step) => void steps.push(step) })).status,
  ).toBe('restored')
  expect(steps).toContain('restore:discarded')
  expect((await readStateLayoutRecord(m.sub))?.restore?.attempt).not.toBe(
    abandoned,
  )
  expect(await configTree(m)).toEqual(before)
})

test('legacy writes after a barrier came down survive the recovery', async () => {
  for (const crash of [
    'restore:placed:localRuntime',
    'restore:barriers-flushed',
  ] as const) {
    const { m } = await moved()
    await expect(restore(m, { onStep: crashAt(crash) })).rejects.toBeInstanceOf(
      StateLayoutCrash,
    )
    // The journal and the local runtime are back: an older version serves
    // the old folder from here, refreshing its token and recording it.
    expect(await readRelocationPointer(m.oldPaths.runtime)).toBeUndefined()
    const refreshed = `${await readFile(m.oldPaths.state, 'utf8')} `
    const runtime = '{"version":1,"note":"written after the restore"}\n'
    await writeFile(m.oldPaths.state, refreshed)
    await writeFile(m.oldPaths.runtime, runtime)
    expect((await restore(m)).status).toBe('restored')
    expect(await readFile(m.oldPaths.state, 'utf8')).toBe(refreshed)
    expect(await readFile(m.oldPaths.runtime, 'utf8')).toBe(runtime)
  }
})

test('a vault file back in the config folder makes a new restore refuse before it writes anything', async () => {
  const { m } = await moved()
  const roster = oldFiles(m.oldPaths).vaultRoster
  await writeFile(roster, '{"roster":"written by an older version"}\n')
  const record = await readStateLayoutRecord(m.sub)
  await expect(restore(m)).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining(roster),
  })
  expect(await readStateLayoutRecord(m.sub)).toEqual(record)
  expect((await strayFiles(m)).staging).toEqual([])
})

test('a vault file back while a staged restore is stopped is replaced by the staged copy', async () => {
  const { m, before } = await moved()
  await expect(
    restore(m, { onStep: crashAt('restore:staged-written') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  const roster = oldFiles(m.oldPaths).vaultRoster
  await writeFile(roster, '{"roster":"written by an older version"}\n')
  expect((await restore(m)).status).toBe('restored')
  expect(await configTree(m)).toEqual(before)
})

test('a data file back after a barrier came down is never overwritten: the rerun refuses and names both copies', async () => {
  const { m } = await moved()
  // Stop once the journal and the local runtime are back, so an older
  // version may already serve the old folder.
  await expect(
    restore(m, { onStep: crashAt('restore:placed:localRuntime') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  // A staging file that survived (put back by hand here), and a legacy
  // write at its legacy name.
  const roster = oldFiles(m.oldPaths).vaultRoster
  const record = await readStateLayoutRecord(m.sub)
  const staging = record?.restore?.files?.find(
    (file) => file.role === 'vaultRoster',
  )?.staging as string
  // The state-folder copy is still there: R5 has not run.
  await writeFile(
    staging,
    await readFile(join(m.sub, 'anthropic-auth-vault-roster.json')),
    { mode: 0o600 },
  )
  const written = '{"roster":"served after the barrier came down"}\n'
  await writeFile(roster, written)
  await expect(restore(m)).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining(staging),
  })
  expect(await readFile(roster, 'utf8')).toBe(written)
  expect(await exists(staging)).toBe(true)
})

test('restore refuses while a live process is registered beside either copy, or when the state folder’s holder file is gone', async () => {
  const { m } = await moved()
  const record = await readStateLayoutRecord(m.sub)
  // The state-home process this test's decision registered, still running.
  await expect(restore(m, { liveness: liveness() })).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining(`pid ${process.pid}`),
  })
  // A live process registered in the config folder.
  const configHolders = join(m.configDir, HOLDER_FILE_NAME)
  await writeFile(
    configHolders,
    JSON.stringify({
      version: 1,
      entries: [
        {
          pid: 424_242,
          incarnation: null,
          instance: 'other',
          role: 'pi',
          release: '2.4.0',
          kind: 'pi',
          identity: null,
          files: [m.oldPaths.state],
          registeredAt: 1,
        },
      ],
    }),
  )
  await expect(restore(m)).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining('pid 424242'),
  })
  await rm(configHolders)
  // A live older version, which registers nothing.
  const cacheKeep = m.artifacts.cacheKeepDirs[0] as string
  await mkdir(cacheKeep, { recursive: true })
  await writeFile(
    join(cacheKeep, '424242-older.json'),
    JSON.stringify({ version: 1, updatedAt: 1, sessions: [] }),
  )
  await expect(restore(m)).rejects.toMatchObject({ code: 'restore-refused' })
  await rm(cacheKeep, { recursive: true })
  // The state folder's holder file, deleted by hand.
  await rm(join(m.sub, HOLDER_FILE_NAME))
  await expect(restore(m)).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining('is missing'),
  })
  expect(await readStateLayoutRecord(m.sub)).toEqual(record)
  expect((await strayFiles(m)).staging).toEqual([])
})

test('a staged restore is finished only when no process is registered in the state folder', async () => {
  const { m } = await moved()
  await expect(
    restore(m, { onStep: crashAt('restore:placed:journal') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  await expect(restore(m, { liveness: liveness() })).rejects.toMatchObject({
    code: 'restore-refused',
  })
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('restore-staged')
  expect((await restore(m)).status).toBe('restored')
})

test('a restore after a move whose cleanup is still pending waits for that cleanup', async () => {
  const m = await machine()
  const before = await configTree(m)
  await expect(
    decide(m, { onStep: crashAt('committed') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  expect(await readStateLayoutRecord(m.sub)).toMatchObject({
    phase: 'committed',
    cleanup: 'pending',
  })
  await expect(restore(m)).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining('has not finished removing'),
  })
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('committed')
  // A start finishes the cleanup; the restore then puts everything back.
  expect((await decide(m)).kind).toBe('state-home')
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
  expect((await restore(m)).status).toBe('restored')
  expect(await configTree(m)).toEqual(before)
})

test('a restore refuses with a path override, and has nothing to do before any move', async () => {
  const m = await machine()
  expect(await restore(m)).toMatchObject({ status: 'not-moved' })
  await expect(
    restore(m, {
      env: { ...m.env, OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: '/x' },
    }),
  ).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining(
      'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
    ),
  })
})

test('a start with a path override refuses to recover an abandoned restore; one without discards it', async () => {
  const { m } = await moved()
  await expect(
    restore(m, { onStep: crashAt('restore:restoring-written') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  await expect(
    decide(m, {
      env: { ...m.env, OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: '/x' },
    }),
  ).rejects.toMatchObject({ code: 'restore-unfinished' })
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('restoring')
  expect((await decide(m)).kind).toBe('state-home')
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('committed')
})

test('the move gate: off keeps a movable dataset in place with no state folder; on moves it', async () => {
  for (const enabled of [false, true]) {
    const m = await machine()
    const before = await configTree(m)
    const decision = await decide(m, { moveEnabled: enabled })
    if (!enabled) {
      expect(decision).toMatchObject({
        kind: 'legacy',
        reasons: [RELOCATION_MOVE_DISABLED_REASON],
      })
      expect(await configTree(m)).toEqual(before)
      // Nothing is created in the state folder, not even the subfolder.
      expect(await exists(m.sub)).toBe(false)
      expect(await usableCopies(m)).toEqual(['legacy'])
    } else {
      expect(decision.kind).toBe('state-home')
      expect(await usableCopies(m)).toEqual(['state-home'])
    }
  }
})

test('with the move gate off, a dataset already moved is still served from the state folder', async () => {
  const { m } = await moved()
  const decision = await decide(m, { moveEnabled: false })
  expect(decision.kind).toBe('state-home')
  expect(decision.layout).toEqual({ kind: 'state-home', dir: m.sub })
})

test('Windows: no directory flush, and a sharing violation on a restore rename is retried until it succeeds', async () => {
  const { m, before } = await moved()
  let clock = 0
  let flushes = 0
  let refusals = 0
  const base = defaultStateLayoutFs('win32')
  const fs: StateLayoutFs = {
    ...base,
    // Owner-only files are created the POSIX way on the test machine.
    createOwnerOnly: async (path, bytes) => {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    },
    syncDirectory: async (dir) => {
      flushes++
      await base.syncDirectory(dir)
    },
    rename: async (from, to) => {
      // The old local runtime is held open by another program twice.
      if (to === m.oldPaths.runtime && ++refusals <= 2)
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      await defaultStateLayoutFs().rename(from, to)
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  expect((await restore(m, { fs })).status).toBe('restored')
  expect(flushes).toBeGreaterThan(0)
  expect(refusals).toBe(3)
  expect(await configTree(m)).toEqual(before)
})

test('a staging file changed after it was staged is never put in place: the rerun refuses before writing anything', async () => {
  const { m } = await moved()
  await expect(
    restore(m, { onStep: crashAt('restore:staged-written') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  const record = await readStateLayoutRecord(m.sub)
  const staging = record?.restore?.files?.find(
    (file) => file.role === 'vaultRoster',
  )?.staging as string
  await writeFile(staging, 'changed by hand')
  const before = await configTree(m)
  await expect(restore(m)).rejects.toMatchObject({
    code: 'restore-refused',
    message: expect.stringContaining(staging),
  })
  expect(await configTree(m)).toEqual(before)
})

/**
 * A filesystem that runs every call for real and records, in order, each
 * rename and unlink by its target and each flush of a file or folder.
 */
function recordingFs(): { fs: StateLayoutFs; events: string[] } {
  const base = defaultStateLayoutFs()
  const events: string[] = []
  return {
    events,
    fs: {
      ...base,
      rename: async (from, to) => {
        await base.rename(from, to)
        events.push(`rename ${to}`)
      },
      unlink: async (path) => {
        await base.unlink(path)
        events.push(`unlink ${path}`)
      },
      syncDirectory: async (dir) => {
        await base.syncDirectory(dir)
        events.push(`sync-dir ${dir}`)
      },
      syncFile: async (path) => {
        await syncFile(path)
        events.push(`sync-file ${path}`)
      },
    },
  }
}

/**
 * A process that dies right after renaming a `phase` record into place,
 * before it flushes `<sub>`: the rename stands, its flush never runs, so
 * power loss could still take the record back to the phase before.
 */
function crashBeforeRecordFlush(
  m: Machine,
  phase: 'restore-staged' | 'restored',
): StateLayoutFs {
  const base = defaultStateLayoutFs()
  let published = false
  return {
    ...base,
    rename: async (from, to) => {
      await base.rename(from, to)
      if (
        to === join(m.sub, 'layout.json') &&
        (await readStateLayoutRecord(m.sub))?.phase === phase
      )
        published = true
    },
    syncDirectory: async (dir) => {
      if (published && dir === m.sub)
        throw new StateLayoutCrash(
          phase === 'restore-staged'
            ? 'restore:staged-written'
            : 'restore:restored-written',
        )
      await base.syncDirectory(dir)
    },
  }
}

for (const variant of [
  { phase: 'restore-staged', by: 'the command' },
  { phase: 'restored', by: 'the command' },
  { phase: 'restored', by: 'a start' },
] as const)
  test(`recovery by ${variant.by} flushes a ${variant.phase} record it found before it changes anything that record allows`, async () => {
    const { m, before } = await moved()
    await expect(
      restore(m, { fs: crashBeforeRecordFlush(m, variant.phase) }),
    ).rejects.toBeInstanceOf(StateLayoutCrash)
    expect((await readStateLayoutRecord(m.sub))?.phase).toBe(variant.phase)
    const { fs, events } = recordingFs()
    if (variant.by === 'the command')
      expect((await restore(m, { fs })).status).toBe('restored')
    else {
      // A live older version keeps the start from moving the dataset again
      // once the retirement is done.
      const cacheKeep = m.artifacts.cacheKeepDirs[0] as string
      await mkdir(cacheKeep, { recursive: true })
      await writeFile(
        join(cacheKeep, '424242-older.json'),
        JSON.stringify({ version: 1, updatedAt: 1, sessions: [] }),
      )
      expect((await decide(m, { fs })).kind).toBe('legacy')
    }
    // R3 renames into the config folder; R5 unlinks in the state folder.
    const changes =
      variant.phase === 'restore-staged'
        ? new RegExp(`^(rename|unlink) ${m.configDir}/`)
        : new RegExp(`^unlink ${m.sub}/`)
    const first = events.findIndex((event) => changes.test(event))
    expect(first).toBeGreaterThan(0)
    const flushed = events.slice(0, first)
    expect(flushed).toContain(`sync-file ${join(m.sub, 'layout.json')}`)
    expect(flushed).toContain(`sync-dir ${m.sub}`)
    // Nothing replaced the record between its flush and the first change.
    expect(flushed).not.toContain(`rename ${join(m.sub, 'layout.json')}`)
    expect(await configTree(m)).toEqual(before)
    expect((await readStateLayoutRecord(m.sub))?.restore?.cleanup).toBe('done')
  })
