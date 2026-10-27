import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LockContentionError } from '@cortexkit/common-auth/fs'

import { getOpenCodeConfigDir } from './accounts.ts'
import {
  anthropicAuthRelease,
  buildHolderEntry,
  deferNativePoolHolderRegistration,
  ensureHolderDirectory,
  HOLDER_FILE_NAME,
  type HolderLiveness,
  HolderRegistrationError,
  type HolderRole,
  type NativeHolderRegistration,
  nativeHolderDatasetFiles,
  publishHolderEntryLocked,
  registerNativePoolHolder,
} from './holder-registry.ts'
import {
  defaultPreNArtifactLocations,
  describeFenceBlocker,
  holderFenceBlockers,
  type PreNArtifactLocations,
  preNArtifactBlockers,
  STATE_PATH_OVERRIDE_VARIABLES,
  statePathOverrides,
} from './layout-fence.ts'
import { logger } from './logger.ts'
import type { NativeLockEvent } from './native-lock-observer.ts'
import { ensureWindowsOwnerOnlyDirectory } from './owner-only.ts'
import {
  canonicalPath,
  type NativePoolPaths,
  resolveNativePoolPaths,
} from './pool-paths.ts'
import {
  checkStateHomeServing,
  stateHomeServingFiles,
  warnReappearedMetadata,
} from './state-home-serving-guard.ts'
import {
  RESTORE_LEGACY_COMMAND,
  StateLayoutRefusalError,
  stateLayoutMovedElsewhere,
} from './state-layout-errors.ts'
import {
  defaultStateLayoutFs,
  type StateLayoutFs,
  StateLayoutLockStack,
} from './state-layout-io.ts'
import {
  acquireDataLocks,
  acquireHolderLocks,
  cleanupOldCopies,
  drainCoalescedWrites,
  exists,
  LAYOUT_LOCK_NAME,
  LAYOUT_LOCK_TIMEOUT_MS,
  type LegacyDatasetFiles,
  moveDataset,
  movePreconditionFailure,
  type RelocationDataset,
  recordFilesProblem,
  resolveLegacyDatasetFiles,
  resolveRelocationDataset,
  rollbackPreparing,
  StateLayoutCrash,
  StateLayoutRollbackRefused,
  type StateLayoutStep,
  type StateLayoutTransitionContext,
  stateLayoutStep,
  syncCommitted,
} from './state-layout-move.ts'
import {
  LEGACY_STATE_LAYOUT,
  readConfigDirMarker,
  readRelocationPointer,
  recordProcessStateLayout,
  resolveStateHomeTarget,
  type StateLayout,
  StateLayoutFileError,
} from './state-layout-paths.ts'
import {
  layoutRecordPath,
  readStateLayoutRecord,
  type StateLayoutRecord,
} from './state-layout-record.ts'
import {
  discardAbandonedRestore,
  finishRestoreRetirement,
} from './state-layout-restore.ts'

const ACCOUNT_FILE = 'anthropic-auth.json'
const ACCOUNT_STATE_FILE = 'anthropic-auth-state.json'

/**
 * Whether a start may move OpenCode's dataset out of its config folder into
 * the state folder. While it is false, a start the fence would let move keeps
 * the legacy layout instead, and registration of a dataset that has not
 * moved is best-effort, as in 2.4.x (see `unmovedRegistrationPolicy`).
 * Everything else the decision does still runs: serving a dataset already
 * moved, recovering an unfinished move or restore, the conflict and refusal
 * checks, and the mandatory state-home registration. The release that ships
 * the move turns it on.
 */
export const RELOCATION_MOVE_ENABLED = false

let moveEnabledOverride: boolean | undefined

/** Turn the move on or off for this process, or back to the default; tests only. */
export function setRelocationMoveEnabledForTests(
  enabled: boolean | undefined,
): void {
  moveEnabledOverride = enabled
}

function relocationMoveEnabled(options: { moveEnabled?: boolean }): boolean {
  return options.moveEnabled ?? moveEnabledOverride ?? RELOCATION_MOVE_ENABLED
}

/**
 * How a dataset that has not moved (OpenCode's legacy or explicit dataset,
 * or Pi's) is registered, from the same switch as the move itself.
 *
 * While moving is off this code ships in ordinary releases before the move
 * release, and must serve every install that 2.4.x serves. So, as in 2.4.x,
 * a failed registration is logged once at WARN and retried in the
 * background (`undefined`, the ordinary policy of `registerNativePoolHolder`).
 * Once moving is on, an unregistered process could have its files moved from
 * under it, so registration is `mandatory`. Either way a state-home
 * admission must register, and a relocation tombstone or an override into a
 * managed folder refuses.
 */
export function unmovedRegistrationPolicy(
  options: { moveEnabled?: boolean } = {},
): 'mandatory' | undefined {
  return relocationMoveEnabled(options) ? 'mandatory' : undefined
}

/** Why a start the fence would let move stays legacy while moving is off. */
export const RELOCATION_MOVE_DISABLED_REASON =
  'moving state out of the config folder is not enabled in this release'

