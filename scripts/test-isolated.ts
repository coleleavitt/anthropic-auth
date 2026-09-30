#!/usr/bin/env bun
/**
 * Run `bun test` with the operator's real credentials out of reach.
 *
 *   bun scripts/test-isolated.ts [bun test args...]
 *   bun scripts/test-isolated.ts --self-test
 *
 * Test runs used to leak fixture accounts (`yiyi`, `fallback-1`) into the real
 * `~/.anthropic-accounts`, `~/.config/opencode` and `~/.pi`. This runner makes
 * that impossible and makes any attempt fail the run:
 *
 * 1. **Per-run HOME.** `bun test` runs with `HOME`, every `XDG_*` directory,
 *    `CLAUDE_CONFIG_DIR` and `ANTHROPIC_ACCOUNTS_FILE` pointed into a fresh
 *    temp directory. `os.homedir()` in Bun is fixed at process start, so this
 *    has to happen here, before `bun test` starts; a preload cannot do it.
 * 2. **Overlay (Linux, bubblewrap).** The real protected directories are
 *    bind-mounted over with empty per-run directories, so even a hard-coded
 *    real path lands in the sandbox and never reaches the real files.
 * 3. **Audit (Linux, strace).** Every file syscall of the test processes is
 *    logged. Any path under a protected real directory — a stat, an open, a
 *    write — is a violation.
 * 4. **Backstop.** Paths, sizes and mtimes of the protected directories are
 *    snapshotted before and after the run and must match.
 * 5. **No network.** The Rust binding talks to the OAuth token endpoint
 *    itself, so JS fetch mocks do not intercept it: with no token URL set it
 *    would POST fixture refresh tokens to production. Every OAuth URL is set
 *    to a dead loopback address (tests that need a token server start their
 *    own mock), the test process runs in a network namespace with loopback
 *    only (bubblewrap `--unshare-net`), the audit flags every connect() to a
 *    non-loopback address, and the preload fails closed on a non-loopback
 *    binding token URL or a request to an Anthropic/Claude host.
 *
 * Any violation fails the run, even when every test passed. The per-package
 * preload (`test-isolation-preload.ts`) refuses to run tests that were not
 * started through this runner.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const ISOLATION_ENV = 'ANTHROPIC_AUTH_TEST_ISOLATED'
export const REAL_HOME_ENV = 'ANTHROPIC_AUTH_TEST_REAL_HOME'
export const OVERLAY_ENV = 'ANTHROPIC_AUTH_TEST_GUARD_OVERLAY'
export const NETNS_ENV = 'ANTHROPIC_AUTH_TEST_NETNS'
const DEAD_OAUTH_BASE = 'http://127.0.0.1:9'

/**
 * Relative to the real home. `depth` bounds the backstop snapshot; `null`
 * leaves a directory out of it (it is still overlaid and audited).
 */
const PROTECTED: Array<{ rel: string; depth: number | null }> = [
  { rel: '.anthropic-accounts', depth: Number.POSITIVE_INFINITY },
  { rel: '.config/opencode', depth: 2 },
  { rel: '.pi', depth: Number.POSITIVE_INFINITY },
  // Claude Code's own credentials. The directory churns with every Claude
  // Code session, so only the credential file is snapshotted.
  { rel: '.claude', depth: null },
]
const SNAPSHOT_EXTRA_FILES = ['.claude/.credentials.json']

/**
 * The operator's home from the password database, not `$HOME`: correct even
 * when the caller already overrode HOME. Bun's `os.userInfo().homedir`
 * reports `$HOME`, so it cannot be used for this.
 */
export function realHome(): string {
  if (process.env[REAL_HOME_ENV]) return process.env[REAL_HOME_ENV] as string
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const entry = spawnSync('getent', ['passwd', String(process.getuid())], {
      encoding: 'utf8',
    })
    const home = entry.status === 0 ? entry.stdout.split(':')[5]?.trim() : ''
    if (home) return home
  }
  return userInfo().homedir
}

