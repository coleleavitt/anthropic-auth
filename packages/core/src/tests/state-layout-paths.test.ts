import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

import { nativeVaultPaths } from '../native-vault-paths.ts'
import { canonicalPath, resolveNativePoolPaths } from '../pool-paths.ts'
import {
  anthropicAuthStateRoot,
  configFolderIdentity,
  homeDefaultConfigDir,
  LEGACY_STATE_LAYOUT,
  processStateLayout,
  readConfigDirMarker,
  readRelocationPointer,
  readStateLayoutMarker,
  resolveStateHomeTarget,
  StateLayoutFileError,
  stateHomeFilePaths,
  stateSubfolderName,
} from '../state-layout-paths.ts'

const roots: string[] = []
const ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-state-layout-'))
  roots.push(root)
  return realpath(root)
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

// Today's id formulas, written out so a change to either resolver can't
// change the expected value with it.
function todayLocalId(config: string, state: string) {
  return createHash('sha256')
    .update(JSON.stringify(['anthropic', config, state]))
    .digest('hex')
}
function todayVaultId(config: string, state: string) {
  return createHash('sha256')
    .update(JSON.stringify(['anthropic-vault', config, state]))
    .digest('hex')
}

const POOL_PATH_KEYS = [
  'legacyConfig',
  'legacyState',
  'config',
  'state',
  'runtime',
  'journal',
  'roster',
  'storageId',
]

interface Expected {
  legacyConfig: string
  legacyState: string
  config: string
  state: string
  runtime: string
  journal: string
  roster: string
  vault: {
    config: string
    state: string
    runtime: string
    roster: string
    routing: string
  }
}

async function expectTodayPaths(
  resolve: () => ReturnType<typeof resolveNativePoolPaths>,
  expected: Expected,
) {
  const { vault, ...local } = expected
  const byDefault = await resolve()
  expect(byDefault).toEqual({
    ...local,
    storageId: todayLocalId(local.config, local.state),
  })
  expect(Object.keys(byDefault).sort()).toEqual([...POOL_PATH_KEYS].sort())
  expect(nativeVaultPaths(byDefault)).toEqual({
    legacySeedConfig: local.legacyConfig,
    ...vault,
    storageId: todayVaultId(vault.config, vault.state),
  })
  expect(nativeVaultPaths(byDefault, LEGACY_STATE_LAYOUT)).toEqual(
    nativeVaultPaths(byDefault),
  )
}

function defaultNames(dir: string, stateDir = dir): Expected {
  return {
    legacyConfig: join(dir, 'anthropic-auth.json'),
    legacyState: join(stateDir, 'anthropic-auth-state.json'),
    config: join(dir, 'anthropic-auth-pool.json'),
    state: join(stateDir, 'anthropic-auth-pool-state.json'),
    runtime: join(stateDir, 'anthropic-auth-native-state.json'),
    journal: join(stateDir, 'anthropic-auth-migration.json'),
    roster: join(stateDir, 'anthropic-auth-custody-roster.json'),
    vault: {
      config: join(dir, 'anthropic-auth-vault-settings.json'),
      state: join(stateDir, 'anthropic-auth-vault-store-state.json'),
      runtime: join(stateDir, 'anthropic-auth-vault-state.json'),
      roster: join(stateDir, 'anthropic-auth-vault-roster.json'),
      routing: join(stateDir, 'anthropic-auth-vault-routing-state.json'),
    },
  }
}

test('the default layout is the legacy layout', () => {
  expect(processStateLayout()).toEqual({ kind: 'legacy' })
  expect(processStateLayout()).toBe(LEGACY_STATE_LAYOUT)
})

test('default environment resolves today’s paths in the home config folder', async () => {
  setEnv({ XDG_STATE_HOME: '/unused/state' })
  const dir = await canonicalPath(join(homedir(), '.config', 'opencode'))
  await expectTodayPaths(() => resolveNativePoolPaths(), defaultNames(dir))
  expect(
    await resolveNativePoolPaths(undefined, undefined, LEGACY_STATE_LAYOUT),
  ).toEqual(await resolveNativePoolPaths())
})

