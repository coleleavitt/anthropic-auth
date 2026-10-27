import { randomUUID } from 'node:crypto'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJsonRedacted } from './json.ts'
import {
  createOwnerOnlyFile,
  publishOwned,
  type StateLayoutFs,
} from './state-layout-io.ts'
import {
  STATE_HOME_FILE_NAMES,
  STATE_LAYOUT_PHASES,
  StateLayoutFileError,
  type StateLayoutPhase,
} from './state-layout-paths.ts'

/**
 * The data files a move copies, in the order cleanup removes the old copies:
 * the local pool state (refresh tokens) first.
 */
export const RELOCATION_ROLES = [
  'localPoolState',
  'journal',
  'localRoster',
  'vaultStoreState',
  'vaultRoster',
  'vaultRouting',
  'localRuntime',
  'vaultRuntime',
] as const
export type RelocationRole = (typeof RELOCATION_ROLES)[number]

/** Old files whose change or reappearance after a move is a fatal conflict. */
export const CREDENTIAL_AUTHORITY_ROLES: readonly RelocationRole[] = [
  'localPoolState',
  'journal',
]

/** One file of a move: where it was, where it goes, and its bytes' hash. */
export interface RelocationFileRecord {
  readonly role: RelocationRole
  readonly from: string
  readonly to: string
  /** Null when the file was absent at the move. */
  readonly sha256: string | null
}

export interface RelocationBarriers {
  /** Whether the old journal existed and was set aside. */
  readonly journal: 'present' | 'absent'
  /** The hash of each old runtime before its tombstone, or null when absent. */
  readonly localRuntime: { readonly original: string | null }
  readonly vaultRuntime: { readonly original: string | null }
}

/** The full `layout.json` a move writes. */
export interface StateLayoutRecord {
  readonly version: 1
  readonly phase: StateLayoutPhase
  readonly attempt: string
  readonly identity: string
  readonly stateRoot: string
  readonly sub: string
  readonly oldDir: string
  readonly storageIds: { readonly local: string; readonly vault: string }
  readonly by: string
  readonly startedAt: number
  readonly files: readonly RelocationFileRecord[]
  readonly barriers: RelocationBarriers
  readonly committedAt?: number
  readonly cleanup?: 'pending' | 'done' | 'kept' | 'conflict'
  /** Old non-credential files whose bytes changed after the move; left in place. */
  readonly kept?: readonly string[]
  /** Old credential or journal files found changed or back after the move. */
  readonly conflict?: readonly { readonly old: string; readonly new: string }[]
  readonly rolledBackAt?: number
  /** Present while a restore is under way or finished; written by restore. */
  readonly restore?: { readonly cleanup?: 'pending' | 'done' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
function hash(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
  )
}
/**
 * A move's attempt id is a random UUID. It becomes part of file names
 * (`<journal>.moving-<attempt>`, staging names), so nothing else is accepted.
 */
function attemptId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
}

