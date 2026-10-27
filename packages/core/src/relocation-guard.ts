import { lstat } from 'node:fs/promises'

import { logger } from './logger.ts'
import { nativeVaultPaths } from './native-vault-paths.ts'
import { type NativePoolPaths, stateLayoutOfPaths } from './pool-paths.ts'
import {
  createStateHomeServingGuard,
  stateHomeServingFiles,
} from './state-home-serving-guard.ts'
import {
  LEGACY_STATE_LAYOUT,
  type RelocationPointer,
  readRelocationPointer,
} from './state-layout-paths.ts'

/**
 * Fixed text of the refusal a process gives once a newer version has moved
 * the state files it uses. It names no path, because hosts show it on screen
 * and in their own logs; the log line written with it names the folders.
 */
export const RELOCATED_MESSAGE =
  'Anthropic account state was moved to a new folder by a newer anthropic-auth version. Update anthropic-auth in every OpenCode and Pi that uses this folder, then restart them.'

/**
 * A runtime file this process uses has been replaced by a relocation
 * tombstone: a newer version moved the dataset elsewhere, and this version
 * can't follow it. Every later use of the old files is refused, so this
 * process never writes beside state it no longer owns.
 */
export class RelocatedError extends Error {
  readonly code = 'relocated'
  /** The old runtime path that holds the tombstone. */
  readonly runtimePath: string
  /** Where the tombstone says the state went. */
  readonly relocatedTo: string

  constructor(runtimePath: string, pointer: RelocationPointer) {
    super(RELOCATED_MESSAGE)
    this.name = 'RelocatedError'
    this.runtimePath = runtimePath
    this.relocatedTo = pointer.relocatedTo
  }
}

/**
 * Checks whether a dataset has been moved, by looking for a relocation
 * tombstone over its legacy runtime files. It takes no lock: callers run it
 * inside a callback that already holds the lock a mover must hold to install
 * the tombstone, so the check sees either no move or the tombstone.
 */
export interface RelocationGuard {
  /** Throws `RelocatedError` when either runtime file is a tombstone. */
  assertNotRelocated(): Promise<void>
  /** True when either runtime file is a tombstone; never throws for it. */
  isRelocated(): Promise<boolean>
}

/**
 * The largest file read as a possible tombstone. A tombstone holds three
 * paths and two short strings, so a bigger file is an ordinary runtime and
 * is never read here; that keeps the per-request cost to an `lstat`.
 */
const TOMBSTONE_MAX_BYTES = 16 * 1024
/** Paths whose last observation is kept; a process uses only a few. */
const MAX_OBSERVED_PATHS = 256

interface Observation {
  /** `dev`, `ino`, `size`, `mtime` and `ctime` when the file was last read. */
  readonly identity: string
  readonly pointer: RelocationPointer | undefined
}

/**
 * The last observation of each runtime path, shared by every guard in the
 * process. A file whose identity hasn't changed is not read again, so a
 * guard costs one `lstat` per file while nothing moves.
 */
const observations = new Map<string, Observation>()
/** Paths whose tombstone has already been logged, so it is logged once. */
const reported = new Set<string>()

async function pointerAt(path: string): Promise<RelocationPointer | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path, { bigint: true })
  } catch {
    // An absent or unreadable runtime is not a tombstone. Its own reader
    // decides what to do with it, exactly as before this check existed.
    observations.delete(path)
    return undefined
  }
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  const last = observations.get(path)
  if (last?.identity === identity) return last.pointer
  let pointer: RelocationPointer | undefined
  if (info.isFile() && info.size <= BigInt(TOMBSTONE_MAX_BYTES)) {
    try {
      pointer = await readRelocationPointer(path)
    } catch {
      pointer = undefined
    }
  }
  observations.delete(path)
  if (observations.size >= MAX_OBSERVED_PATHS) {
    const oldest = observations.keys().next().value
    if (oldest !== undefined) observations.delete(oldest)
  }
  observations.set(path, { identity, pointer })
  return pointer
}

/** The first tombstone among `runtimePaths`, with the path that holds it. */
/**
 * Forget every runtime file observation, so the next check reads each file
 * again. A move calls it after replacing files in this process.
 */
export function forgetRelocationObservations(): void {
  observations.clear()
}

export async function findRelocationTombstone(
  runtimePaths: readonly string[],
): Promise<{ path: string; pointer: RelocationPointer } | undefined> {
  for (const path of runtimePaths) {
    const pointer = await pointerAt(path)
    if (pointer) return { path, pointer }
  }
  return undefined
}

function reportRelocation(path: string, pointer: RelocationPointer) {
  if (reported.has(path)) return
  reported.add(path)
  logger.error(
    'state-layout',
    'anthropic-auth state was moved by a newer version; this process refuses to use the old files',
    { runtimePath: path, relocatedTo: pointer.relocatedTo, by: pointer.by },
  )
}

/** A guard over the given legacy runtime files. */
export function createRelocationGuard(
  runtimePaths: readonly string[],
): RelocationGuard {
  const paths = [...runtimePaths]
  return {
    async assertNotRelocated() {
      const found = await findRelocationTombstone(paths)
      if (!found) return
      reportRelocation(found.path, found.pointer)
      throw new RelocatedError(found.path, found.pointer)
    },
    async isRelocated() {
      const found = await findRelocationTombstone(paths)
      if (found) reportRelocation(found.path, found.pointer)
      return found !== undefined
    },
  }
}

/**
 * The legacy runtime files of a dataset: its local runtime and its vault
 * runtime. A move replaces both with tombstones before it commits.
 */
export function nativeRelocationRuntimePaths(
  paths: NativePoolPaths,
): [string, string] {
  return [paths.runtime, nativeVaultPaths(paths, LEGACY_STATE_LAYOUT).runtime]
}

/**
 * The guard for a dataset's locked write callbacks. In the legacy layout it
 * refuses once a newer version has moved the dataset (a tombstone over either
 * legacy runtime file). In the state-home layout the tombstones are expected,
 * and the same callbacks instead refuse once the dataset is in conflict: an
 * old copy of the credentials or journal is back beside the moved one.
 */
export function nativeRelocationGuard(paths: NativePoolPaths): RelocationGuard {
  if (stateLayoutOfPaths(paths).kind === 'state-home')
    return createStateHomeServingGuard(stateHomeServingFiles(paths))
  return createRelocationGuard(nativeRelocationRuntimePaths(paths))
}