export interface DecideStateLayoutOptions {
  role: HolderRole
  env?: NodeJS.ProcessEnv
  home?: string
  /** Filesystem seam; `node:fs` for this platform otherwise. */
  fs?: StateLayoutFs
  liveness?: HolderLiveness
  /** Where pid artifacts of older versions are looked for. */
  artifacts?: PreNArtifactLocations
  onLockEvent?: (event: NativeLockEvent) => void
  /** Runs at each named step of a move, rollback or cleanup; tests inject faults here. */
  onStep?: (step: StateLayoutStep) => void | Promise<void>
  now?: () => number
  /** Tests shorten the waits; production uses the defaults. */
  timeouts?: { layoutMs?: number; holderMs?: number; dataMs?: number }
  /** Overrides `RELOCATION_MOVE_ENABLED`; tests only. */
  moveEnabled?: boolean
}

/** The layout a process uses for OpenCode's dataset, decided once at start. */
export type StateLayoutDecision =
  | {
      readonly kind: 'explicit'
      readonly layout: StateLayout
      readonly registration: NativeHolderRegistration
    }
  | {
      readonly kind: 'legacy'
      readonly layout: StateLayout
      /** Why the dataset was not moved, when a move was considered. */
      readonly reasons: readonly string[]
      readonly registration?: NativeHolderRegistration
    }
  | {
      readonly kind: 'state-home'
      readonly layout: StateLayout
      readonly dataset: RelocationDataset
      readonly record: StateLayoutRecord
      /** True when this process made the move. */
      readonly moved: boolean
    }

function isExplicit(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() ||
      env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim(),
  )
}

function refuse(
  code: StateLayoutRefusalError['code'],
  message: string,
  paths: readonly string[] = [],
  cause?: unknown,
): never {
  const error = new StateLayoutRefusalError(code, message, paths, cause)
  logger.error('state-layout', message, { code, paths })
  throw error
}

function markerUnreadable(sub: string, cause?: unknown): never {
  const path = layoutRecordPath(sub)
  refuse(
    'marker-unreadable',
    `anthropic-auth can't read ${path}, which records where its state is, so it won't use either copy. Restore the file from a backup or ask for help; do not delete the state folder.`,
    [path],
    cause,
  )
}

function busy(configDir: string, cause?: unknown): never {
  refuse(
    'busy',
    `Another anthropic-auth process is moving or restoring state for ${configDir}; start again in a minute.`,
    [configDir],
    cause,
  )
}

function restoreUnfinished(configDir: string): never {
  refuse(
    'restore-unfinished',
    `A restore of anthropic-auth's state for ${configDir} did not finish; run ${RESTORE_LEGACY_COMMAND} again.`,
    [configDir],
  )
}

/** A `restored` record whose cleanup is done reads as "no move". */
function noMoveRecord(record: StateLayoutRecord | undefined): boolean {
  return (
    record === undefined ||
    record.phase === 'rolled-back' ||
    (record.phase === 'restored' && record.restore?.cleanup === 'done')
  )
}

/** Refuse a record written for another folder or dataset. */
function requireRecordMatches(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
): void {
  if (
    record.identity !== dataset.identity ||
    record.oldDir !== dataset.oldDir ||
    record.sub !== dataset.sub ||
    record.storageIds.local !== dataset.storageIds.local ||
    record.storageIds.vault !== dataset.storageIds.vault
  )
    refuse(
      'other-dataset',
      `${layoutRecordPath(dataset.sub)} belongs to another config folder (${record.oldDir}), not ${dataset.oldDir}. Check OPENCODE_CONFIG_DIR and any symlink to the config folder.`,
      [layoutRecordPath(dataset.sub), record.oldDir, dataset.oldDir],
    )
  // Recovery acts only on the files a record names: it must name exactly
  // this dataset's files.
  const problem = recordFilesProblem(record, dataset)
  if (problem) markerUnreadable(dataset.sub, new Error(problem))
}

async function readRecord(sub: string) {
  try {
    return await readStateLayoutRecord(sub)
  } catch (error) {
    markerUnreadable(sub, error)
  }
}

/** Register this process's use of `paths` while the caller holds `holderFile`'s lock. */
async function registerHeld(
  holderFile: string,
  paths: NativePoolPaths,
  kind: 'legacy' | 'state-home',
  identity: string,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
): Promise<void> {
  const entry = await buildHolderEntry({
    role: options.role,
    kind,
    identity,
    files: nativeHolderDatasetFiles(paths),
    liveness: options.liveness,
    now: options.now,
  })
  try {
    await publishHolderEntryLocked(holderFile, entry, {
      liveness: options.liveness,
      assertOwned: () => ctx.stack.assertAll(),
    })
  } catch (error) {
    // Without the entry a later move or restore can't see this process. A
    // state-home admission therefore refuses; a legacy one decides by
    // `unmovedRegistrationPolicy` (see `registerLegacyHeld`).
    throw error instanceof HolderRegistrationError
      ? error
      : new HolderRegistrationError('unavailable', dirname(holderFile), error)
  }
}

