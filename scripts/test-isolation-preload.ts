/**
 * Bun test preload (see each package's `bunfig.toml`).
 *
 * 1. Refuse to run unless `scripts/test-isolated.ts` started this process
 *    with a per-run HOME. Bun fixes `os.homedir()` at process start and does
 *    not let a preload replace `node:fs`, so isolation cannot be retrofitted
 *    from in here; the runner sets it up (and overlays, audits and snapshots
 *    the real protected directories, and cuts the network off).
 * 2. Keep every OAuth endpoint on a dead loopback address, fail closed on any
 *    Rust binding handle whose token URL is not loopback, and block any
 *    request from this process to an Anthropic/Claude host. JS fetch mocks do
 *    not intercept the Rust binding, so an unset token URL would otherwise
 *    send fixture refresh tokens to the production endpoint.
 *
 * Violations throw at the call site and are also appended to
 * `<run dir>/network-violations.log`, which the runner turns into a failed
 * run even when the throwing call was caught and swallowed.
 */
import { afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const runDir = process.env.ANTHROPIC_AUTH_TEST_ISOLATED

/** Password-database home; Bun's `os.userInfo().homedir` just echoes $HOME. */
function passwdHome(): string | undefined {
  if (typeof process.getuid !== 'function') return undefined
  const entry = spawnSync('getent', ['passwd', String(process.getuid())], {
    encoding: 'utf8',
  })
  return entry.status === 0 ? entry.stdout.split(':')[5]?.trim() : undefined
}

const realHomes = [
  process.env.ANTHROPIC_AUTH_TEST_REAL_HOME,
  passwdHome(),
].filter((home): home is string => Boolean(home))

function refuse(reason: string): never {
  console.error(
    `[test-isolation] refusing to run tests: ${reason}.\n` +
      '  Run them through the isolation runner, e.g. `bun run test` in the package,\n' +
      '  or `bun ../../scripts/test-isolated.ts <bun test args>`.',
  )
  process.exit(1)
}

if (!runDir) refuse('HOME is not isolated')
for (const realHome of realHomes) {
  if (resolve(homedir()) === resolve(realHome)) {
    refuse(`os.homedir() is the real home (${realHome})`)
  }
}
if (!resolve(homedir()).startsWith(resolve(runDir))) {
  refuse(`os.homedir() (${homedir()}) is outside the run directory`)
}

// ---------------------------------------------------------------------------
// Network guard
// ---------------------------------------------------------------------------

/** A closed loopback port: a stray refresh fails with a connect error. */
export const DEAD_OAUTH_BASE = 'http://127.0.0.1:9'
const DEAD_OAUTH_URLS: Record<string, string> = {
  ANTHROPIC_OAUTH_TOKEN_URL: `${DEAD_OAUTH_BASE}/v1/oauth/token`,
  ANTHROPIC_OAUTH_AUTHORIZE_URL: `${DEAD_OAUTH_BASE}/oauth/authorize`,
  ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL: `${DEAD_OAUTH_BASE}/oauth/authorize`,
  ANTHROPIC_OAUTH_REVOKE_URL: `${DEAD_OAUTH_BASE}/v1/oauth/token/revoke`,
  ANTHROPIC_OAUTH_PROFILE_URL: `${DEAD_OAUTH_BASE}/api/oauth/profile`,
}
for (const [key, value] of Object.entries(DEAD_OAUTH_URLS)) {
  process.env[key] ||= value
}
process.env.ANTHROPIC_AUTH_TEST_MODE = '1'
// Bun's process.env writes never reach the addon's getenv; the binding's
// loader forwards a snapshot of these keys to Rust at construction.
process.env.ANTHROPIC_OAUTH_TEST_MODE = '1'

const FORBIDDEN_HOSTS = [
  'platform.claude.com',
  'console.anthropic.com',
  'api.anthropic.com',
  'claude.ai',
  'anthropic.com',
  'claude.com',
]

function hostOf(target: unknown): string | undefined {
  try {
    if (target instanceof URL) return target.hostname
    if (typeof target === 'string') return new URL(target).hostname
    if (target && typeof target === 'object') {
      const record = target as {
        url?: unknown
        hostname?: unknown
        host?: unknown
      }
      if (typeof record.url === 'string') return new URL(record.url).hostname
      if (typeof record.hostname === 'string') return record.hostname
      if (typeof record.host === 'string') return record.host.split(':')[0]
    }
  } catch {}
  return undefined
}

function isForbiddenHost(host: string | undefined): boolean {
  if (!host) return false
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return FORBIDDEN_HOSTS.some(
    (forbidden) =>
      normalized === forbidden || normalized.endsWith(`.${forbidden}`),
  )
}

function isLoopbackUrl(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const { hostname } = new URL(value)
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    )
  } catch {
    return false
  }
}

let expectedViolations = 0

