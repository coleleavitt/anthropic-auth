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
 * Why a state-home dataset must not be served now, or undefined when it may.
 * An old pool state or journal back at the legacy path after the move, or an
 * old pool state whose bytes differ from the verified copy while cleanup is
 * still pending, is a fatal conflict: two usable-looking copies of a
 * single-use refresh token.
 */
export function stateHomeConflictFrom(
  record: StateLayoutRecord,
  files: StateHomeServingFiles,
  observed: { oldJournal: boolean; oldPoolState: string | null | 'absent' },
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
  if (observed.oldPoolState !== 'absent') {
    const recorded = record.files.find(
      (file) => file.role === 'localPoolState',
    )?.sha256
    // While cleanup is pending the verified old copy may still be there; it
    // is behind the barriers. Any other bytes, or any old copy once cleanup
    // removed it, is a second copy.
    if (
      record.cleanup !== 'pending' ||
      recorded === null ||
      recorded === undefined ||
      observed.oldPoolState !== recorded
    )
      return stateLayoutConflict(files.oldPoolState, files.newPoolState)
  }
  return undefined
}

/** Read the marker and old files and report a conflict, without caching. */
export async function checkStateHomeServing(
  files: StateHomeServingFiles,
): Promise<StateLayoutRefusalError | undefined> {
  let record: StateLayoutRecord | undefined
  try {
    record = await readStateLayoutRecord(files.sub)
  } catch (error) {
    return markerRefusal(files.sub, error)
  }
  if (!record) return markerRefusal(files.sub)
  const oldJournal = (await identityOf(files.oldJournal)) !== 'absent'
  const oldPoolState =
    (await identityOf(files.oldPoolState)) === 'absent'
      ? 'absent'
      : await fileSha256(files.oldPoolState)
  return stateHomeConflictFrom(record, files, { oldJournal, oldPoolState })
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
 * identity of the marker or an old file changed, so a check costs three
 * `lstat`s while nothing changes.
 */
export function createStateHomeServingGuard(
  files: StateHomeServingFiles,
): RelocationGuard & { check(): Promise<StateLayoutRefusalError | undefined> } {
  const marker = join(files.sub, STATE_HOME_FILE_NAMES.layoutMarker)
  let last:
    | { key: string; refusal: StateLayoutRefusalError | undefined }
    | undefined
  async function check() {
    const key = JSON.stringify(
      await Promise.all(
        [marker, files.oldJournal, files.oldPoolState].map(identityOf),
      ),
    )
    if (last?.key === key) return last.refusal
    const refusal = await checkStateHomeServing(files)
    last = { key, refusal }
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
