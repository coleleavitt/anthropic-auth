import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'
import {
  HOLDER_FILE_NAME,
  HOLDER_REGISTRATION_ERROR_MESSAGES,
  type HolderLiveness,
  HolderRegistrationError,
  type NativeHolderRegistration,
  resetNativeHolderRegistryForTests,
  stateRefusalPublicMessage,
} from '../holder-registry.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { resetStateHomeServingGuardForTests } from '../state-home-serving-guard.ts'
import {
  type DecideStateLayoutOptions,
  decideOpenCodeStateLayout,
  decidePiStateLayout,
} from '../state-layout-decision.ts'
import {
  StateLayoutRefusalError,
  stateLayoutRefusalPublicMessage,
} from '../state-layout-errors.ts'
import { relocationTombstone } from '../state-layout-move.ts'
import {
  LEGACY_STATE_LAYOUT,
  resetProcessStateLayoutsForTests,
} from '../state-layout-paths.ts'

const roots: string[] = []
const closers: NativeHolderRegistration[] = []

beforeEach(() => {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
})

afterEach(async () => {
  __setLogTestSink(null)
  for (const registration of closers.splice(0)) registration.close()
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

/** Every pid is alive unless listed as dead. */
function liveness(dead: number[] = []): HolderLiveness {
  return {
    pidAlive: (pid) => !dead.includes(pid),
    incarnation: async () => null,
  }
}

/**
 * A home folder with OpenCode's config folder and a state root beside it.
 * The config folder holds only a local runtime file, so an ordinary
 * registration there has a dataset file to register beside.
 */
async function machine() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'state-move-off-')))
  roots.push(root)
  const home = join(root, 'home')
  const configDir = join(home, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  const stateRoot = join(root, 'state')
  const legacy = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  await writeFile(legacy.runtime, '{"version":1}\n', { mode: 0o600 })
  return {
    root,
    home,
    configDir,
    stateRoot,
    legacy,
    env: { XDG_STATE_HOME: stateRoot } as NodeJS.ProcessEnv,
  }
}

type Machine = Awaited<ReturnType<typeof machine>>

function decide(m: Machine, options: Partial<DecideStateLayoutOptions> = {}) {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  return decideOpenCodeStateLayout({
    role: 'opencode2',
    env: m.env,
    home: m.home,
    artifacts: {
      rpcRoots: [join(m.root, 'rpc')],
      rpcDirs: [],
      cacheKeepDirs: [join(m.root, 'cachekeep')],
    },
    liveness: liveness([process.pid]),
    timeouts: { layoutMs: 300, holderMs: 300, dataMs: 300 },
    ...options,
  })
}

type Kind = 'legacy' | 'explicit' | 'pi'
type Failure = 'malformed' | 'write' | 'lock'

/**
 * Start a process of `kind` whose registration fails by `failure`, and
 * return what the start resolved to (or the refusal it threw). Legacy with
 * moving on stays legacy through a routing override, the case where moving
 * on still keeps OpenCode's own dataset in its config folder.
 */
