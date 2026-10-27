import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { type NativePoolPaths, stateLayoutOfPaths } from './pool-paths.ts'
import {
  type StateLayout,
  stateHomeDatasetFiles,
} from './state-layout-paths.ts'

/** Vault files have no migration journal: enrollment alone authorizes their use. */
export interface NativeVaultPaths {
  config: string
  state: string
  runtime: string
  roster: string
  routing: string
  storageId: string
  legacySeedConfig: string
}

function sibling(path: string, expected: string, name: string, suffix: string) {
  return basename(path) === expected
    ? join(dirname(path), name)
    : path.replace(/(?:\.json)?$/, `.${suffix}.json`)
}

/**
 * Keep vault settings, metadata and affinity outside every local recovery file.
 *
 * `layout` must be the one `local` was resolved in. It defaults to the layout
 * `local` itself shows (see `stateLayoutOfPaths`). Vault settings stay beside
 * the account file in every layout, and the storage id is always computed
 * from the vault store state's legacy-layout path.
 */
export function nativeVaultPaths(
  local: NativePoolPaths,
  layout: StateLayout = stateLayoutOfPaths(local),
): NativeVaultPaths {
  const config = sibling(
    local.legacyConfig,
    'anthropic-auth.json',
    'anthropic-auth-vault-settings.json',
    'vault-settings',
  )
  const legacyLayoutState = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-store-state.json',
    'vault-store',
  )
  let state = legacyLayoutState
  let runtime = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-state.json',
    'vault-native',
  )
  let roster = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-roster.json',
    'vault-roster',
  )
  let routing = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-routing-state.json',
    'vault-routing',
  )
  if (layout.kind === 'state-home') {
    const moved = stateHomeDatasetFiles(
      layout,
      local.legacyConfig,
      local.legacyState,
    )
    state = moved.vaultStoreState
    runtime = moved.vaultRuntime
    roster = moved.vaultRoster
    routing = moved.vaultRouting
  }
  const destinations = [config, state, runtime, roster, routing]
  const localFiles = [
    local.legacyConfig,
    local.legacyState,
    local.config,
    local.state,
    local.runtime,
    local.journal,
    local.roster,
  ]
  if (
    new Set([...localFiles, ...destinations]).size !==
    localFiles.length + destinations.length
  )
    throw new Error('Vault storage overlaps local account storage')
  return {
    legacySeedConfig: local.legacyConfig,
    config,
    state,
    runtime,
    roster,
    routing,
    storageId: createHash('sha256')
      .update(JSON.stringify(['anthropic-vault', config, legacyLayoutState]))
      .digest('hex'),
  }
}