/**
 * The ordinary registration of a legacy dataset, handed to the background
 * retry after `error`: logged once at WARN and retried until it succeeds.
 */
function deferLegacyRegistration(
  paths: NativePoolPaths,
  dir: string,
  options: DecideStateLayoutOptions,
  error: unknown,
): NativeHolderRegistration {
  return deferNativePoolHolderRegistration(
    {
      paths,
      role: options.role,
      kind: 'legacy',
      onLockEvent: options.onLockEvent,
      liveness: options.liveness,
      lockTimeoutMs: options.timeouts?.holderMs,
      now: options.now,
    },
    { directory: dir, error },
  )
}

/**
 * Register a legacy start while `ctx` holds the config folder's holder lock.
 * Resolves undefined once registered. When `unmovedRegistrationPolicy` is
 * mandatory a failure refuses; otherwise it is handed to the background
 * retry and the pending registration is returned, and the start serves.
 */
async function registerLegacyHeld(
  oldDir: string,
  paths: NativePoolPaths,
  identity: string,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
): Promise<NativeHolderRegistration | undefined> {
  try {
    await registerHeld(
      join(oldDir, HOLDER_FILE_NAME),
      paths,
      'legacy',
      identity,
      options,
      ctx,
    )
    return undefined
  } catch (error) {
    if (unmovedRegistrationPolicy(options) === 'mandatory') throw error
    return deferLegacyRegistration(paths, oldDir, options, error)
  }
}

/** Record and return the legacy layout for `paths`. */
function chooseLegacy(
  paths: NativePoolPaths,
  reasons: string[],
  log: boolean,
  registration: NativeHolderRegistration | undefined,
): StateLayoutDecision {
  recordProcessStateLayout(paths.legacyConfig, LEGACY_STATE_LAYOUT)
  if (reasons.length && log)
    logger.info(
      'state-layout',
      'anthropic-auth keeps its runtime files in OpenCode’s config folder until every running OpenCode or Pi using them has restarted on this version',
      { reasons },
    )
  return {
    kind: 'legacy',
    layout: LEGACY_STATE_LAYOUT,
    reasons,
    ...(registration ? { registration } : {}),
  }
}

/**
 * Admit this process to the state-home layout while
 * `ctx.stack` holds `<sub>`'s holder lock: the record must still be
 * committed, no old credential or journal copy may be back, and the
 * `state-home` registration must be published.
 */
async function admitHeld(
  dataset: RelocationDataset,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
  moved: boolean,
  allowPendingCleanup: boolean,
): Promise<StateLayoutDecision | 'changed'> {
  const record = await readRecord(dataset.sub)
  if (
    record?.phase !== 'committed' ||
    (!allowPendingCleanup && record.cleanup === 'pending')
  )
    return 'changed'
  requireRecordMatches(record, dataset)
  const conflict = await checkStateHomeServing(
    stateHomeServingFiles(dataset.newPaths),
  )
  if (conflict) {
    logger.error('state-layout', conflict.message, {
      code: conflict.code,
      paths: conflict.paths,
    })
    throw conflict
  }
  await warnReappearedMetadata(record)
  await registerHeld(
    join(dataset.sub, HOLDER_FILE_NAME),
    dataset.newPaths,
    'state-home',
    dataset.identity,
    options,
    ctx,
  )
  const layout: StateLayout = { kind: 'state-home', dir: dataset.sub }
  recordProcessStateLayout(dataset.oldPaths.legacyConfig, layout)
  return { kind: 'state-home', layout, dataset, record, moved }
}