async function startWithFailedRegistration(
  kind: Kind,
  failure: Failure,
  moveEnabled: boolean,
) {
  const m = await machine()
  let dir = m.configDir
  let env = m.env
  let piPaths: Awaited<ReturnType<typeof resolveNativePoolPaths>> | undefined
  if (kind === 'legacy' && moveEnabled)
    env = {
      ...env,
      OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(m.root, 'routing.json'),
    }
  if (kind === 'explicit') {
    dir = join(m.root, 'custom')
    await mkdir(dir)
    env = {
      ...env,
      OPENCODE_ANTHROPIC_AUTH_FILE: join(dir, 'anthropic-auth.json'),
    }
    const paths = await resolveNativePoolPaths(
      join(dir, 'anthropic-auth.json'),
      join(dir, 'anthropic-auth-state.json'),
      LEGACY_STATE_LAYOUT,
    )
    await writeFile(paths.runtime, '{"version":1}\n', { mode: 0o600 })
  }
  if (kind === 'pi') {
    dir = join(m.root, 'agent')
    await mkdir(dir)
    piPaths = await resolveNativePoolPaths(
      join(dir, 'anthropic-auth.json'),
      undefined,
      LEGACY_STATE_LAYOUT,
    )
    await writeFile(piPaths.runtime, '{"version":1}\n', { mode: 0o600 })
  }
  const holderFile = join(dir, HOLDER_FILE_NAME)
  // A failed holder write: the folder turns read-only once the holder lock
  // is held, so the lock is taken but the holder file can't be written.
  const onLockEvent = (event: NativeLockEvent) => {
    if (
      failure === 'write' &&
      event.type === 'acquired' &&
      event.name === 'holders' &&
      event.path === holderFile
    )
      chmodSync(dir, 0o500)
  }
  if (failure === 'malformed') await writeFile(holderFile, '{not json')
  const start = async (): Promise<NativeHolderRegistration | undefined> => {
    if (kind === 'pi' && piPaths)
      return (
        await decidePiStateLayout({
          paths: piPaths,
          role: 'pi',
          onLockEvent,
          liveness: liveness([process.pid]),
          lockTimeoutMs: 300,
          moveEnabled,
        })
      ).registration
    const decision = await decide(m, { env, onLockEvent, moveEnabled })
    expect(decision.kind).toBe(kind as 'legacy' | 'explicit')
    if (decision.kind === 'state-home') throw new Error('not expected')
    return decision.registration
  }
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  const result =
    failure === 'lock'
      ? withLock(
          holderFile,
          { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000, renew: true },
          start,
        )
      : start()
  const outcome = await result.then(
    (registration) => ({ registration }),
    (error: unknown) => ({ error }),
  )
  await chmod(dir, 0o700)
  if ('registration' in outcome && outcome.registration)
    closers.push(outcome.registration)
  return {
    m,
    dir,
    outcome,
    warnings: logs.filter(
      (record) =>
        record.level === 'warn' &&
        record.message.includes('could not record that it is using'),
    ),
  }
}

for (const kind of ['legacy', 'explicit', 'pi'] as const)
  for (const failure of ['malformed', 'write', 'lock'] as const) {
    test(`moving off: a ${kind} start whose registration fails (${failure}) still serves, warns once and retries in the background`, async () => {
      const { outcome, warnings } = await startWithFailedRegistration(
        kind,
        failure,
        false,
      )
      if ('error' in outcome) throw outcome.error
      expect(outcome.registration?.status).toBe('pending')
      expect(warnings).toHaveLength(1)
    })

    test(`moving on: a ${kind} start whose registration fails (${failure}) refuses`, async () => {
      const { outcome, dir } = await startWithFailedRegistration(
        kind,
        failure,
        true,
      )
      if (!('error' in outcome)) throw new Error('the start was admitted')
      if (kind === 'legacy' && failure === 'lock') {
        // OpenCode's own dataset waits for the holder lock as part of the
        // layout decision, which reports a lock held too long as busy.
        expect(outcome.error).toBeInstanceOf(StateLayoutRefusalError)
        expect(outcome.error).toMatchObject({ code: 'busy' })
        return
      }
      expect(outcome.error).toBeInstanceOf(HolderRegistrationError)
      expect(outcome.error).toMatchObject({
        code:
          failure === 'malformed'
            ? 'malformed'
            : failure === 'lock'
              ? 'lock-timeout'
              : 'unavailable',
        directory: dir,
      })
    })
  }

/** The state-home folder of the machine's config folder. */
function stateSub(m: Machine) {
  return join(m.stateRoot, 'cortexkit', 'anthropic-auth', 'opencode')
}

/** A relocation tombstone over the legacy local runtime, as a move leaves it. */
async function tombstone(m: Machine) {
  await writeFile(
    m.legacy.runtime,
    relocationTombstone({
      sub: stateSub(m),
      stateRoot: join(m.stateRoot, 'cortexkit', 'anthropic-auth'),
      identity: m.configDir,
      attempt: '00000000-0000-4000-8000-000000000000',
      by: 'test',
    }),
  )
}

/** What a start shows a person for a refusal: the fixed text, naming no file. */
function expectFixedRefusal(error: unknown, m: Machine) {
  expect(error).toBeInstanceOf(StateLayoutRefusalError)
  expect(error).toMatchObject({ code: 'marker-unreadable' })
  const shown = stateRefusalPublicMessage(error)
  expect(shown).toBe(stateLayoutRefusalPublicMessage('marker-unreadable'))
  expect(shown).not.toContain(m.root)
}

