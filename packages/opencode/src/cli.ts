#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  type AccountStorage,
  type ApiKeyAccount,
  addAccountPersistent,
  authorize,
  discoverNativeClaudeCredentials,
  exchange,
  fallbackAccountToShared,
  fetchOAuthAccountIdentity,
  generateRelayToken,
  getAccountStoragePath,
  importNativeClaudeAccount,
  isOAuthAccount,
  isValidApiBaseURL,
  loadAccounts,
  loadSharedAccountStore,
  type OAuthAccount,
  removeAccountPersistent,
  revokeClaudeOAuthToken,
  saveAccounts,
  saveTrustedDeviceToken,
  setSharedAccountEnabled,
  startOAuthLoopbackSession,
  TrustedDeviceToken,
  upsertSharedAccount,
  WORKER_SCRIPT,
} from '@cortexkit/anthropic-auth-core'

function defaultStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 240,
    },
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: {
        five_hour: 10,
        seven_day: 20,
      },
      failClosedOnUnknownQuota: true,
    },
    accounts: [],
  }
}

function usage() {
  console.log(`Usage:
  opencode-anthropic-auth login [label]
  opencode-anthropic-auth api add [label]
  opencode-anthropic-auth import-native [label]
  opencode-anthropic-auth revoke <account-id>
  opencode-anthropic-auth list
  opencode-anthropic-auth relay setup

OAuth fallback credentials are stored in the shared Anthropic account store.
Custom API routes and plugin route settings are stored in:
  ${getAccountStoragePath()}`)
}

function requireText(value: string | undefined, name: string) {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

async function cloudflareRequest<T>(options: {
  token: string
  method: string
  path: string
  body?: RequestInit['body']
  headers?: Record<string, string>
  fetchImpl?: FetchLike
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4${options.path}`,
    {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(options.body instanceof FormData
          ? {}
          : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body,
    },
  )
  const text = await response.text()
  let data: {
    success?: boolean
    result?: T
    errors?: Array<{ message?: string }>
  }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Cloudflare API returned ${response.status}: ${text}`)
  }
  if (!response.ok || data.success === false) {
    const message = data.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join('; ')
    throw new Error(message || `Cloudflare API returned ${response.status}`)
  }
  return data.result as T
}