/** Take only `<sub>`'s holder lock and admit, without the layout lock. */
async function admitFast(
  dataset: RelocationDataset,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutDecision | 'changed'> {
  try {
    await ctx.stack.acquire({
      name: 'holders',
      path: join(dataset.sub, HOLDER_FILE_NAME),
      timeoutMs: ctx.holderLockTimeoutMs,
    })
  } catch (error) {
    if (error instanceof LockContentionError) busy(dataset.configDir, error)
    throw error
  }
  try {
    return await admitHeld(dataset, options, ctx, false, false)
  } finally {
    await ctx.stack.releaseAll()
  }
}

/**
 * Read the relocation tombstone over `runtime`, if any. A file that can't be
 * read at all refuses with a fixed public message instead of escaping as a
 * raw error that names the file.
 */
async function readPointer(runtime: string) {
  try {
    return await readRelocationPointer(runtime)
  } catch (error) {
    refuse(
      'marker-unreadable',
      `anthropic-auth can't read ${runtime}, which may record that its state was moved, so it won't use either copy.`,
      [runtime],
      error,
    )
  }
}

/**
 * Read both relocation tombstones in the old folder. Refuses when one belongs
 * to another config folder or names another state root; true when one
 * points at this dataset's state-home folder.
 */
async function readPointers(dataset: RelocationDataset): Promise<boolean> {
  let pointed = false
  for (const runtime of [dataset.oldPaths.runtime, dataset.oldVault.runtime]) {
    const pointer = await readPointer(runtime)
    if (!pointer) continue
    if (pointer.identity !== dataset.identity)
      refuse(
        'other-dataset',
        `${runtime} says the state there belongs to ${pointer.identity}, not to ${dataset.identity}.`,
        [runtime],
      )
    if (pointer.relocatedTo !== dataset.sub)
      throw stateLayoutMovedElsewhere(
        dataset.oldDir,
        pointer.relocatedTo,
        dataset.stateRoot,
      )
    pointed = true
  }
  return pointed
}

/**
 * Keep the dataset in the old folder, while `ctx` holds the old folder's
 * holder lock. The choice to stay was made from files read before that lock
 * was held, and a mover under another `XDG_STATE_HOME` takes a different
 * layout lock, so it may have committed meanwhile: its tombstones and its
 * marker are read again first. `changed` means start the decision over.
 */
async function legacyHeld(
  dataset: RelocationDataset,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
  reasons: string[],
  log = true,
): Promise<StateLayoutDecision | 'changed'> {
  const pointed = await readPointers(dataset)
  const record = await readRecord(dataset.sub)
  if (record) requireRecordMatches(record, dataset)
  if (pointed && noMoveRecord(record)) markerUnreadable(dataset.sub)
  if (pointed || !noMoveRecord(record)) return 'changed'
  const registration = await registerLegacyHeld(
    dataset.oldDir,
    dataset.oldPaths,
    dataset.identity,
    options,
    ctx,
  )
  return chooseLegacy(dataset.oldPaths, reasons, log, registration)
}

/**
 * Whether the config folder shows a move or restore of its dataset: a
 * relocation tombstone over either runtime file, or the journal set aside by
 * a move that stopped before its tombstones. A move installs both
 * tombstones before it commits, and a restore removes them only once the
 * legacy files are back, so without either the config folder's copy is the
 * only one any process may serve, whatever the state folder holds.
 */
async function oldFolderTransition(old: LegacyDatasetFiles): Promise<boolean> {
  for (const runtime of [old.oldPaths.runtime, old.oldVault.runtime])
    if (await readPointer(runtime)) return true
  // Only a journal that is absent can have been set aside.
  const journal = old.oldPaths.journal
  let names: string[]
  try {
    if (await exists(journal)) return false
    names = await readdir(dirname(journal))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    // What the folder holds is unknown: let the full decision look.
    return true
  }
  const prefix = `${basename(journal)}.moving-`
  return names.some((name) => name.startsWith(prefix))
}

/**
 * While moving is off: stay legacy, as 2.4.x does, without resolving or
 * reading anything in the state folder, so an unreadable state root or stray
 * files there never stop a healthy legacy install. Undefined when the config
 * folder shows a move or restore (`oldFolderTransition`); the full decision
 * then runs, with its strict checks of the state folder.
 *
 * The tombstones are read again under the config folder's holder lock: a
 * mover under any `XDG_STATE_HOME` holds that lock from its fence to its
 * end, so a move that committed while this start waited is seen. When the
 * lock can't be taken the start still serves, as 2.4.x does, with its
 * registration retried in the background; a move that commits later is
 * stopped by the tombstones it installs, which the relocation guards check.
 */
async function legacyWhileMoveOff(
  configDir: string,
  identity: string,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
  stayReasons: string[],
): Promise<StateLayoutDecision | undefined> {
  const old = await resolveLegacyDatasetFiles(configDir)
  if (await oldFolderTransition(old)) return undefined
  try {
    await stateLayoutStep(ctx, 'old-holders-locking')
    let lockFailure: { error: unknown } | undefined
    try {
      await ctx.stack.acquire({
        name: 'holders',
        path: join(old.oldDir, HOLDER_FILE_NAME),
        timeoutMs: ctx.holderLockTimeoutMs,
      })
    } catch (error) {
      lockFailure = { error }
    }
    if (await oldFolderTransition(old)) return undefined
    const registration = lockFailure
      ? deferLegacyRegistration(
          old.oldPaths,
          old.oldDir,
          options,
          lockFailure.error,
        )
      : await registerLegacyHeld(
          old.oldDir,
          old.oldPaths,
          identity,
          options,
          ctx,
        )
    // Moving being off is not worth a log line; the other reasons are.
    return chooseLegacy(
      old.oldPaths,
      stayReasons.length ? stayReasons : [RELOCATION_MOVE_DISABLED_REASON],
      stayReasons.length > 0,
      registration,
    )
  } finally {
    await ctx.stack.releaseAll().catch(() => {})
  }
}

/** The state folder can't be resolved; refuse with a fixed public message. */
function stateFolderUnreadable(dir: string, cause: unknown): never {
  refuse(
    'marker-unreadable',
    `anthropic-auth can't read ${dir}, the state folder that may hold its state, so it won't use either copy.`,
    [dir],
    cause,
  )
}

/**
 * Decide, once at start and before any pool path is resolved, where this
 * process keeps OpenCode's dataset, moving it into the state
 * folder when nothing can still be using the old files. The
 * result is recorded for the process, so every later resolution of the
 * dataset uses it; it never changes.
 *
 * Refuses with `StateLayoutRefusalError` or `HolderRegistrationError` when
 * neither copy may be served safely; the process must then do no pool I/O
 * for the dataset. `RelocatedError` is never thrown here: a dataset moved by
 * a newer version of the same layout rules is served from its new folder.
 */
export async function decideOpenCodeStateLayout(
  options: DecideStateLayoutOptions,
): Promise<StateLayoutDecision> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const fs = options.fs ?? defaultStateLayoutFs()
  const configDir = getOpenCodeConfigDir(env, home)
  const newContext = (): StateLayoutTransitionContext => ({
    fs,
    stack: new StateLayoutLockStack(options.onLockEvent),
    release: anthropicAuthRelease(),
    now: options.now ?? Date.now,
    onStep: options.onStep,
    dataLockTimeoutMs: options.timeouts?.dataMs,
    holderLockTimeoutMs: options.timeouts?.holderMs,
  })

  // 1. A path override pins the dataset beside the named files.
  if (isExplicit(env)) {
    const legacyConfig =
      env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() || join(configDir, ACCOUNT_FILE)
    const legacyState =
      env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim() ||
      (legacyConfig.endsWith(ACCOUNT_FILE)
        ? join(dirname(legacyConfig), ACCOUNT_STATE_FILE)
        : `${legacyConfig}.state.json`)
    const paths = await resolveNativePoolPaths(
      legacyConfig,
      legacyState,
      LEGACY_STATE_LAYOUT,
    )
    const registration = await registerNativePoolHolder({
      paths,
      role: options.role,
      kind: 'explicit',
      policy: unmovedRegistrationPolicy(options),
      onLockEvent: options.onLockEvent,
      liveness: options.liveness,
      lockTimeoutMs: options.timeouts?.holderMs,
    })
    return { kind: 'explicit', layout: LEGACY_STATE_LAYOUT, registration }
  }

  // 2. A config folder that doesn't exist has no identity, and this start
  // never moves it. Registering needs the folder, so it is created (readable
  // by its owner only), which gives it an identity. From there this start
  // goes through the same checks as every other legacy admission, under the
  // folder's holder lock: a move another start committed meanwhile is found
  // and served, never overruled.
  let target = resolveStateHomeTarget({ env, home })
  const neverMove: string[] = []
  if (!target) {
    const reason = 'the config folder did not exist when this process started'
    try {
      await ensureHolderDirectory(configDir)
    } catch (error) {
      if (unmovedRegistrationPolicy(options) === 'mandatory')
        throw new HolderRegistrationError('unavailable', configDir, error)
      // While registration is best-effort the folder is only a place for
      // the holder file, and 2.4.x serves without it: stay legacy and let
      // the background retry register once the folder and a file exist.
      const paths = await resolveNativePoolPaths(
        join(configDir, ACCOUNT_FILE),
        join(configDir, ACCOUNT_STATE_FILE),
        LEGACY_STATE_LAYOUT,
      )
      return chooseLegacy(
        paths,
        [reason],
        true,
        deferLegacyRegistration(paths, configDir, options, error),
      )
    }
    target = resolveStateHomeTarget({ env, home })
    if (!target) throw new HolderRegistrationError('unavailable', configDir)
    neverMove.push(reason)
  }
  const overrides = statePathOverrides(env)
  const stayReasons = [
    ...overrides.map((variable) => `${variable} is set`),
    ...neverMove,
  ]

  // 3. While moving is off, a config folder with no sign of a move stays
  // legacy without looking at the state folder.
  const moveEnabled = relocationMoveEnabled(options)
  if (!moveEnabled) {
    const legacy = await legacyWhileMoveOff(
      configDir,
      target.identity,
      options,
      newContext(),
      stayReasons,
    )
    if (legacy) return legacy
  }

  // From here the state folder may hold the dataset, so a failure to read it
  // refuses, with a fixed message.
  let sub: string
  let dataset: RelocationDataset
  try {
    sub = await canonicalPath(target.dir)
    dataset = await resolveRelocationDataset({
      configDir,
      identity: target.identity,
      stateRoot: target.stateRoot,
      sub,
    })
  } catch (error) {
    stateFolderUnreadable(target.dir, error)
  }

  // 4. The subfolder must belong to this config folder.
  let marker: Awaited<ReturnType<typeof readConfigDirMarker>>
  try {
    marker = await readConfigDirMarker(sub)
  } catch (error) {
    if (error instanceof StateLayoutFileError)
      refuse(
        'marker-unreadable',
        `anthropic-auth can't read ${error.path}, which names the config folder ${sub} belongs to.`,
        [error.path],
        error,
      )
    throw error
  }
  if (marker && marker.identity !== target.identity)
    refuse(
      'other-dataset',
      `${sub} holds anthropic-auth state for ${marker.identity}, not for ${target.identity}. Check OPENCODE_CONFIG_DIR and any symlink to the config folder.`,
      [sub, marker.identity, target.identity],
    )

  // 5. The pointer left in the old folder by a move.
  const pointed = await readPointers(dataset)

  // 6. The marker, read without a lock.
  for (let round = 0; round < 3; round++) {
    const record = await readRecord(sub)
    if (record) requireRecordMatches(record, dataset)
    if (pointed && noMoveRecord(record)) markerUnreadable(sub)
    // Only a rerun of the restore command may finish a restore past its
    // staging boundary. An earlier restore phase is recovered under the
    // layout lock below.
    if (record?.phase === 'restore-staged') restoreUnfinished(dataset.oldDir)
    if (
      record?.phase === 'committed' &&
      (record.cleanup === 'done' || record.cleanup === 'kept')
    ) {
      const admitted = await admitFast(dataset, options, newContext())
      if (admitted !== 'changed') return admitted
      continue
    }
    if (
      (overrides.length || neverMove.length || !moveEnabled) &&
      noMoveRecord(record)
    ) {
      // A process with an override never moves and never writes the marker,
      // a start that found no config folder never moves, and while moving is
      // off no process does: there is nothing to decide under the layout
      // lock. The old holder lock is enough to stay legacy, because a mover
      // holds it from before its fence read to its end, and the checks under
      // it see a move that committed.
      const ctx = newContext()
      // Moving being off is not worth a log line; the other reasons are.
      const reasons = stayReasons.length
        ? stayReasons
        : [RELOCATION_MOVE_DISABLED_REASON]
      try {
        await stateLayoutStep(ctx, 'old-holders-locking')
        try {
          await ctx.stack.acquire({
            name: 'holders',
            path: join(dataset.oldDir, HOLDER_FILE_NAME),
            timeoutMs: ctx.holderLockTimeoutMs,
          })
        } catch (error) {
          if (
            !(error instanceof LockContentionError) ||
            unmovedRegistrationPolicy(options) === 'mandatory'
          )
            throw error
          // While registration is best-effort a start serves, as 2.4.x
          // does, when the holder lock stays taken, provided the files read
          // again still show no move; the background retry registers it.
          if (
            (await readPointers(dataset)) ||
            !noMoveRecord(await readRecord(sub))
          )
            busy(dataset.configDir, error)
          return chooseLegacy(
            dataset.oldPaths,
            reasons,
            stayReasons.length > 0,
            deferLegacyRegistration(
              dataset.oldPaths,
              dataset.oldDir,
              options,
              error,
            ),
          )
        }
        const decided = await legacyHeld(
          dataset,
          options,
          ctx,
          reasons,
          stayReasons.length > 0,
        )
        if (decided !== 'changed') return decided
      } catch (error) {
        if (error instanceof LockContentionError) busy(dataset.configDir, error)
        throw error
      } finally {
        await ctx.stack.releaseAll()
      }
      continue
    }
    break
  }

  // 7. Under the layout lock.
  await ensureSubfolder(sub, fs)
  for (let round = 0; round < 4; round++) {
    const ctx = newContext()
    try {
      try {
        await ctx.stack.acquire({
          name: LAYOUT_LOCK_NAME,
          path: layoutRecordPath(sub),
          timeoutMs: options.timeouts?.layoutMs ?? LAYOUT_LOCK_TIMEOUT_MS,
        })
      } catch (error) {
        if (!(error instanceof LockContentionError)) throw error
        // Another process holds the layout. Only a finished move may be used;
        // anything else could still change under that process.
        const record = await readRecord(sub)
        if (
          record?.phase === 'committed' &&
          (record.cleanup === 'done' || record.cleanup === 'kept')
        ) {
          const admitted = await admitFast(dataset, options, newContext())
          if (admitted !== 'changed') return admitted
        }
        busy(dataset.configDir, error)
      }
      const decided = await underLayoutLock(
        dataset,
        options,
        ctx,
        overrides,
        neverMove,
      )
      if (decided !== 'again') return decided
    } catch (error) {
      if (error instanceof LockContentionError) busy(dataset.configDir, error)
      if (error instanceof StateLayoutRollbackRefused)
        refuse(
          'unsafe',
          `anthropic-auth could not undo an unfinished move of its state for ${dataset.oldDir}, so it won't use either copy: ${error.message}`,
          [error.path],
          error,
        )
      throw error
    } finally {
      await ctx.stack.releaseAll().catch(() => {})
    }
  }
  busy(dataset.configDir)
}