type Snapshot = Map<string, string>

function snapshotInto(
  out: Snapshot,
  path: string,
  depth: number,
  root: boolean,
): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    if (root) out.set(path, 'absent')
    return
  }
  out.set(
    path,
    stat.isDirectory() ? `dir ${stat.mtimeMs}` : `${stat.size} ${stat.mtimeMs}`,
  )
  if (!stat.isDirectory() || depth <= 0) return
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    snapshotInto(out, join(path, entry), depth - 1, false)
  }
}

export function snapshotProtected(home = realHome()): Snapshot {
  const out: Snapshot = new Map()
  for (const { rel, depth } of PROTECTED) {
    if (depth !== null) snapshotInto(out, join(home, rel), depth, true)
  }
  for (const rel of SNAPSHOT_EXTRA_FILES) {
    snapshotInto(out, join(home, rel), 0, true)
  }
  return out
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = []
  for (const [path, value] of before) {
    const next = after.get(path)
    if (next === undefined) changes.push(`removed: ${path}`)
    else if (next !== value)
      changes.push(`changed: ${path} (${value} -> ${next})`)
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changes.push(`created: ${path}`)
  }
  return changes
}

function commandWorks(argv: string[]): boolean {
  const result = spawnSync(argv[0] as string, argv.slice(1), {
    stdio: 'ignore',
    timeout: 10_000,
  })
  return result.status === 0
}

function sandboxEnv(runDir: string, home: string): NodeJS.ProcessEnv {
  const fakeHome = join(runDir, 'home')
  const dirs = {
    HOME: fakeHome,
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    XDG_DATA_HOME: join(fakeHome, '.local', 'share'),
    XDG_STATE_HOME: join(fakeHome, '.local', 'state'),
    XDG_CACHE_HOME: join(fakeHome, '.cache'),
    XDG_RUNTIME_DIR: join(runDir, 'runtime'),
    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, ...dirs }
  // Anything that could steer a store or host file back to a real path.
  for (const key of [
    'ANTHROPIC_ACCOUNTS_DIR',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_ANTHROPIC_AUTH_FILE',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
    'PI_AGENT_DIR',
    'PI_ANTHROPIC_AUTH_FILE',
    'ANTHROPIC_NAPI_PATH_OVERRIDE',
    'GROK_HOME',
  ]) {
    delete env[key]
  }
  env.ANTHROPIC_ACCOUNTS_FILE = join(
    fakeHome,
    '.anthropic-accounts',
    'accounts.json',
  )
  env[ISOLATION_ENV] = runDir
  env[REAL_HOME_ENV] = home
  // Dead loopback endpoints: a refresh nobody mocked fails with a connect
  // error instead of reaching platform.claude.com.
  env.ANTHROPIC_OAUTH_TOKEN_URL = `${DEAD_OAUTH_BASE}/v1/oauth/token`
  env.ANTHROPIC_OAUTH_AUTHORIZE_URL = `${DEAD_OAUTH_BASE}/oauth/authorize`
  env.ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL = `${DEAD_OAUTH_BASE}/oauth/authorize`
  env.ANTHROPIC_AUTH_TEST_MODE = '1'
  // Bun keeps its install cache under HOME; point it back at the real one so
  // a test run never re-downloads packages (read-only use, outside the
  // protected set).
  env.BUN_INSTALL_CACHE_DIR ??= join(home, '.bun', 'install', 'cache')
  return env
}

/** A connect() to anything but loopback (or a local socket). */
function nonLoopbackConnect(line: string): boolean {
  if (!/\bconnect\(/.test(line)) return false
  const v4 = /sin_addr=inet_addr\("([^"]+)"\)/.exec(line)?.[1]
  if (v4) return !v4.startsWith('127.') && v4 !== '0.0.0.0'
  const v6 = /inet_pton\(AF_INET6, "([^"]+)"/.exec(line)?.[1]
  if (v6) {
    return !(v6 === '::1' || v6 === '::' || v6.startsWith('::ffff:127.'))
  }
  return false
}

