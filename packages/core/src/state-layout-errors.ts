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
  /** A restore to the legacy layout can't start; the message names what to fix. */
  | 'restore-refused'

/** The command that restores the legacy layout, as users run it. */
export const RESTORE_LEGACY_COMMAND =
  'npx @cortexkit/opencode-anthropic-auth setup --restore-legacy'

/**
 * One fixed message per refusal, naming no file. Hosts show these where
 * their output may be shared (OpenCode 2's error surface, the CLI); the
 * refusal's own message, which names the files involved, goes to the log.
 */
const PUBLIC_MESSAGES: Record<StateLayoutRefusalCode, string> = {
  conflict:
    'anthropic-auth found two copies of the same account state and stopped using both so a refresh token is never used twice. The log names both files: keep the copy you trust, move the other one away, then restart OpenCode.',
  'moved-elsewhere': `anthropic-auth state for this config folder was moved under another state folder (XDG_STATE_HOME). Restore XDG_STATE_HOME, or run ${RESTORE_LEGACY_COMMAND} with the old XDG_STATE_HOME first. The log names both folders.`,
  'other-dataset':
    "anthropic-auth's state folder belongs to another config folder. Check OPENCODE_CONFIG_DIR and any symlink to the config folder; the log names both folders.",
  'marker-unreadable':
    "anthropic-auth can't read the record of where its state is, so it won't use either copy. The log names the file; restore it from a backup or ask for help, and do not delete the state folder.",
  'restore-unfinished': `A restore of anthropic-auth's state did not finish; run ${RESTORE_LEGACY_COMMAND} again.`,
  busy: 'Another anthropic-auth process is moving or restoring state for this folder; start again in a minute.',
  unsafe:
    "anthropic-auth could not finish or undo a change of where its state is, so it won't use either copy. The log names the files involved.",
  'unexpected-data':
    "anthropic-auth's state folder holds files it did not write, so it won't use them. The log names the files.",
  'restore-refused': `anthropic-auth can't restore the old layout yet. Run ${RESTORE_LEGACY_COMMAND} to see what to fix.`,
}

/** Every fixed message `stateLayoutRefusalPublicMessage` can return. */
export const STATE_LAYOUT_REFUSAL_PUBLIC_MESSAGES: readonly string[] = [
  ...new Set(Object.values(PUBLIC_MESSAGES)),
]

/** The fixed message, naming no file, for a refusal with `code`. */
export function stateLayoutRefusalPublicMessage(
  code: StateLayoutRefusalCode,
): string {
  return PUBLIC_MESSAGES[code]
}

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
    `anthropic-auth state for ${configDir} was moved to ${relocatedTo}, but this process uses state root ${stateRoot}. Restore XDG_STATE_HOME, or run ${RESTORE_LEGACY_COMMAND} with the old XDG_STATE_HOME first.`,
    [configDir, relocatedTo, stateRoot],
  )
}