async function createKvNamespace(
  token: string,
  accountId: string,
  title: string,
  fetchImpl?: FetchLike,
) {
  return cloudflareRequest<{ id: string }>({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/storage/kv/namespaces`,
    body: JSON.stringify({ title }),
    fetchImpl,
  })
}

async function uploadRelayWorker(options: {
  token: string
  accountId: string
  scriptName: string
  kvNamespaceId: string
  relayToken: string
  fetchImpl?: FetchLike
}) {
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-04-28',
    bindings: [
      {
        type: 'kv_namespace',
        name: 'RELAY_STATE',
        namespace_id: options.kvNamespaceId,
      },
      {
        type: 'secret_text',
        name: 'RELAY_TOKEN',
        text: options.relayToken,
      },
    ],
  }
  const form = new FormData()
  form.set('metadata', JSON.stringify(metadata))
  form.set(
    'worker.js',
    new Blob([WORKER_SCRIPT], { type: 'application/javascript+module' }),
    'worker.js',
  )
  return cloudflareRequest<unknown>({
    token: options.token,
    method: 'PUT',
    path: `/accounts/${options.accountId}/workers/scripts/${options.scriptName}`,
    body: form,
    fetchImpl: options.fetchImpl,
  })
}

async function enableWorkersDev(
  token: string,
  accountId: string,
  scriptName: string,
  fetchImpl?: FetchLike,
) {
  await cloudflareRequest<unknown>({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
    fetchImpl,
  })
}

async function getWorkersSubdomain(
  token: string,
  accountId: string,
  fetchImpl?: FetchLike,
) {
  return cloudflareRequest<{ subdomain?: string }>({
    token,
    method: 'GET',
    path: `/accounts/${accountId}/workers/subdomain`,
    fetchImpl,
  }).catch(() => null)
}

/**
 * Minimal fetch shape relaySetup needs. Narrower than `typeof fetch` (no
 * `preconnect`) so test stubs and the global `fetch` are both assignable
 * without a cast. The global `fetch` satisfies this structurally.
 */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Dependencies relaySetup talks to the outside world through. Both default to
 * the real implementations (global fetch, the readline-backed prompt) so the
 * production `relay setup` path is unchanged; tests inject deterministic stubs
 * to exercise the full setup logic in-process without a subprocess.
 */
export interface RelaySetupDeps {
  fetchImpl?: FetchLike
  prompt?: (message: string) => Promise<string>
}

export async function relaySetup(deps: RelaySetupDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const ask = deps.prompt ?? prompt
  const token = requireText(
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
      (await ask('Cloudflare API token: ')),
    'Cloudflare API token',
  )
  const accountId = requireText(
    process.env.CLOUDFLARE_ACCOUNT_ID || (await ask('Cloudflare account ID: ')),
    'Cloudflare account ID',
  )
  const scriptName =
    (await ask('Worker name [opencode-anthropic-relay]: ')) ||
    'opencode-anthropic-relay'
  const kvTitle = `${scriptName}-state`
  const relayToken = generateRelayToken()

  console.log('Creating Cloudflare KV namespace...')
  const namespace = await createKvNamespace(
    token,
    accountId,
    kvTitle,
    fetchImpl,
  )
  console.log('Uploading relay Worker...')
  await uploadRelayWorker({
    token,
    accountId,
    scriptName,
    kvNamespaceId: namespace.id,
    relayToken,
    fetchImpl,
  })
  await enableWorkersDev(token, accountId, scriptName, fetchImpl).catch(
    (error) => {
      console.warn(
        `Could not enable workers.dev automatically: ${error instanceof Error ? error.message : String(error)}`,
      )
    },
  )

  const subdomain = await getWorkersSubdomain(token, accountId, fetchImpl)
  const defaultUrl = subdomain?.subdomain
    ? `https://${scriptName}.${subdomain.subdomain}.workers.dev`
    : ''
  const url =
    defaultUrl ||
    requireText(await prompt('Relay Worker URL: '), 'Relay Worker URL')

  // Provisioning can take minutes. Reload immediately before commit so the
  // relay setup cannot overwrite fallback accounts changed while it was open.
  const storage = (await loadAccounts()) ?? defaultStorage()
  storage.relay = {
    enabled: true,
    url,
    token: relayToken,
    fallbackToDirect: true,
    transport: 'http',
  }
  await saveAccounts(storage)

  console.log(`Relay enabled at ${url}`)
  console.log(`Config saved to ${getAccountStoragePath()}.`)
}

let promptInterface: ReturnType<typeof createInterface> | null = null

async function prompt(message: string) {
  promptInterface ??= createInterface({ input, output })
  return (await promptInterface.question(message)).trim()
}

function closePromptInterface() {
  promptInterface?.close()
  promptInterface = null
}

/**
 * Dependencies the `login` command talks to the outside world through. All
 * default to the real implementations (the readline-backed prompt, and the
 * core authorize/exchange helpers) so the production `login` path is
 * unchanged; tests inject deterministic stubs to exercise the full login flow
 * in-process without a subprocess, real network, or stdin.
 */
export interface LoginDeps {
  prompt?: (message: string) => Promise<string>
  authorize?: typeof authorize
  exchange?: typeof exchange
  startLoopback?: typeof startOAuthLoopbackSession
}

export async function login(labelArg?: string, deps: LoginDeps = {}) {
  const ask = deps.prompt ?? prompt
  const authorizeImpl = deps.authorize ?? authorize
  const exchangeImpl = deps.exchange ?? exchange
  // No label prompt: the token grant reports the signed-in account's email, so
  // asking the user to retype it only invites a mismatch between the label and
  // the account they actually authenticated as.
  const label = labelArg?.trim()
  const startLoopback = deps.startLoopback ?? startOAuthLoopbackSession
  let loopback: Awaited<ReturnType<typeof startOAuthLoopbackSession>> | null =
    null
  let authorization: Awaited<ReturnType<typeof authorize>>
  try {
    loopback = await startLoopback()
    authorization = await authorizeImpl('max', {
      redirectUri: loopback.redirectUri,
      state: loopback.state,
    })
  } catch {
    loopback = null
    authorization = await authorizeImpl('max')
    console.warn(
      'Could not start the localhost OAuth callback; using manual paste-back.',
    )
  }

  console.log('\nOpen this URL in your browser and complete Claude sign-in:\n')
  console.log(`${authorization.url}\n`)
  const manualCode = ask(
    'Paste the full callback URL or authorization code here: ',
  )
  let code: string
  if (loopback) {
    try {
      const completed = await Promise.race([
        loopback.waitForCallback().then((callback) => ({
          type: 'loopback' as const,
          code: `${callback.code}#${callback.state}`,
        })),
        manualCode.then((value) => ({ type: 'manual' as const, code: value })),
      ])
      code = completed.code
      if (completed.type === 'manual') loopback.cancel()
      else if (!deps.prompt) closePromptInterface()
    } finally {
      await loopback.close().catch(() => {})
    }
  } else {
    code = await manualCode
  }
  const result = await exchangeImpl(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )

  if (result.type === 'failed') {
    throw new Error('Authentication failed')
  }

  // Ask Anthropic who just signed in rather than inferring it. The grant only
  // carries `account.email_address` when it happens to include it, while the
  // profile endpoint always does — so this is what lets `login` name itself
  // with no argument, and lets a re-login land on the row it supersedes.
  const identity = await fetchOAuthAccountIdentity({
    accessToken: result.access,
  })

  // A credential that cannot run inference is useless for routing, and the
  // failure would otherwise surface much later as an opaque 403.
  if (result.scopes?.length && !result.scopes.includes('user:inference')) {
    throw new Error(
      `Authentication succeeded but the granted scopes do not include user:inference (got: ${result.scopes.join(' ')})`,
    )
  }

  const now = Date.now()
  const sharedStoreForNaming = await loadSharedAccountStore()
  const organizationUuid = result.organizationId ?? identity.organizationUuid

  // Prefer the profile email, then the grant's: both are stable across
  // re-logins, so signing in again updates the existing account instead of
  // stacking a second copy under a fresh random id.
  //
  // An email is not unique on its own, though — one person can hold a grant in
  // several organizations, and those are separate routable credentials. If the
  // plain email is already taken by a *different* organization, qualify this
  // one so the two coexist instead of overwriting each other.
  const preferredId = label || identity.email || result.email
  const collidesWithOtherOrg =
    !label &&
    Boolean(preferredId) &&
    sharedStoreForNaming.store.accounts.some(
      (candidate) =>
        candidate.id === preferredId &&
        candidate.credential.type === 'oauth' &&
        candidate.credential.organization?.uuid !== organizationUuid,
    )
  const organizationSuffix =
    identity.organizationName ?? organizationUuid?.slice(0, 8)
  const derivedId =
    collidesWithOtherOrg && organizationSuffix
      ? `${preferredId} (${organizationSuffix})`
      : preferredId

  const account: OAuthAccount = {
    id: derivedId || crypto.randomUUID(),
    label: derivedId || undefined,
    type: 'oauth',
    authLineageId: crypto.randomUUID(),
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    refreshExpires: result.refreshTokenExpiresAt,
    enabled: true,
    addedAt: now,
    lastUsed: now,
    lastRefreshedAt: now,
  }
  const sharedStore = sharedStoreForNaming
  const existingSharedAccount = sharedStore.store.accounts.find(
    (candidate) => candidate.id === account.id,
  )
  const sharedAccount = fallbackAccountToShared(account, existingSharedAccount)
  if (sharedAccount.credential.type === 'oauth') {
    if (identity.email ?? result.email) {
      sharedAccount.email = identity.email ?? result.email
    }
    if (result.scopes) sharedAccount.credential.scopes = result.scopes
    const accountUuid = result.accountId ?? identity.accountUuid
    if (accountUuid) {
      const email = identity.email ?? result.email
      sharedAccount.credential.account = {
        uuid: accountUuid,
        ...(email ? { email_address: email } : {}),
      }
    }
    if (organizationUuid) {
      sharedAccount.credential.organization = { uuid: organizationUuid }
    }
  }
  await upsertSharedAccount(sharedAccount)
  await addAccountPersistent(account)

  console.log(`\nSaved fallback account${derivedId ? ` "${derivedId}"` : ''}.`)
}

/**
 * Dependencies the `api add` command talks to the outside world through. The
 * prompt defaults to the real readline-backed prompt so the production
 * `api add` path is unchanged; tests inject canned answers to exercise the
 * full route-add flow in-process without a subprocess or stdin.
 */
export interface ApiAddDeps {
  prompt?: (message: string) => Promise<string>
}

export async function addApiRoute(labelArg?: string, deps: ApiAddDeps = {}) {
  const ask = deps.prompt ?? prompt
  const label =
    labelArg?.trim() || (await ask('API fallback label (optional): '))
  const baseURL =
    process.env.OPENCODE_ANTHROPIC_AUTH_API_BASE_URL?.trim() ||
    (
      await ask('Anthropic-compatible base URL [https://api.kie.ai/claude]: ')
    ).trim() ||
    'https://api.kie.ai/claude'
  if (!isValidApiBaseURL(baseURL)) {
    throw new Error(
      'API fallback base URL must be an http(s) URL without embedded credentials',
    )
  }
  const apiKey =
    process.env.OPENCODE_ANTHROPIC_AUTH_API_KEY?.trim() ||
    (await ask('API key: '))
  if (!apiKey.trim()) throw new Error('API key is required')
  const authHeaderInput = (
    process.env.OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER?.trim() ||
    (await ask(
      'Auth header [authorization-bearer|x-api-key] (default authorization-bearer): ',
    ))
  )
    .trim()
    .toLowerCase()
  const authHeader =
    authHeaderInput === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'
  const now = Date.now()
  const account: ApiKeyAccount = {
    id: label || crypto.randomUUID(),
    label: label || undefined,
    type: 'api',
    apiKey: apiKey.trim(),
    baseURL,
    authHeader,
    enabled: true,
    addedAt: now,
    lastUsed: now,
  }

  await addAccountPersistent(account)

  console.log(
    `\nSaved API fallback route${label ? ` "${label}"` : ''} (${baseURL}).`,
  )
}

export async function importNative(
  labelArg?: string,
  deps: { prompt?: (message: string) => Promise<string> } = {},
) {
  const ask = deps.prompt ?? prompt
  const discovered = await discoverNativeClaudeCredentials()
  if (!discovered) throw new Error('No native Claude OAuth credentials found')
  const source =
    discovered.source.type === 'keychain'
      ? `secure storage (${discovered.source.service})`
      : discovered.source.path
  const confirmation = await ask(
    `Import native Claude OAuth from ${source} into the project-neutral account store? Type IMPORT to continue: `,
  )
  if (confirmation !== 'IMPORT')
    throw new Error('Native credential import cancelled')

  const imported = await importNativeClaudeAccount({
    label: labelArg?.trim() || 'Native Claude',
  })
  if (!imported) throw new Error('Native Claude OAuth credentials disappeared')
  if (imported.trustedDeviceToken) {
    await saveTrustedDeviceToken({
      accountId: imported.account.id,
      token: TrustedDeviceToken.from(imported.trustedDeviceToken),
    })
  }
  console.log(
    `Imported native Claude OAuth as "${imported.account.label ?? imported.account.id}".`,
  )
}

export async function revokeAccount(
  accountIdArg: string | undefined,
  deps: {
    prompt?: (message: string) => Promise<string>
    revoke?: typeof revokeClaudeOAuthToken
  } = {},
) {
  const accountId = requireText(accountIdArg, 'Account id')
  const loaded = await loadSharedAccountStore()
  const account = loaded.store.accounts.find((entry) => entry.id === accountId)
  if (!account) throw new Error(`Account "${accountId}" not found`)
  if (account.credential.type !== 'oauth') {
    throw new Error('Only OAuth accounts can be remotely revoked')
  }
  const ask = deps.prompt ?? prompt
  const confirmation = await ask(
    `Remote revocation cannot be undone. Type revoke to revoke "${account.label ?? account.id}": `,
  )
  if (confirmation !== 'revoke') throw new Error('OAuth revocation cancelled')

  const outcome = await (deps.revoke ?? revokeClaudeOAuthToken)({
    refreshToken: account.credential.refresh,
  })
  // Disable canonical state first. If the process stops during cleanup, the
  // revoked credential cannot be selected or re-adopted from a stale sidecar.
  await setSharedAccountEnabled(account.id, false)
  await removeAccountPersistent(account.id).catch(() => {})
  console.log(
    `OAuth token ${outcome === 'already-inactive' ? 'was already inactive' : 'was revoked'}; account "${account.label ?? account.id}" is disabled locally.`,
  )
}

async function listAccounts() {
  const storage = await loadAccounts()
  if (!storage?.accounts.length) {
    console.log(`No fallback accounts found at ${getAccountStoragePath()}.`)
    return
  }

  for (const [index, account] of storage.accounts.entries()) {
    const label = account.label || account.id
    const status = account.enabled === false ? 'disabled' : 'enabled'
    if (!isOAuthAccount(account)) {
      console.log(
        `${index + 1}. ${label} (${status}) — API route ${account.baseURL}`,
      )
      continue
    }
    const fiveHour = account.quota?.five_hour?.remainingPercent
    const sevenDay = account.quota?.seven_day?.remainingPercent
    const quota =
      fiveHour === undefined && sevenDay === undefined
        ? 'quota unknown'
        : `5h ${fiveHour ?? '?'}%, 1w ${sevenDay ?? '?'}% remaining`
    console.log(`${index + 1}. ${label} (${status}) — ${quota}`)
  }
}

async function main() {
  const [command, subcommandOrLabel, maybeLabel] = process.argv.slice(2)
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    usage()
    return
  }

  if (command === 'login') {
    await login(subcommandOrLabel)
    return
  }

  if (command === 'api' && subcommandOrLabel === 'add') {
    await addApiRoute(maybeLabel)
    return
  }

  if (command === 'import-native') {
    await importNative(subcommandOrLabel)
    return
  }

  if (command === 'revoke') {
    await revokeAccount(subcommandOrLabel)
    return
  }

  if (command === 'list') {
    await listAccounts()
    return
  }

  if (command === 'relay' && subcommandOrLabel === 'setup') {
    await relaySetup()
    return
  }

  usage()
  process.exitCode = 1
}

// Only run the CLI when executed directly (e.g. `bun src/cli.ts ...`), not when
// imported by tests that exercise individual commands (relaySetup) in-process.
if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    closePromptInterface()
  }
}