function auditViolations(auditLog: string, home: string): string[] {
  if (!existsSync(auditLog)) return []
  const prefixes = PROTECTED.map(({ rel }) => `"${join(home, rel)}`)
  const lines = readFileSync(auditLog, 'utf8').split('\n')
  // bubblewrap itself stats and mounts over the protected paths while it
  // builds the sandbox; that happens before it execs `bun`. Everything after
  // the first successful exec of the test runtime is the code under test.
  const bunExec = lines.findIndex(
    (line) => /execve\("[^"]*\/bun"/.test(line) && !line.includes('= -1'),
  )
  const found = new Set<string>()
  for (const line of lines.slice(Math.max(bunExec, 0))) {
    if (nonLoopbackConnect(line)) {
      found.add(`network: ${line.replace(/^\d+\s+/, '').trim()}`)
      continue
    }
    if (!prefixes.some((prefix) => line.includes(prefix))) continue
    if (/\b(u?mount2?|pivot_root)\(/.test(line)) continue
    found.add(line.replace(/^\d+\s+/, '').trim())
  }
  return [...found]
}

function guardLogViolations(runDir: string): string[] {
  const path = join(runDir, 'network-violations.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('    at '))
    .map((line) => `network guard: ${line.trim()}`)
}

function overlayViolations(guardRoot: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      found.push(path)
      if (lstatSync(path).isDirectory()) walk(path)
    }
  }
  if (existsSync(guardRoot)) {
    for (const entry of readdirSync(guardRoot)) walk(join(guardRoot, entry))
  }
  return found
}

export type IsolatedRunResult = {
  exitCode: number
  testExitCode: number
  violations: string[]
  overlay: boolean
  netns: boolean
  audited: boolean
}

export function runIsolated(
  bunTestArgs: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): IsolatedRunResult {
  const home = realHome()
  const runDir = mkdtempSync(join(tmpdir(), 'anthropic-auth-test-run-'))
  const env = sandboxEnv(runDir, home)
  const guardRoot = join(runDir, 'guard')
  const auditLog = join(runDir, 'audit.log')

  const useOverlay =
    process.platform === 'linux' &&
    process.env.ANTHROPIC_AUTH_TEST_NO_OVERLAY !== '1' &&
    commandWorks(['bwrap', '--dev-bind', '/', '/', '--', 'true'])
  const useNetns =
    useOverlay &&
    commandWorks([
      'bwrap',
      '--dev-bind',
      '/',
      '/',
      '--unshare-net',
      '--',
      'true',
    ])
  const useAudit =
    process.platform === 'linux' &&
    process.env.ANTHROPIC_AUTH_TEST_NO_AUDIT !== '1' &&
    commandWorks(['strace', '-qq', '-e', 'trace=none', '--', 'true'])

  let argv = [process.execPath, 'test', ...bunTestArgs]
  if (useOverlay) {
    const binds: string[] = []
    for (const { rel } of PROTECTED) {
      const target = join(home, rel)
      // A missing directory cannot be a mount point without creating it in
      // the real home; the audit and the snapshot still cover it.
      if (!existsSync(target)) continue
      const overlay = join(guardRoot, rel.replaceAll('/', '__'))
      mkdirSync(overlay, { recursive: true })
      binds.push('--bind', overlay, target)
    }
    env[OVERLAY_ENV] = '1'
    if (useNetns) env[NETNS_ENV] = '1'
    argv = [
      'bwrap',
      '--dev-bind',
      '/',
      '/',
      ...(useNetns ? ['--unshare-net'] : []),
      ...binds,
      '--',
      ...argv,
    ]
  }
  if (useAudit) {
    argv = [
      'strace',
      '-f',
      '-qq',
      '-e',
      'trace=%file,connect',
      '-e',
      'signal=none',
      '-o',
      auditLog,
      '--',
      ...argv,
    ]
  }

  const before = snapshotProtected(home)
  const result = spawnSync(argv[0] as string, argv.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: 'inherit',
  })
  const after = snapshotProtected(home)

  const violations = [
    ...auditViolations(auditLog, home).map((line) => `audit: ${line}`),
    ...overlayViolations(guardRoot).map(
      (path) => `wrote into a protected directory (sandboxed copy): ${path}`,
    ),
    ...guardLogViolations(runDir),
    ...diffSnapshots(before, after).map((change) => `snapshot: ${change}`),
  ]
  const testExitCode = result.status ?? 1
  if (!options.quiet) {
    const mode = [
      useOverlay ? 'overlay' : 'no overlay (bwrap unavailable)',
      useNetns ? 'no network' : 'network NOT isolated',
      useAudit ? 'audit' : 'no audit (strace unavailable)',
    ].join(', ')
    console.error(`[test-isolated] HOME=${env.HOME} (${mode})`)
    if (violations.length) {
      console.error(
        `[test-isolated] FAIL: the run touched the real ${PROTECTED.map(({ rel }) => `~/${rel}`).join(', ')} or the network:`,
      )
      for (const violation of violations.slice(0, 50)) {
        console.error(`  ${violation}`)
      }
      if (violations.length > 50) {
        console.error(`  ... ${violations.length - 50} more`)
      }
    }
  }
  if (!violations.length) rmSync(runDir, { recursive: true, force: true })
  return {
    exitCode: violations.length ? 1 : testExitCode,
    testExitCode,
    violations,
    overlay: useOverlay,
    netns: useNetns,
    audited: useAudit,
  }
}

