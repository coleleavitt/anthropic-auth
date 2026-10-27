import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from './logger.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import type { RelocationGuard } from './relocation-guard.ts'
import {
  StateLayoutRefusalError,
  stateLayoutConflict,
} from './state-layout-errors.ts'
import { fileSha256 } from './state-layout-io.ts'
import { STATE_HOME_FILE_NAMES } from './state-layout-paths.ts'
import {
  movingJournalPath,
  readStateLayoutRecord,
  type StateLayoutRecord,
} from './state-layout-record.ts'

/** The files a state-home process watches for a conflict with its own copies. */
export interface StateHomeServingFiles {
  /** The state-home folder, holding `layout.json`. */
  readonly sub: string
  readonly oldPoolState: string
  readonly newPoolState: string
  readonly oldJournal: string
  readonly newJournal: string
}

/**
 * The serving files of a state-home dataset. Only OpenCode's default dataset
 * can be in the state-home layout, so the old copies have the default names
 * beside the account state file.
 */
export function stateHomeServingFiles(
  paths: Pick<NativePoolPaths, 'legacyState' | 'state' | 'journal' | 'runtime'>,
): StateHomeServingFiles {
  const oldDir = dirname(paths.legacyState)
  return {
    sub: dirname(paths.runtime),
    oldPoolState: join(oldDir, STATE_HOME_FILE_NAMES.localPoolState),
    newPoolState: paths.state,
    oldJournal: join(oldDir, STATE_HOME_FILE_NAMES.journal),
    newJournal: paths.journal,
  }
}

type Identity = string | 'absent'

async function identityOf(path: string): Promise<Identity> {
  try {
    const info = await lstat(path, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent'
    throw error
  }
}

/**
 * What an old file holds: absent, the hash of a regular file, or `other` for
 * anything that isn't a plain file (a symlink, a folder), which can never be
 * proven to be the verified copy.
 */
type Observed = string | 'absent' | 'other'

async function observe(path: string): Promise<Observed> {
  try {
    return (await fileSha256(path)) ?? 'absent'
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === undefined
    )
      return 'other'
    throw error
  }
}

/** What the serving check saw of the old files. */
export interface StateHomeObservation {
  readonly oldJournal: boolean
  readonly oldPoolState: Observed
  /**
   * The journal under the name the move set it aside as
   * (`<journal>.moving-<attempt>`). Cleanup removes it; until then it must
   * still hold the verified bytes.
   */
  readonly movingJournal: Observed
}

/**
 * Why a state-home dataset must not be served now, or undefined when it may.
 * An old pool state or journal back at the legacy path after the move, or an
 * old pool state or set-aside journal whose bytes differ from the verified
 * copy while cleanup is still pending, is a fatal conflict: two
 * usable-looking copies of a single-use refresh token.
 */
export function stateHomeConflictFrom(
  record: StateLayoutRecord,
  files: StateHomeServingFiles,
  observed: StateHomeObservation,
): StateLayoutRefusalError | undefined {
  if (record.phase !== 'committed')
    return new StateLayoutRefusalError(
      'restore-unfinished',
      `anthropic-auth state for ${record.oldDir} is being restored to the old folder, so this process stopped using ${files.sub}. Restart OpenCode once the restore has finished.`,
      [files.sub],
    )
  if (record.cleanup === 'conflict') {
    const first = record.conflict?.[0]
    return stateLayoutConflict(
      first?.old ?? files.oldPoolState,
      first?.new ?? files.newPoolState,
    )
  }
  if (observed.oldJournal)
    return stateLayoutConflict(files.oldJournal, files.newJournal)
  const recorded = (role: 'localPoolState' | 'journal') =>
    record.files.find((file) => file.role === role)?.sha256 ?? null
  // While cleanup is pending the verified old copy may still be there; it
  // is behind the barriers. Any other bytes, or any old copy once cleanup
  // removed it, is a second copy.
  const second = (seen: Observed, sha256: string | null) =>
    seen !== 'absent' &&
    (record.cleanup !== 'pending' || sha256 === null || seen !== sha256)
  if (second(observed.oldPoolState, recorded('localPoolState')))
    return stateLayoutConflict(files.oldPoolState, files.newPoolState)
  // The set-aside journal is never served, so only a changed one while
  // cleanup is pending matters: cleanup would find it and stop every process.
  if (
    record.cleanup === 'pending' &&
    second(observed.movingJournal, recorded('journal'))
  )
    return stateLayoutConflict(
      movingJournalPath(files.oldJournal, record.attempt),
      files.newJournal,
    )
  return undefined
}