export class TestNetworkGuardError extends Error {
  constructor(message: string) {
    super(`[test network guard] ${message}`)
    this.name = 'TestNetworkGuardError'
  }
}

function violation(message: string): TestNetworkGuardError {
  const error = new TestNetworkGuardError(message)
  if (expectedViolations === 0 && runDir) {
    try {
      appendFileSync(
        join(runDir, 'network-violations.log'),
        `${message}\n${error.stack?.split('\n').slice(1, 6).join('\n') ?? ''}\n`,
      )
    } catch {}
  }
  return error
}

/**
 * Run `fn` expecting it to trip the guard (for the guard's own tests): the
 * error is still thrown, but the run is not failed for it.
 */
async function withExpectedGuardViolation<T>(fn: () => Promise<T> | T) {
  expectedViolations += 1
  try {
    return await fn()
  } finally {
    expectedViolations -= 1
  }
}

;(globalThis as Record<string, unknown>).__anthropicAuthTestGuard = {
  withExpectedGuardViolation,
  TestNetworkGuardError,
  DEAD_OAUTH_BASE,
}

// fetch / WebSocket: globals, so the wrappers see every caller (a test that
// installs its own mock replaces them and restores them afterwards).
const realFetch = globalThis.fetch
const guardedFetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = hostOf(input)
    if (isForbiddenHost(host)) {
      return Promise.reject(violation(`fetch to ${host} blocked during tests`))
    }
    return realFetch(input, init)
  },
  realFetch,
) as typeof fetch
globalThis.fetch = guardedFetch

const RealWebSocket = globalThis.WebSocket
if (RealWebSocket) {
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const host = hostOf(url)
      if (isForbiddenHost(host)) {
        throw violation(`WebSocket to ${host} blocked during tests`)
      }
      super(url, protocols)
    }
  } as typeof WebSocket
}

// node:http(s)/net/tls: patch the shared module objects (covers default and
// namespace imports and require; Bun does not let a preload replace named
// ESM bindings, which the runner's network namespace covers instead).
const requireHere = createRequire(import.meta.url)
for (const [moduleName, methods] of [
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:tls', ['connect']],
] as const) {
  const target = requireHere(moduleName) as Record<string, unknown>
  for (const method of methods) {
    const original = target[method]
    if (typeof original !== 'function') continue
    target[method] = function (this: unknown, ...args: unknown[]) {
      const host = hostOf(args[0]) ?? hostOf(args[1])
      if (isForbiddenHost(host)) {
        throw violation(
          `${moduleName}.${method} to ${host} blocked during tests`,
        )
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
}

// The Rust binding: every handle must use a loopback token endpoint, and the
// package's default-handle convenience functions (production endpoints) are
// unavailable. Every installed copy of the package is patched.
type NapiModule = Record<string, unknown> & {
  AnthropicAuth: new (config?: Record<string, unknown> | null) => object
}
const repoRoot = resolve(import.meta.dir, '..')
const bindingPaths = new Set<string>()
for (const base of [
  process.cwd(),
  join(repoRoot, 'packages', 'core'),
  join(repoRoot, 'packages', 'opencode'),
  join(repoRoot, 'packages', 'pi'),
]) {
  try {
    bindingPaths.add(
      requireHere.resolve('@coleleavitt/anthropic-napi', { paths: [base] }),
    )
  } catch {}
}
for (const path of bindingPaths) {
  const napi = requireHere(path) as NapiModule
  const Original = napi.AnthropicAuth
  class GuardedAnthropicAuth extends Original {
    constructor(config?: Record<string, unknown> | null) {
      const tokenUrl =
        typeof config?.tokenUrl === 'string' ? config.tokenUrl : undefined
      if (!isLoopbackUrl(tokenUrl)) {
        throw violation(
          `AnthropicAuth constructed with a non-loopback token URL (${tokenUrl ?? 'production default'})`,
        )
      }
      super(config)
      if ((this as { testMode?: unknown }).testMode !== true) {
        throw violation(
          'AnthropicAuth constructed without the binding test mode (ANTHROPIC_OAUTH_TEST_MODE)',
        )
      }
    }
  }
  napi.AnthropicAuth = GuardedAnthropicAuth
  for (const name of Object.keys(napi)) {
    if (
      typeof napi[name] === 'function' &&
      name !== 'AnthropicAuth' &&
      name !== 'AnthropicAuthError'
    ) {
      napi[name] = () => {
        throw violation(
          `@coleleavitt/anthropic-napi ${name}() uses the production default handle`,
        )
      }
    }
  }
}

// Bun crashes at exit (segfault/abort) when a Node-API async call into the
// binding is still outstanding (a keep-alive pass or quota poll a test left
// running). Let those settle before the runner exits.
afterAll(async () => {
  const settle = (globalThis as Record<string, unknown>)
    .__anthropicAuthSettleStoreCalls as (() => Promise<void>) | undefined
  await settle?.()
})