test('OPENCODE_CONFIG_DIR resolves today’s paths in that folder', async () => {
  const root = await fixture()
  setEnv({ OPENCODE_CONFIG_DIR: ` ${join(root, 'oc')} ` })
  await expectTodayPaths(
    () => resolveNativePoolPaths(),
    defaultNames(join(root, 'oc')),
  )
})

test('XDG_CONFIG_HOME resolves today’s paths, and XDG_STATE_HOME changes none', async () => {
  const root = await fixture()
  setEnv({
    XDG_CONFIG_HOME: join(root, 'xdg'),
    XDG_STATE_HOME: join(root, 'state'),
  })
  await expectTodayPaths(
    () => resolveNativePoolPaths(),
    defaultNames(join(root, 'xdg', 'opencode')),
  )
})

test('OPENCODE_ANTHROPIC_AUTH_FILE with a custom name keeps today’s sibling names', async () => {
  const root = await fixture()
  setEnv({ OPENCODE_ANTHROPIC_AUTH_FILE: join(root, 'custom', 'project.json') })
  const base = join(root, 'custom', 'project.json')
  const state = `${base}.state.json`
  await expectTodayPaths(() => resolveNativePoolPaths(), {
    legacyConfig: base,
    legacyState: state,
    config: `${base}.pool.json`,
    state: `${state}.pool.json`,
    runtime: `${state}.native.json`,
    journal: `${state}.migration.json`,
    roster: `${state}.roster.json`,
    vault: {
      config: join(root, 'custom', 'project.vault-settings.json'),
      state: `${state.slice(0, -'.json'.length)}.vault-store.json`,
      runtime: `${state.slice(0, -'.json'.length)}.vault-native.json`,
      roster: `${state.slice(0, -'.json'.length)}.vault-roster.json`,
      routing: `${state.slice(0, -'.json'.length)}.vault-routing.json`,
    },
  })
})

test('OPENCODE_ANTHROPIC_AUTH_STATE_FILE keeps every state-derived file beside it', async () => {
  const root = await fixture()
  setEnv({
    OPENCODE_CONFIG_DIR: join(root, 'oc'),
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(
      root,
      'secrets',
      'anthropic-auth-state.json',
    ),
  })
  await expectTodayPaths(
    () => resolveNativePoolPaths(),
    defaultNames(join(root, 'oc'), join(root, 'secrets')),
  )

  const custom = join(root, 'secrets', 'token.json')
  setEnv({
    OPENCODE_CONFIG_DIR: join(root, 'oc'),
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: custom,
  })
  await expectTodayPaths(() => resolveNativePoolPaths(), {
    ...defaultNames(join(root, 'oc')),
    legacyState: custom,
    state: `${custom}.pool.json`,
    runtime: `${custom}.native.json`,
    journal: `${custom}.migration.json`,
    roster: `${custom}.roster.json`,
    vault: {
      config: join(root, 'oc', 'anthropic-auth-vault-settings.json'),
      state: join(root, 'secrets', 'token.vault-store.json'),
      runtime: join(root, 'secrets', 'token.vault-native.json'),
      roster: join(root, 'secrets', 'token.vault-roster.json'),
      routing: join(root, 'secrets', 'token.vault-routing.json'),
    },
  })
})

test('a Pi storage path resolves today’s paths beside it', async () => {
  const root = await fixture()
  setEnv({ OPENCODE_CONFIG_DIR: join(root, 'oc') })
  const pi = join(root, 'pi-agent')
  await expectTodayPaths(
    () => resolveNativePoolPaths(join(pi, 'anthropic-auth.json')),
    defaultNames(pi),
  )
})