/**
 * Prove the guard: run a probe test that reaches for the real protected
 * paths and require that the runner flags it and that nothing real changed.
 */
function selfTest(): number {
  const home = realHome()
  const probe = resolve(dirname(import.meta.path), 'guard-probe')
  const before = snapshotProtected(home)
  const result = runIsolated(['guard-probe.test.ts'], {
    cwd: probe,
    quiet: true,
  })
  const after = snapshotProtected(home)
  const unchanged = diffSnapshots(before, after)
  const caughtAudit = result.violations.some(
    (violation) =>
      violation.startsWith('audit:') &&
      violation.includes('.anthropic-accounts'),
  )
  const caughtWrite = result.violations.some((violation) =>
    violation.includes('guard-probe-write.json'),
  )
  const caughtGuard = result.violations.some((violation) =>
    violation.startsWith('network guard:'),
  )
  const caughtConnect = result.violations.some(
    (violation) =>
      violation.startsWith('audit: network:') &&
      violation.includes('192.0.2.1'),
  )
  const checks: Array<[string, boolean]> = [
    ['in-process guard flagged the Anthropic-host request', caughtGuard],
    [
      'audit flagged the non-loopback connect',
      !result.audited || caughtConnect,
    ],
    ['probe tests themselves ran and passed', result.testExitCode === 0],
    ['runner failed the run', result.exitCode !== 0],
    ['audit flagged the real-path access', !result.audited || caughtAudit],
    ['overlay caught the write', !result.overlay || caughtWrite],
    ['real HOME snapshot unchanged', unchanged.length === 0],
  ]
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  }
  if (unchanged.length)
    for (const change of unchanged) console.log(`  ${change}`)
  const passed = checks.every(([, ok]) => ok)
  console.log(`guard self-test: ${passed ? 'PASS' : 'FAIL'}`)
  return passed ? 0 : 1
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--self-test') {
    process.exit(selfTest())
  }
  if (process.env[ISOLATION_ENV]) {
    // Already inside an isolated run (a test that shells out to the runner):
    // the environment is already the sandbox.
    const nested = spawnSync(process.execPath, ['test', ...args], {
      stdio: 'inherit',
    })
    process.exit(nested.status ?? 1)
  }
  process.exit(runIsolated(args).exitCode)
}