function parseRecord(value: unknown): StateLayoutRecord | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const {
    phase,
    attempt,
    identity,
    stateRoot,
    sub,
    oldDir,
    storageIds,
    by,
    startedAt,
    files,
    barriers,
  } = value
  if (
    !(STATE_LAYOUT_PHASES as readonly unknown[]).includes(phase) ||
    !attemptId(attempt) ||
    !text(identity) ||
    !text(stateRoot) ||
    !text(sub) ||
    !text(oldDir) ||
    !isRecord(storageIds) ||
    !text(storageIds.local) ||
    !text(storageIds.vault) ||
    !text(by) ||
    typeof startedAt !== 'number' ||
    !Array.isArray(files) ||
    !isRecord(barriers)
  )
    return undefined
  const parsedFiles: RelocationFileRecord[] = []
  for (const file of files) {
    if (
      !isRecord(file) ||
      !(RELOCATION_ROLES as readonly unknown[]).includes(file.role) ||
      !text(file.from) ||
      !text(file.to) ||
      !hash(file.sha256)
    )
      return undefined
    parsedFiles.push({
      role: file.role as RelocationRole,
      from: file.from,
      to: file.to,
      sha256: file.sha256,
    })
  }
  if (new Set(parsedFiles.map((file) => file.role)).size !== parsedFiles.length)
    return undefined
  // A record always lists every role, once.
  if (parsedFiles.length !== RELOCATION_ROLES.length) return undefined
  const sha = (role: RelocationRole) =>
    parsedFiles.find((file) => file.role === role)?.sha256 ?? null
  const runtimeBarrier = (raw: unknown) =>
    isRecord(raw) && hash(raw.original) ? { original: raw.original } : undefined
  const localRuntime = runtimeBarrier(barriers.localRuntime)
  const vaultRuntime = runtimeBarrier(barriers.vaultRuntime)
  // The barriers describe the same snapshot as the file list: the journal was
  // set aside exactly when it existed, and each runtime's original bytes are
  // the ones the list recorded.
  const journal = sha('journal') === null ? 'absent' : 'present'
  if (
    barriers.journal !== journal ||
    !localRuntime ||
    !vaultRuntime ||
    localRuntime.original !== sha('localRuntime') ||
    vaultRuntime.original !== sha('vaultRuntime')
  )
    return undefined
  const cleanup = value.cleanup
  if (
    cleanup !== undefined &&
    cleanup !== 'pending' &&
    cleanup !== 'done' &&
    cleanup !== 'kept' &&
    cleanup !== 'conflict'
  )
    return undefined
  if (phase === 'committed' && cleanup === undefined) return undefined
  const kept = value.kept
  if (kept !== undefined && !(Array.isArray(kept) && kept.every(text)))
    return undefined
  const conflict = value.conflict
  if (
    conflict !== undefined &&
    !(
      Array.isArray(conflict) &&
      conflict.every(
        (entry) => isRecord(entry) && text(entry.old) && text(entry.new),
      )
    )
  )
    return undefined
  let restore: StateLayoutRecord['restore']
  if (value.restore !== undefined) {
    if (!isRecord(value.restore)) return undefined
    const restoreCleanup = value.restore.cleanup
    if (
      restoreCleanup !== undefined &&
      restoreCleanup !== 'pending' &&
      restoreCleanup !== 'done'
    )
      return undefined
    restore = restoreCleanup === undefined ? {} : { cleanup: restoreCleanup }
  }
  return {
    version: 1,
    phase: phase as StateLayoutPhase,
    attempt,
    identity,
    stateRoot,
    sub,
    oldDir,
    storageIds: { local: storageIds.local, vault: storageIds.vault },
    by,
    startedAt,
    files: parsedFiles,
    barriers: {
      journal,
      localRuntime,
      vaultRuntime,
    },
    ...(typeof value.committedAt === 'number'
      ? { committedAt: value.committedAt }
      : {}),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(kept === undefined ? {} : { kept: kept as string[] }),
    ...(conflict === undefined
      ? {}
      : {
          conflict: (conflict as { old: string; new: string }[]).map(
            (entry) => ({ old: entry.old, new: entry.new }),
          ),
        }),
    ...(typeof value.rolledBackAt === 'number'
      ? { rolledBackAt: value.rolledBackAt }
      : {}),
    ...(restore === undefined ? {} : { restore }),
  }
}

export function layoutRecordPath(sub: string): string {
  return join(sub, STATE_HOME_FILE_NAMES.layoutMarker)
}

/** The name the journal is set aside under during a move. */
export function movingJournalPath(journal: string, attempt: string): string {
  return `${journal}.moving-${attempt}`
}

/**
 * Read `<sub>/layout.json` in full. Undefined only when it is absent; any other
 * read error, and any content that isn't a complete record, throws
 * `StateLayoutFileError`. An unreadable marker never counts as "no move".
 */
export async function readStateLayoutRecord(
  sub: string,
): Promise<StateLayoutRecord | undefined> {
  const path = layoutRecordPath(sub)
  let bytes: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 4 * 1024 * 1024)
      throw new StateLayoutFileError('invalid', path)
    bytes = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof StateLayoutFileError) throw error
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw new StateLayoutFileError('unreadable', path, error)
  }
  let value: unknown
  try {
    value = parseJsonRedacted(bytes)
  } catch {
    throw new StateLayoutFileError('invalid', path)
  }
  const record = parseRecord(value)
  if (!record) throw new StateLayoutFileError('invalid', path)
  return record
}

/**
 * Publish `record` as `<sub>/layout.json` durably: stage it owner-only as
 * `layout.json.<attempt>.<nonce>.tmp`, flush it, rename it into place through
 * `publishOwned`, then flush `<sub>`. `expect` is the ownership check for the
 * slot (for example "still this attempt's preparing record").
 */
export async function publishStateLayoutRecord(
  record: StateLayoutRecord,
  guard: Parameters<typeof publishOwned>[1],
  fs: StateLayoutFs,
): Promise<void> {
  const path = layoutRecordPath(record.sub)
  const stage = `${path}.${record.attempt}.${randomUUID()}.tmp`
  await createOwnerOnlyFile(
    fs,
    stage,
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
  )
  try {
    const outcome = await publishOwned(
      { kind: 'rename', from: stage, to: path },
      guard,
      fs,
    )
    if (outcome === 'skipped')
      throw new Error(`anthropic-auth could not publish ${path}`)
  } catch (error) {
    await unlink(stage).catch(() => {})
    throw error
  }
  await fs.syncDirectory(record.sub)
}

/** Whether `name` in `<sub>` is a staging file of a layout record. */
export function isLayoutRecordStage(name: string, attempt?: string): boolean {
  const prefix = `${STATE_HOME_FILE_NAMES.layoutMarker}.`
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false
  return attempt === undefined || name.startsWith(`${prefix}${attempt}.`)
}