async function ensureSubfolder(sub: string, fs: StateLayoutFs): Promise<void> {
  if (process.platform === 'win32') {
    await ensureWindowsOwnerOnlyDirectory(sub)
    return
  }
  const created = await mkdir(sub, { recursive: true, mode: 0o700 })
  if (created === undefined) return
  // Each new folder's entry must be durable in its parent before anything
  // inside it is: flush every parent from the new subfolder's up to the
  // parent of the highest folder just created.
  for (let dir = dirname(sub); ; dir = dirname(dir)) {
    await fs.syncDirectory(dir)
    if (dir === dirname(created) || dir === dirname(dir)) break
  }
}

/**
 * The decision with the layout lock held: flush and admit a commit, roll back
 * an unfinished move, or decide whether to move now. Returns `again` to start
 * over with a fresh lock set.
 */
async function underLayoutLock(
  dataset: RelocationDataset,
  options: DecideStateLayoutOptions,
  ctx: StateLayoutTransitionContext,
  overrides: readonly string[],
  /** Why this start may not move, besides overrides. */
  neverMove: readonly string[],
): Promise<StateLayoutDecision | 'again'> {
  const record = await readRecord(dataset.sub)
  if (record) requireRecordMatches(record, dataset)
  if (record?.phase === 'restore-staged') restoreUnfinished(dataset.oldDir)
  if (
    record?.phase === 'restoring' ||
    (record?.phase === 'restored' && record.restore?.cleanup !== 'done')
  ) {
    // A restore that stopped before its staging boundary is discarded, so
    // the state folder serves again; one that stopped while removing the
    // state-folder copies has those removed. Either writes the marker, which
    // a process with an override never does.
    if (overrides.length)
      refuse(
        'restore-unfinished',
        `A restore of anthropic-auth's state for ${dataset.oldDir} did not finish; start anthropic-auth without path overrides (${overrides.join(', ')}), or run ${RESTORE_LEGACY_COMMAND} again.`,
        [layoutRecordPath(dataset.sub)],
      )
    await acquireHolderLocks(dataset, ctx)
    if (record.phase === 'restoring')
      await discardAbandonedRestore(record, dataset, ctx)
    else await finishRestoreRetirement(record, dataset, ctx)
    return 'again'
  }
  if (record?.phase === 'committed') {
    // A mover may have died between its commit and its own flush.
    try {
      await syncCommitted(dataset, ctx)
    } catch (error) {
      refuse(
        'unsafe',
        `anthropic-auth could not make the move of its state to ${dataset.sub} durable, so it won't use either copy.`,
        [layoutRecordPath(dataset.sub)],
        error,
      )
    }
    await acquireHolderLocks(dataset, ctx)
    if (
      (record.cleanup === 'pending' || record.cleanup === 'conflict') &&
      !overrides.length
    ) {
      const mark = ctx.stack.size
      try {
        await drainCoalescedWrites(dataset)
        await acquireDataLocks(dataset, ctx)
        await cleanupOldCopies(record, dataset, ctx)
      } catch (error) {
        if (error instanceof StateLayoutCrash) throw error
        // A conflict the cleanup found refuses; only an ordinary failure
        // leaves cleanup for a later start, behind the barriers.
        if (error instanceof StateLayoutRefusalError) throw error
        // The barriers keep the old copies unusable; cleanup is retried later.
        logger.warn(
          'state-layout',
          'anthropic-auth could not finish removing the old copies of its state; it retries at the next start',
          { reason: error instanceof Error ? error.message : String(error) },
        )
      } finally {
        await ctx.stack.releaseTo(mark)
      }
    }
    const admitted = await admitHeld(dataset, options, ctx, false, true)
    return admitted === 'changed' ? 'again' : admitted
  }

  if (record?.phase === 'preparing') {
    if (overrides.length)
      refuse(
        'unsafe',
        `A move of anthropic-auth's state for ${dataset.oldDir} did not finish; start anthropic-auth without path overrides (${overrides.join(', ')}) to finish it.`,
        [layoutRecordPath(dataset.sub)],
      )
    await acquireHolderLocks(dataset, ctx)
    await drainCoalescedWrites(dataset)
    await acquireDataLocks(dataset, ctx)
    await rollbackPreparing(record, dataset, ctx)
    return 'again'
  }

  // No move yet: decide whether to move now.
  const stay = async (
    reasons: string[],
    log = true,
  ): Promise<StateLayoutDecision | 'again'> => {
    const decided = await legacyHeld(dataset, options, ctx, reasons, log)
    return decided === 'changed' ? 'again' : decided
  }
  if (overrides.length || neverMove.length) {
    await acquireHolderLocks(dataset, ctx)
    return stay([
      ...overrides.map((variable) => `${variable} is set`),
      ...neverMove,
    ])
  }
  await acquireHolderLocks(dataset, ctx)
  if (!relocationMoveEnabled(options))
    return stay([RELOCATION_MOVE_DISABLED_REASON], false)
  const holdersMark = ctx.stack.size
  const files = [...dataset.slots.flatMap((slot) => [slot.from, slot.to])]
  const artifacts =
    options.artifacts ??
    defaultPreNArtifactLocations(
      options.env ?? process.env,
      options.home ?? homedir(),
    )
  const checkArtifacts = async () => {
    const found = await preNArtifactBlockers(
      artifacts,
      options.liveness?.pidAlive,
    )
    return found.length ? found.map(describeFenceBlocker).join('; ') : undefined
  }
  const blockers = [
    ...(await holderFenceBlockers({
      directories: [dataset.oldDir, dataset.sub],
      files,
      liveness: options.liveness,
    })),
    ...(await preNArtifactBlockers(artifacts, options.liveness?.pidAlive)),
  ].map(describeFenceBlocker)
  if (!blockers.length) {
    const failure = await movePreconditionFailure(dataset, ctx.fs.platform)
    if (failure) blockers.push(failure)
  }
  await stateLayoutFenceStep(ctx)
  if (blockers.length) return stay(blockers)

  try {
    await drainCoalescedWrites(dataset)
    await acquireDataLocks(dataset, ctx)
  } catch (error) {
    if (error instanceof StateLayoutCrash) throw error
    await ctx.stack.releaseTo(holdersMark)
    const reason = error instanceof Error ? error.message : String(error)
    return stay([reason])
  }
  await ctx.onStep?.('locks-held')
  const failure = await movePreconditionFailure(dataset, ctx.fs.platform)
  if (failure) {
    await ctx.stack.releaseTo(holdersMark)
    return stay([failure])
  }
  let outcome: Awaited<ReturnType<typeof moveDataset>>
  try {
    outcome = await moveDataset(dataset, ctx, checkArtifacts)
  } catch (error) {
    if (
      error instanceof StateLayoutCrash ||
      error instanceof StateLayoutRollbackRefused ||
      error instanceof StateLayoutRefusalError
    )
      throw error
    await ctx.stack.releaseTo(holdersMark)
    // The record on disk says how far the move got: none (stay legacy), a
    // preparing record (rolled back next round) or a commit (admitted next
    // round, after its flush).
    const reason = error instanceof Error ? error.message : String(error)
    logger.error('state-layout', 'anthropic-auth could not move its state', {
      reason,
    })
    if (noMoveRecord(await readRecord(dataset.sub))) return stay([reason])
    return 'again'
  }
  await ctx.stack.releaseTo(holdersMark)
  if (outcome.status === 'rolled-back') {
    // A rollback left to a fresh lock set (a lost lease) is done next round.
    if (!outcome.record) return 'again'
    return stay([outcome.reason])
  }
  const admitted = await admitHeld(dataset, options, ctx, true, true)
  return admitted === 'changed' ? 'again' : admitted
}