test('moving off: a state root that is not a folder, or that the process may not read, does not stop a legacy start', async () => {
  for (const kind of ['not-a-folder', 'unreadable'] as const) {
    const m = await machine()
    if (kind === 'not-a-folder') {
      await writeFile(m.stateRoot, 'a file where the state root would be')
    } else {
      await mkdir(stateSub(m), { recursive: true })
      await chmod(m.stateRoot, 0o000)
    }
    try {
      const decision = await decide(m, { moveEnabled: false })
      expect(decision.kind).toBe('legacy')
      expect(decision.layout).toEqual(LEGACY_STATE_LAYOUT)
    } finally {
      if (kind === 'unreadable') await chmod(m.stateRoot, 0o700)
    }
  }
})

test('moving off: a corrupt layout.json in the state folder with no tombstone in the config folder does not stop a legacy start', async () => {
  const m = await machine()
  await mkdir(stateSub(m), { recursive: true })
  await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
  await writeFile(join(stateSub(m), 'config-dir.json'), '{ not json either')
  const decision = await decide(m, { moveEnabled: false })
  expect(decision.kind).toBe('legacy')
  // Nothing in the state folder was read or changed.
  expect(await readFile(join(stateSub(m), 'layout.json'), 'utf8')).toBe(
    '{ not json',
  )
})

test('a tombstone in the config folder keeps the strict checks: an unreadable state folder or record refuses with the fixed text', async () => {
  for (const moveEnabled of [false, true])
    for (const kind of [
      'state-root-not-a-folder',
      'config-dir-marker-unreadable',
      'layout-corrupt',
    ] as const) {
      const m = await machine()
      await tombstone(m)
      if (kind === 'state-root-not-a-folder')
        await writeFile(m.stateRoot, 'a file where the state root would be')
      else await mkdir(stateSub(m), { recursive: true })
      if (kind === 'config-dir-marker-unreadable')
        await mkdir(join(stateSub(m), 'config-dir.json'))
      if (kind === 'layout-corrupt')
        await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
      const error = await decide(m, { moveEnabled }).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expectFixedRefusal(error, m)
    }
})

test('moving off: a journal a move set aside keeps the strict checks', async () => {
  const m = await machine()
  await writeFile(
    `${m.legacy.journal}.moving-00000000-0000-4000-8000-000000000000`,
    '{}\n',
  )
  await mkdir(stateSub(m), { recursive: true })
  await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
  const error = await decide(m, { moveEnabled: false }).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expectFixedRefusal(error, m)
})

/** A host's view of a refusal: the fixed text, naming no file or folder. */
function expectFixedRegistrationRefusal(error: unknown, m: Machine) {
  expect(error).toBeInstanceOf(HolderRegistrationError)
  expect(error).toMatchObject({ code: 'unavailable' })
  const shown = stateRefusalPublicMessage(error)
  expect(shown).toBe((error as Error).message)
  expect(HOLDER_REGISTRATION_ERROR_MESSAGES).toContain(shown as string)
  expect(shown).not.toContain(m.root)
}

for (const branch of ['override', 'layout-lock', 'state-home'] as const)
  test(`a holder lock that fails with an I/O error, not contention, refuses with the fixed registration text once moving is on, and serves with moving off when no move is in sight (${branch})`, async () => {
    for (const moveEnabled of [false, true]) {
      const m = await machine()
      const env =
        branch === 'override'
          ? {
              ...m.env,
              OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(
                m.root,
                'routing.json',
              ),
            }
          : m.env
      if (branch === 'state-home') {
        // A moved dataset, admitted through the state folder's holder lock.
        expect((await decide(m, { moveEnabled: true })).kind).toBe('state-home')
      }
      // The folder whose holder lock is taken can't take new files, so the
      // lock file can't be created (EACCES).
      const locked = branch === 'state-home' ? stateSub(m) : m.configDir
      await chmod(locked, 0o500)
      const result = await decide(m, { env, moveEnabled }).then(
        (decision) => ({ decision }),
        (error: unknown) => ({ error }),
      )
      await chmod(locked, 0o700)
      if ('decision' in result && result.decision.kind !== 'state-home') {
        const registration = result.decision.registration
        if (registration) closers.push(registration)
      }
      if (branch === 'layout-lock' && !moveEnabled) {
        // Moving off with no move in sight never takes the state folder's
        // locks: a legacy start serves, its registration retried later.
        if ('error' in result) throw result.error
        expect(result.decision.kind).toBe('legacy')
        continue
      }
      if (branch === 'override' && !moveEnabled) {
        if ('error' in result) throw result.error
        expect(result.decision.kind).toBe('legacy')
        continue
      }
      if (!('error' in result)) throw new Error('the start was admitted')
      expectFixedRegistrationRefusal(result.error, m)
    }
  })
