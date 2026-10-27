/**
 * Why a process refuses to use a dataset while deciding or serving the
 * state-home layout. Each code has one fixed message; where a person must act
 * on a file, the message names it.
 */
export type StateLayoutRefusalCode =
  /** An old copy of the credentials or journal is back beside a moved copy. */
  | 'conflict'
  /** The dataset was moved under another state root (`XDG_STATE_HOME`). */
  | 'moved-elsewhere'
  /** A marker or tombstone belongs to a different config folder or dataset. */
  | 'other-dataset'
  /** `layout.json` exists but can't be read or parsed, or is missing after a move. */
  | 'marker-unreadable'
  /** A restore to the legacy layout stopped part way. */
  | 'restore-unfinished'
  /** Another process holds the layout for longer than this process waits. */
  | 'busy'
  /** The move could not be made durable or undone; serving either copy is unsafe. */
  | 'unsafe'
  /** The state folder holds data this process can't prove it wrote. */
  | 'unexpected-data'

/**
 * A refusal to serve a dataset from either layout. The process must not do
 * any pool I/O for the dataset after it.
 */
export class StateLayoutRefusalError extends Error {
  readonly code: StateLayoutRefusalCode
  /** The files the message names, for logs and diagnostics. */
  readonly paths: readonly string[]

  constructor(
    code: StateLayoutRefusalCode,
    message: string,
    paths: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StateLayoutRefusalError'
    this.code = code
    this.paths = Object.freeze([...paths])
  }
}

/**
 * Two copies of the local credentials (or of the migration journal) exist:
 * the moved one in the state folder and an old one in the config folder that
 * changed or reappeared after the move was verified. Using either could spend
 * a single-use refresh token twice, so every process stops serving the
 * dataset until a person keeps one copy.
 */
export function stateLayoutConflict(
  oldPath: string,
  newPath: string,
  cause?: unknown,
): StateLayoutRefusalError {
  return new StateLayoutRefusalError(
    'conflict',
    `anthropic-auth found two copies of the same account state: ${oldPath} (old folder) and ${newPath} (state folder). It stopped using both so a refresh token is never used twice. Keep the copy you trust, move the other one out of both folders, then restart OpenCode.`,
    [oldPath, newPath],
    cause,
  )
}

/** The dataset was moved to a state root other than the one this process uses. */
export function stateLayoutMovedElsewhere(
  configDir: string,
  relocatedTo: string,
  stateRoot: string,
): StateLayoutRefusalError {
  return new StateLayoutRefusalError(
    'moved-elsewhere',
    `anthropic-auth state for ${configDir} was moved to ${relocatedTo}, but this process uses state root ${stateRoot}. Restore XDG_STATE_HOME, or run \`anthropic-auth layout restore-legacy\` from the old root first.`,
    [configDir, relocatedTo, stateRoot],
  )
}