test('a symlinked config folder resolves to the canonical folder with today’s id', async () => {
  const root = await fixture()
  await mkdir(join(root, 'real'))
  await symlink(join(root, 'real'), join(root, 'link'), 'dir')
  setEnv({ OPENCODE_CONFIG_DIR: join(root, 'link') })
  await expectTodayPaths(
    () => resolveNativePoolPaths(),
    defaultNames(join(root, 'real')),
  )
})

test('the state-home layout moves only state files and keeps both storage ids', async () => {
  const root = await fixture()
  const config = join(root, 'oc')
  const dir = join(root, 'state', 'cortexkit', 'anthropic-auth', 'opencode-x')
  const layout = { kind: 'state-home', dir } as const
  for (const configDir of [config, join(root, 'oc-link')]) {
    if (configDir !== config) {
      await mkdir(config, { recursive: true })
      await symlink(config, configDir, 'dir')
    }
    const legacy = await resolveNativePoolPaths(
      join(configDir, 'anthropic-auth.json'),
      join(configDir, 'anthropic-auth-state.json'),
      LEGACY_STATE_LAYOUT,
    )
    const moved = await resolveNativePoolPaths(
      join(configDir, 'anthropic-auth.json'),
      join(configDir, 'anthropic-auth-state.json'),
      layout,
    )
    const today = defaultNames(config)
    expect(moved).toEqual({
      legacyConfig: today.legacyConfig,
      legacyState: today.legacyState,
      config: today.config,
      state: join(dir, 'anthropic-auth-pool-state.json'),
      runtime: join(dir, 'anthropic-auth-native-state.json'),
      journal: join(dir, 'anthropic-auth-migration.json'),
      roster: join(dir, 'anthropic-auth-custody-roster.json'),
      storageId: todayLocalId(today.config, today.state),
    })
    expect(moved.storageId).toBe(legacy.storageId)
    expect(Object.keys(moved).sort()).toEqual([...POOL_PATH_KEYS].sort())

    const legacyVault = nativeVaultPaths(legacy, LEGACY_STATE_LAYOUT)
    expect(nativeVaultPaths(moved, layout)).toEqual({
      legacySeedConfig: today.legacyConfig,
      config: today.vault.config,
      state: join(dir, 'anthropic-auth-vault-store-state.json'),
      runtime: join(dir, 'anthropic-auth-vault-state.json'),
      roster: join(dir, 'anthropic-auth-vault-roster.json'),
      routing: join(dir, 'anthropic-auth-vault-routing-state.json'),
      storageId: todayVaultId(today.vault.config, today.vault.state),
    })
    expect(nativeVaultPaths(moved, layout).storageId).toBe(
      legacyVault.storageId,
    )
  }
  // Resolving touches nothing on disk.
  expect((await readdir(root)).sort()).toEqual(['oc', 'oc-link'])
})

test('the state-home layout refuses explicit datasets and relative folders', async () => {
  const root = await fixture()
  const layout = { kind: 'state-home', dir: join(root, 'sub') } as const
  for (const [config, state] of [
    [join(root, 'project.json'), join(root, 'project.json.state.json')],
    [join(root, 'anthropic-auth.json'), join(root, 'secrets', 'token.json')],
    [
      join(root, 'anthropic-auth.json'),
      join(root, 'secrets', 'anthropic-auth-state.json'),
    ],
  ] as const) {
    await expect(resolveNativePoolPaths(config, state, layout)).rejects.toThrow(
      'default account files',
    )
    const legacy = await resolveNativePoolPaths(config, state)
    expect(() => nativeVaultPaths(legacy, layout)).toThrow(
      'default account files',
    )
  }
  await expect(
    resolveNativePoolPaths(
      join(root, 'anthropic-auth.json'),
      join(root, 'anthropic-auth-state.json'),
      { kind: 'state-home', dir: 'relative/sub' },
    ),
  ).rejects.toThrow('absolute path')
})