async function stateLayoutFenceStep(ctx: StateLayoutTransitionContext) {
  await ctx.onStep?.('fence-checked')
}

/**
 * Decisions made in this process, by everything that selects the dataset.
 * A host may initialise its plugin more than once in one process; each
 * initialisation gets the first decision, so the holder lock beside the
 * watched config folder is taken once per process, not once per plugin.
 */
const processDecisions = new Map<string, Promise<StateLayoutDecision>>()

function decisionKey(options: DecideStateLayoutOptions): string {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  return JSON.stringify([
    getOpenCodeConfigDir(env, home),
    home,
    env.XDG_STATE_HOME ?? null,
    ...STATE_PATH_OVERRIDE_VARIABLES.map((name) => env[name] ?? null),
  ])
}

/**
 * `decideOpenCodeStateLayout`, once per process for each dataset: every
 * later call with the same config folder, state root and overrides gets the
 * same decision. A refusal is not kept, so a later start in the same
 * process (for example after "start again in a minute") decides afresh.
 */
export function decideOpenCodeStateLayoutOnce(
  options: DecideStateLayoutOptions,
): Promise<StateLayoutDecision> {
  const key = decisionKey(options)
  const known = processDecisions.get(key)
  if (known) return known
  const decision = decideOpenCodeStateLayout(options)
  processDecisions.set(key, decision)
  decision.catch(() => {
    if (processDecisions.get(key) === decision) processDecisions.delete(key)
  })
  return decision
}

