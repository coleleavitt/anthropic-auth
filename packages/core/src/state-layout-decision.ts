import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LockContentionError } from '@cortexkit/common-auth/fs'

import { getOpenCodeConfigDir } from './accounts.ts'
import {
  anthropicAuthRelease,
  buildHolderEntry,
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
} from './state-home-serving-guard.ts'
import {
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
  LAYOUT_LOCK_NAME,
  LAYOUT_LOCK_TIMEOUT_MS,
  moveDataset,
  movePreconditionFailure,
  type RelocationDataset,
  reappearedMetadataFiles,
  resolveRelocationDataset,
  rollbackPreparing,
  StateLayoutCrash,
  StateLayoutRollbackRefused,
  type StateLayoutStep,
  type StateLayoutTransitionContext,
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

const ACCOUNT_FILE = 'anthropic-auth.json'
const ACCOUNT_STATE_FILE = 'anthropic-auth-state.json'

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
    `A restore of anthropic-auth's state for ${configDir} did not finish; run \`anthropic-auth layout restore-legacy\` again.`,
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
    // Registration is mandatory from this release on: without the entry a
    // later move or restore can't see this process, so it must not serve.
    throw error instanceof HolderRegistrationError
      ? error
      : new HolderRegistrationError('unavailable', dirname(holderFile), error)
  }
}

/** Warn once per process about old metadata files back in the config folder. */
const warnedReappeared = new Set<string>()

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
  for (const path of await reappearedMetadataFiles(record)) {
    if (warnedReappeared.has(path)) continue
    warnedReappeared.add(path)
    logger.warn(
      'state-layout',
      `anthropic-auth found ${path} in the config folder after moving its state to ${dataset.sub}. It holds no credentials and is not used; delete it when convenient.`,
      { path },
    )
  }
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
 * Read both relocation tombstones in the old folder. Refuses when one belongs
 * to another config folder or names another state root; true when one
 * points at this dataset's state-home folder.
 */
async function readPointers(dataset: RelocationDataset): Promise<boolean> {
  let pointed = false
  for (const runtime of [dataset.oldPaths.runtime, dataset.oldVault.runtime]) {
    const pointer = await readRelocationPointer(runtime)
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
): Promise<StateLayoutDecision | 'changed'> {
  const pointed = await readPointers(dataset)
  const record = await readRecord(dataset.sub)
  if (record) requireRecordMatches(record, dataset)
  if (pointed && noMoveRecord(record)) markerUnreadable(dataset.sub)
  if (pointed || !noMoveRecord(record)) return 'changed'
  await registerHeld(
    join(dataset.oldDir, HOLDER_FILE_NAME),
    dataset.oldPaths,
    'legacy',
    dataset.identity,
    options,
    ctx,
  )
  recordProcessStateLayout(dataset.oldPaths.legacyConfig, LEGACY_STATE_LAYOUT)
  if (reasons.length)
    logger.info(
      'state-layout',
      'anthropic-auth keeps its runtime files in OpenCode’s config folder until every running OpenCode or Pi using them has restarted on this version',
      { reasons },
    )
  return { kind: 'legacy', layout: LEGACY_STATE_LAYOUT, reasons }
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
      onLockEvent: options.onLockEvent,
      liveness: options.liveness,
      lockTimeoutMs: options.timeouts?.holderMs,
    })
    return { kind: 'explicit', layout: LEGACY_STATE_LAYOUT, registration }
  }

  // 2. A config folder that doesn't exist has no identity and never moves.
  const target = resolveStateHomeTarget({ env, home })
  if (!target) {
    const paths = await resolveNativePoolPaths(
      join(configDir, ACCOUNT_FILE),
      join(configDir, ACCOUNT_STATE_FILE),
      LEGACY_STATE_LAYOUT,
    )
    const registration = await registerNativePoolHolder({
      paths,
      role: options.role,
      kind: 'legacy',
      onLockEvent: options.onLockEvent,
      liveness: options.liveness,
      lockTimeoutMs: options.timeouts?.holderMs,
    })
    return {
      kind: 'legacy',
      layout: LEGACY_STATE_LAYOUT,
      reasons: ['the config folder does not exist'],
      registration,
    }
  }

  const sub = await canonicalPath(target.dir)
  const dataset = await resolveRelocationDataset({
    configDir,
    identity: target.identity,
    stateRoot: target.stateRoot,
    sub,
  })
  const overrides = statePathOverrides(env)

  // 3. The subfolder must belong to this config folder.
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

  // 4. The pointer left in the old folder by a move.
  const pointed = await readPointers(dataset)

  // 5. The marker, read without a lock.
  for (let round = 0; round < 3; round++) {
    const record = await readRecord(sub)
    if (record) requireRecordMatches(record, dataset)
    if (pointed && noMoveRecord(record)) markerUnreadable(sub)
    if (
      record?.phase === 'restoring' ||
      record?.phase === 'restore-staged' ||
      (record?.phase === 'restored' && record.restore?.cleanup !== 'done')
    )
      restoreUnfinished(dataset.oldDir)
    if (
      record?.phase === 'committed' &&
      (record.cleanup === 'done' || record.cleanup === 'kept')
    ) {
      const admitted = await admitFast(dataset, options, newContext())
      if (admitted !== 'changed') return admitted
      continue
    }
    if (overrides.length && noMoveRecord(record)) {
      // A process with an override never moves and never writes the marker.
      const ctx = newContext()
      try {
        await ctx.stack.acquire({
          name: 'holders',
          path: join(dataset.oldDir, HOLDER_FILE_NAME),
          timeoutMs: ctx.holderLockTimeoutMs,
        })
        const blockers = overrides.map((variable) => `${variable} is set`)
        const decided = await legacyHeld(dataset, options, ctx, blockers)
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

  // 6. Under the layout lock.
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
      const decided = await underLayoutLock(dataset, options, ctx, overrides)
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
): Promise<StateLayoutDecision | 'again'> {
  const record = await readRecord(dataset.sub)
  if (record) requireRecordMatches(record, dataset)
  if (
    record?.phase === 'restoring' ||
    record?.phase === 'restore-staged' ||
    (record?.phase === 'restored' && record.restore?.cleanup !== 'done')
  )
    restoreUnfinished(dataset.oldDir)

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
  ): Promise<StateLayoutDecision | 'again'> => {
    const decided = await legacyHeld(dataset, options, ctx, reasons)
    return decided === 'changed' ? 'again' : decided
  }
  if (overrides.length) {
    await acquireHolderLocks(dataset, ctx)
    return stay(overrides.map((variable) => `${variable} is set`))
  }
  await acquireHolderLocks(dataset, ctx)
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