test('state root follows an absolute XDG_STATE_HOME and ignores a relative or empty one', () => {
  const home = '/home/me'
  const fallback = '/home/me/.local/state/cortexkit/anthropic-auth'
  expect(
    anthropicAuthStateRoot({ xdgStateHome: '/x/state', home }, posix),
  ).toBe('/x/state/cortexkit/anthropic-auth')
  expect(anthropicAuthStateRoot({ xdgStateHome: 'rel', home }, posix)).toBe(
    fallback,
  )
  expect(anthropicAuthStateRoot({ xdgStateHome: '', home }, posix)).toBe(
    fallback,
  )
  expect(anthropicAuthStateRoot({ xdgStateHome: undefined, home }, posix)).toBe(
    fallback,
  )
  // Enrollment and RPC have always used a relative value as given.
  expect(
    anthropicAuthStateRoot(
      { xdgStateHome: 'rel', home, acceptRelative: true },
      posix,
    ),
  ).toBe('rel/cortexkit/anthropic-auth')
  expect(
    anthropicAuthStateRoot(
      { xdgStateHome: '', home, acceptRelative: true },
      posix,
    ),
  ).toBe(fallback)
})

test('state root and state-home files on Windows paths', () => {
  const home = 'C:\\Users\\me'
  const root = anthropicAuthStateRoot({ xdgStateHome: undefined, home }, win32)
  expect(root).toBe('C:\\Users\\me\\.local\\state\\cortexkit\\anthropic-auth')
  expect(
    anthropicAuthStateRoot({ xdgStateHome: 'D:\\state', home }, win32),
  ).toBe('D:\\state\\cortexkit\\anthropic-auth')
  expect(anthropicAuthStateRoot({ xdgStateHome: 'state', home }, win32)).toBe(
    root,
  )
  expect(homeDefaultConfigDir(home, win32)).toBe(
    'C:\\Users\\me\\.config\\opencode',
  )
  const dir = win32.join(root, 'opencode')
  expect(stateHomeFilePaths(dir, win32)).toEqual({
    localPoolState: `${dir}\\anthropic-auth-pool-state.json`,
    localRuntime: `${dir}\\anthropic-auth-native-state.json`,
    journal: `${dir}\\anthropic-auth-migration.json`,
    localRoster: `${dir}\\anthropic-auth-custody-roster.json`,
    vaultStoreState: `${dir}\\anthropic-auth-vault-store-state.json`,
    vaultRuntime: `${dir}\\anthropic-auth-vault-state.json`,
    vaultRoster: `${dir}\\anthropic-auth-vault-roster.json`,
    vaultRouting: `${dir}\\anthropic-auth-vault-routing-state.json`,
    requestGzip: `${dir}\\anthropic-auth-request-gzip.json`,
    configDirMarker: `${dir}\\config-dir.json`,
    layoutMarker: `${dir}\\layout.json`,
  })
})

test('state-home files on POSIX paths', () => {
  const dir = '/home/me/.local/state/cortexkit/anthropic-auth/opencode'
  const paths = stateHomeFilePaths(dir, posix)
  expect(paths.localPoolState).toBe(`${dir}/anthropic-auth-pool-state.json`)
  expect(paths.vaultRouting).toBe(
    `${dir}/anthropic-auth-vault-routing-state.json`,
  )
  expect(paths.requestGzip).toBe(`${dir}/anthropic-auth-request-gzip.json`)
  expect(paths.configDirMarker).toBe(`${dir}/config-dir.json`)
  expect(paths.layoutMarker).toBe(`${dir}/layout.json`)
})

test('config identity is realpathSync.native with case kept, and absent folders have none', async () => {
  const root = await fixture()
  const real = join(root, 'MixedCase', 'OpenCode')
  await mkdir(real, { recursive: true })
  await symlink(real, join(root, 'alias'), 'dir')
  expect(configFolderIdentity(real)).toBe(real)
  expect(configFolderIdentity(join(root, 'alias'))).toBe(real)
  expect(configFolderIdentity(join(root, 'missing'))).toBeUndefined()
  await writeFile(join(root, 'file'), '')
  expect(configFolderIdentity(join(root, 'file', 'opencode'))).toBeUndefined()
})