/** Forget the decisions this process made; tests only. */
export function resetStateLayoutDecisionsForTests(): void {
  processDecisions.clear()
}

/**
 * Pi's part of the decision. Pi never moves: OpenCode doesn't watch its
 * folder, so its dataset stays in the legacy layout. It still registers
 * beside its files before any pool I/O, by `unmovedRegistrationPolicy`, so a
 * move of a dataset it aliases waits for it and an alias into a moved or
 * managed folder refuses.
 */
export async function decidePiStateLayout(options: {
  paths: NativePoolPaths
  role: HolderRole
  onLockEvent?: (event: NativeLockEvent) => void
  liveness?: HolderLiveness
  lockTimeoutMs?: number
  /** Overrides `RELOCATION_MOVE_ENABLED`; tests only. */
  moveEnabled?: boolean
}): Promise<{
  readonly kind: 'pi'
  readonly layout: StateLayout
  readonly registration: NativeHolderRegistration
}> {
  const registration = await registerNativePoolHolder({
    paths: options.paths,
    role: options.role,
    kind: 'pi',
    policy: unmovedRegistrationPolicy(options),
    onLockEvent: options.onLockEvent,
    liveness: options.liveness,
    lockTimeoutMs: options.lockTimeoutMs,
  })
  return { kind: 'pi', layout: LEGACY_STATE_LAYOUT, registration }
}