interface Evaluation {
  readonly refusal: StateLayoutRefusalError | undefined
  readonly record: StateLayoutRecord | undefined
  /** The set-aside journal of the record's attempt, when there is a record. */
  readonly moving: string | undefined
  /** Its `lstat` identity, taken before it was hashed. */
  readonly movingIdentity: Identity | undefined
}

async function evaluate(files: StateHomeServingFiles): Promise<Evaluation> {
  let record: StateLayoutRecord | undefined
  try {
    record = await readStateLayoutRecord(files.sub)
  } catch (error) {
    return {
      refusal: markerRefusal(files.sub, error),
      record: undefined,
      moving: undefined,
      movingIdentity: undefined,
    }
  }
  if (!record)
    return {
      refusal: markerRefusal(files.sub),
      record,
      moving: undefined,
      movingIdentity: undefined,
    }
  const moving = movingJournalPath(files.oldJournal, record.attempt)
  const movingIdentity = await identityOf(moving)
  const oldJournal = (await identityOf(files.oldJournal)) !== 'absent'
  const [oldPoolState, movingJournal] = await Promise.all([
    observe(files.oldPoolState),
    observe(moving),
  ])
  return {
    refusal: stateHomeConflictFrom(record, files, {
      oldJournal,
      oldPoolState,
      movingJournal,
    }),
    record,
    moving,
    movingIdentity,
  }
}

/** Read the marker and old files and report a conflict, without caching. */
export async function checkStateHomeServing(
  files: StateHomeServingFiles,
): Promise<StateLayoutRefusalError | undefined> {
  return (await evaluate(files)).refusal
}

function markerRefusal(sub: string, cause?: unknown) {
  const path = join(sub, STATE_HOME_FILE_NAMES.layoutMarker)
  return new StateLayoutRefusalError(
    'marker-unreadable',
    `anthropic-auth can't read ${path}, which records where its state is, so it stopped using that state. Restore the file from a backup or ask for help; do not delete the state folder.`,
    [path],
    cause,
  )
}

/** Conflicts already logged by this process, so each is logged once. */
const reported = new Set<string>()

/**
 * A guard that stops an already serving state-home process once its dataset
 * is in conflict. It has the relocation guard's shape so every locked write
 * callback that checks for a move (vault store, roster, routing, authorize)
 * checks for a conflict instead. It reads files again only when the `lstat`
 * identity of the marker, an old file or the set-aside journal changed, so a
 * check costs four `lstat`s while nothing changes.
 */
export function createStateHomeServingGuard(
  files: StateHomeServingFiles,
): RelocationGuard & { check(): Promise<StateLayoutRefusalError | undefined> } {
  const marker = join(files.sub, STATE_HOME_FILE_NAMES.layoutMarker)
  let last:
    | {
        key: string
        moving: string | undefined
        refusal: StateLayoutRefusalError | undefined
      }
    | undefined
  async function check() {
    // Every identity is taken before the file it describes is read, so a
    // change after this point always shows up as a new key next time.
    const watched = [marker, files.oldJournal, files.oldPoolState]
    const moving = last?.moving
    const identities = await Promise.all(
      (moving ? [...watched, moving] : watched).map(identityOf),
    )
    const before = identities.slice(0, watched.length)
    if (
      last &&
      last.key === JSON.stringify([before, moving ?? null, identities[3]])
    )
      return last.refusal
    const result = await evaluate(files)
    last = {
      key: JSON.stringify([
        before,
        result.moving ?? null,
        result.movingIdentity,
      ]),
      moving: result.moving,
      refusal: result.refusal,
    }
    const refusal = result.refusal
    if (refusal && !reported.has(refusal.message)) {
      reported.add(refusal.message)
      logger.error('state-layout', refusal.message, {
        code: refusal.code,
        paths: refusal.paths,
      })
    }
    return refusal
  }
  return {
    check,
    async assertNotRelocated() {
      const refusal = await check()
      if (refusal) throw refusal
    },
    async isRelocated() {
      return (await check()) !== undefined
    },
  }
}

/** Forget logged conflicts; tests only. */
export function resetStateHomeServingGuardForTests() {
  reported.clear()
}