test('only the home default config folder gets the opencode subfolder', async () => {
  const root = await fixture()
  const home = join(root, 'home')
  const homeDefault = join(home, '.config', 'opencode')
  const elsewhere = join(root, 'xdg', 'opencode')
  await mkdir(homeDefault, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  await symlink(homeDefault, join(root, 'linked-default'), 'dir')
  const hashed = (identity: string) =>
    `opencode-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
  const stateRoot = join(home, '.local', 'state', 'cortexkit', 'anthropic-auth')

  expect(resolveStateHomeTarget({ env: {}, home })).toEqual({
    identity: homeDefault,
    stateRoot,
    dir: join(stateRoot, 'opencode'),
  })
  // The home default reached through XDG_CONFIG_HOME or a symlink is the same
  // folder, so it keeps the plain name.
  expect(
    resolveStateHomeTarget({
      env: { XDG_CONFIG_HOME: join(home, '.config') },
      home,
    })?.dir,
  ).toBe(join(stateRoot, 'opencode'))
  expect(
    resolveStateHomeTarget({
      env: { OPENCODE_CONFIG_DIR: join(root, 'linked-default') },
      home,
    })?.dir,
  ).toBe(join(stateRoot, 'opencode'))
  // Any other folder is hashed, even when XDG_CONFIG_HOME names it.
  expect(
    resolveStateHomeTarget({
      env: { XDG_CONFIG_HOME: join(root, 'xdg') },
      home,
    }),
  ).toEqual({
    identity: elsewhere,
    stateRoot,
    dir: join(stateRoot, hashed(elsewhere)),
  })
  expect(stateSubfolderName(elsewhere, homeDefault)).toMatch(
    /^opencode-[0-9a-f]{16}$/,
  )
  expect(stateSubfolderName(homeDefault, undefined)).toBe(hashed(homeDefault))
  // XDG_STATE_HOME moves the root only when absolute.
  expect(
    resolveStateHomeTarget({
      env: { XDG_STATE_HOME: join(root, 'state') },
      home,
    })?.dir,
  ).toBe(join(root, 'state', 'cortexkit', 'anthropic-auth', 'opencode'))
  expect(
    resolveStateHomeTarget({ env: { XDG_STATE_HOME: 'state' }, home })
      ?.stateRoot,
  ).toBe(stateRoot)
  // A config folder that doesn't exist has no identity and no target.
  expect(
    resolveStateHomeTarget({
      env: { OPENCODE_CONFIG_DIR: join(root, 'missing') },
      home,
    }),
  ).toBeUndefined()
})

test('config-dir.json reader', async () => {
  const dir = await fixture()
  expect(await readConfigDirMarker(dir)).toBeUndefined()
  expect(await readConfigDirMarker(join(dir, 'missing'))).toBeUndefined()
  await writeFile(
    join(dir, 'config-dir.json'),
    JSON.stringify({ version: 1, identity: '/home/me/.config/opencode' }),
  )
  expect(await readConfigDirMarker(dir)).toEqual({
    version: 1,
    identity: '/home/me/.config/opencode',
  })
  for (const content of [
    '{',
    '[]',
    JSON.stringify({ version: 2, identity: '/x' }),
    JSON.stringify({ version: 1, identity: '' }),
  ]) {
    await writeFile(join(dir, 'config-dir.json'), content)
    const error = await readConfigDirMarker(dir).catch((caught) => caught)
    expect(error).toBeInstanceOf(StateLayoutFileError)
    expect(error).toMatchObject({ code: 'invalid' })
  }
})

test('layout.json reader accepts known phases and refuses everything else', async () => {
  const dir = await fixture()
  expect(await readStateLayoutMarker(dir)).toBeUndefined()
  const base = {
    version: 1,
    attempt: 'a1',
    identity: '/home/me/.config/opencode',
    stateRoot: '/home/me/.local/state/cortexkit/anthropic-auth',
    sub: '/home/me/.local/state/cortexkit/anthropic-auth/opencode',
    oldDir: '/home/me/.config/opencode',
    storageIds: { local: 'l', vault: 'v' },
    by: '2.4.0',
    files: [],
  }
  const write = (value: unknown) =>
    writeFile(join(dir, 'layout.json'), JSON.stringify(value))
  await write({ ...base, phase: 'committed', cleanup: 'pending' })
  expect(await readStateLayoutMarker(dir)).toEqual({
    version: 1,
    phase: 'committed',
    attempt: 'a1',
    identity: base.identity,
    stateRoot: base.stateRoot,
    sub: base.sub,
    oldDir: base.oldDir,
    storageIds: { local: 'l', vault: 'v' },
    cleanup: 'pending',
  })
  await write({ ...base, phase: 'preparing' })
  expect((await readStateLayoutMarker(dir))?.phase).toBe('preparing')
  await write({ ...base, phase: 'restored', restore: { cleanup: 'done' } })
  expect((await readStateLayoutMarker(dir))?.restore).toEqual({
    cleanup: 'done',
  })

  for (const invalid of [
    { ...base, phase: 'committed' },
    { ...base, phase: 'committed', cleanup: 'later' },
    { ...base, phase: 'moved' },
    { ...base, phase: 'restored' },
    { ...base, phase: 'restored', restore: { cleanup: 'kept' } },
    { ...base, phase: 'preparing', version: 2 },
    { ...base, phase: 'preparing', storageIds: { local: 'l' } },
    { ...base, phase: 'preparing', oldDir: '' },
  ]) {
    await write(invalid)
    await expect(readStateLayoutMarker(dir)).rejects.toMatchObject({
      name: 'StateLayoutFileError',
      code: 'invalid',
    })
  }
  await writeFile(join(dir, 'layout.json'), 'not json')
  await expect(readStateLayoutMarker(dir)).rejects.toMatchObject({
    code: 'invalid',
  })
  await rm(join(dir, 'layout.json'))
  await mkdir(join(dir, 'layout.json'))
  await expect(readStateLayoutMarker(dir)).rejects.toMatchObject({
    code: 'invalid',
  })
})

test('layout.json that cannot be read is refused, never treated as absent', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  const dir = await fixture()
  await writeFile(join(dir, 'layout.json'), '{}')
  await chmod(join(dir, 'layout.json'), 0o000)
  await expect(readStateLayoutMarker(dir)).rejects.toMatchObject({
    code: 'unreadable',
  })
})

test('relocation tombstone reader names the pointer and ignores ordinary runtimes', async () => {
  const dir = await fixture()
  const path = join(dir, 'anthropic-auth-native-state.json')
  expect(await readRelocationPointer(path)).toBeUndefined()
  const pointer = {
    relocatedTo: '/home/me/.local/state/cortexkit/anthropic-auth/opencode',
    stateRoot: '/home/me/.local/state/cortexkit/anthropic-auth',
    identity: '/home/me/.config/opencode',
    attempt: 'a1',
    by: '2.4.0',
  }
  await writeFile(path, JSON.stringify({ version: 0, ...pointer }))
  expect(await readRelocationPointer(path)).toEqual(pointer)
  for (const content of [
    JSON.stringify({ version: 1, storageId: 'x', accounts: {} }),
    JSON.stringify({ version: 0, ...pointer, relocatedTo: '' }),
    '{ not json',
    'x'.repeat(70 * 1024),
  ]) {
    await writeFile(path, content)
    expect(await readRelocationPointer(path)).toBeUndefined()
  }
})
