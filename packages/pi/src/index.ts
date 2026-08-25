import {
  authorize,
  type CatalogModel,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  claimSharedAccountRefresh,
  exchange,
  findSharedAccountByCredential,
  type LoadedSharedAccountStore,
  loadSharedAccountStore,
  logger,
  refreshClaudeOAuthToken,
  releaseSharedAccountRefresh,
  resolveAnthropicModelCatalog,
  resolveModelCost,
  type SharedAnthropicAccount,
  startOAuthLoopbackSession,
  updateSharedAccountStore,
} from '@cortexkit/anthropic-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerCommands } from './commands.ts'
import { streamCortexKitAnthropic } from './stream.ts'

export async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  let loopback: Awaited<ReturnType<typeof startOAuthLoopbackSession>> | null =
    null
  let auth: Awaited<ReturnType<typeof authorize>>
  try {
    loopback = await startOAuthLoopbackSession()
    auth = await authorize('max', {
      redirectUri: loopback.redirectUri,
      state: loopback.state,
    })
  } catch {
    loopback = null
    auth = await authorize('max')
  }
  callbacks.onAuth({ url: auth.url })
  const manualCallback = callbacks.onPrompt({
    message: 'Paste the Claude OAuth callback URL or code:',
  })
  let callback: string
  if (loopback) {
    try {
      const completed = await Promise.race([
        loopback.waitForCallback().then((value) => ({
          source: 'loopback' as const,
          callback: `${value.code}#${value.state}`,
        })),
        manualCallback.then((value) => ({
          source: 'manual' as const,
          callback: value,
        })),
      ])
      callback = completed.callback
      if (completed.source === 'manual') loopback.cancel()
    } finally {
      await loopback.close().catch(() => {})
    }
  } else {
    callback = await manualCallback
  }
  const result = await exchange(
    callback,
    auth.verifier,
    auth.redirectUri,
    auth.state,
  )
  if (result.type !== 'success') {
    throw new Error('Anthropic OAuth exchange failed')
  }
  const now = Date.now()
  await updateSharedAccountStore((store) => {
    const credential = {
      type: 'oauth' as const,
      access: result.access,
      refresh: result.refresh,
      expires_at: result.expires,
      ...(typeof result.refreshTokenExpiresAt === 'number'
        ? { refresh_expires_at: result.refreshTokenExpiresAt }
        : {}),
      ...(result.scopes?.length ? { scopes: result.scopes } : {}),
      ...(result.accountId
        ? {
            account: {
              uuid: result.accountId,
              ...(result.email ? { email_address: result.email } : {}),
            },
          }
        : {}),
      ...(result.organizationId
        ? { organization: { uuid: result.organizationId } }
        : {}),
    }
    const existing =
      findSharedAccountByCredential(store, credential) ??
      store.accounts.find(
        (account) => account.id === (result.accountId ?? 'pi-main'),
      )
    const account = {
      id: existing?.id ?? result.accountId ?? 'pi-main',
      label: existing?.label ?? 'Pi Anthropic',
      email: result.email ?? existing?.email,
      credential,
      enabled: true,
      created_at: existing?.created_at ?? new Date(now).toISOString(),
      last_used_at: existing?.last_used_at,
    }
    const index = store.accounts.findIndex((entry) => entry.id === account.id)
    if (index >= 0) store.accounts[index] = account
    else store.accounts.push(account)
    store.current = account.id
  })
  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  }
}

function textImageInput(): Array<'text' | 'image'> {
  return ['text', 'image']
}

function fallbackModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  limited?: boolean,
): CatalogModel {
  return {
    id,
    name,
    reasoning: true,
    input: textImageInput(),
    cost: resolveModelCost(id),
    contextWindow,
    maxTokens,
    effortLevels: [],
    adaptiveThinking: false,
    budgetThinking: true,
    ...(limited ? { limited: true } : {}),
  }
}

// Reached only when the live catalog and its cache both fail. Deliberately not
// synced with the live registry — it is the shipped floor, not a mirror.
export const FALLBACK_MODEL_CATALOG: CatalogModel[] = [
  ...Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((model) => ({
    ...fallbackModel(
      model.id,
      model.name,
      CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
      CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
      model.limited,
    ),
    cost: {
      input: CLAUDE_FABLE_MYTHOS_5_PRICING.input,
      output: CLAUDE_FABLE_MYTHOS_5_PRICING.output,
      cacheRead: CLAUDE_FABLE_MYTHOS_5_PRICING.cacheRead,
      cacheWrite: CLAUDE_FABLE_MYTHOS_5_PRICING.cacheWrite5m,
    },
  })),
  fallbackModel('claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000),
  fallbackModel('claude-opus-4-8', 'Claude Opus 4.8', 1_000_000, 128_000),
  fallbackModel('claude-opus-4-5', 'Claude Opus 4.5', 200_000, 64_000),
  fallbackModel('claude-sonnet-4-5', 'Claude Sonnet 4.5', 200_000, 64_000),
  fallbackModel('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000),
]

const SHARED_CREDENTIAL_ADOPTION_SKEW_MS = 60_000

function currentSharedAccount(
  store: LoadedSharedAccountStore['store'],
): SharedAnthropicAccount | undefined {
  return (
    store.accounts.find(
      (entry) => entry.id === store.current && entry.enabled !== false,
    ) ?? store.accounts.find((entry) => entry.enabled !== false)
  )
}

async function currentSharedAccessToken(): Promise<string | undefined> {
  const loaded = await loadSharedAccountStore().catch(() => null)
  if (!loaded) return undefined
  const credential = currentSharedAccount(loaded.store)?.credential
  return credential?.type === 'oauth' ? credential.access : undefined
}

/**
 * Anthropic rotates the refresh token on every refresh, so a peer process that
 * refreshed first leaves this one holding a superseded token whose failure
 * invalidates the whole login, not just one request.
 */
function adoptableSharedCredential(
  store: LoadedSharedAccountStore['store'],
  credentials: OAuthCredentials,
  now: number,
): OAuthCredentials | undefined {
  const credential = currentSharedAccount(store)?.credential
  if (credential?.type !== 'oauth') return undefined
  // An unrotated match means no peer refreshed; this caller still has to.
  if (credential.refresh === credentials.refresh) return undefined
  if (credential.expires_at <= now + SHARED_CREDENTIAL_ADOPTION_SKEW_MS)
    return undefined
  return {
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires_at,
  }
}

export async function resolvePiModelCatalog(): Promise<CatalogModel[]> {
  const resolved = await resolveAnthropicModelCatalog({
    accessToken: await currentSharedAccessToken(),
    fallback: FALLBACK_MODEL_CATALOG,
  })
  return resolved.models
}

/** Bounded like the CLI's refresh lock retry (5 attempts, jittered waits). */
const REFRESH_CLAIM_MAX_ATTEMPTS = 5

export async function refreshAnthropicToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const loaded = await loadSharedAccountStore().catch(() => null)
  const sharedAccount = loaded?.store.accounts.find(
    (account) =>
      account.credential.type === 'oauth' &&
      account.credential.refresh === credentials.refresh,
  )
  if (loaded && !sharedAccount) {
    const adopted = adoptableSharedCredential(
      loaded.store,
      credentials,
      Date.now(),
    )
    if (adopted) return adopted
  }
  const refreshExpiry =
    sharedAccount?.credential.type === 'oauth'
      ? sharedAccount.credential.refresh_expires_at
      : undefined

  // Anthropic revokes the whole token family when a refresh token is presented
  // twice, so the network call has to be serialised across processes. Claiming
  // first — and re-reading under the claim — is what stops two agents sharing
  // this store from spending the same token and killing the account. The store
  // CAS below is not enough on its own: by the time it runs, both POSTs have
  // already reached Anthropic.
  let leaseId: string | undefined
  if (sharedAccount) {
    for (let attempt = 0; ; attempt += 1) {
      const claim = await claimSharedAccountRefresh(
        sharedAccount.id,
        credentials.refresh,
        {},
      )
      if (claim.status === 'claimed') {
        leaseId = claim.leaseId
        break
      }
      if (claim.status === 'already-refreshed') {
        logger.info('pi.refresh', 'another process already rotated the token', {
          accountId: sharedAccount.id,
        })
        return {
          refresh: claim.credential.refresh,
          access: claim.credential.access,
          expires: claim.credential.expires_at,
        }
      }
      if (claim.status === 'unknown-account') break
      if (attempt >= REFRESH_CLAIM_MAX_ATTEMPTS) {
        logger.warn('pi.refresh', 'refresh claim timed out; proceeding alone', {
          accountId: sharedAccount.id,
        })
        break
      }
      // Matches the CLI's lock retry: bounded attempts, jittered waits.
      logger.debug('pi.refresh', 'refresh claim held by another process', {
        accountId: sharedAccount.id,
        attempt,
      })
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 + Math.random() * 1_000),
      )
    }
  }

  let refreshed: Awaited<ReturnType<typeof refreshClaudeOAuthToken>>
  try {
    refreshed = await refreshClaudeOAuthToken({
      refreshToken: credentials.refresh,
      refreshTokenExpiresAt: refreshExpiry,
    })
  } catch (error) {
    if (sharedAccount && leaseId) {
      await releaseSharedAccountRefresh(sharedAccount.id, leaseId).catch(
        () => {},
      )
    }
    throw error
  }

  if (sharedAccount) {
    const persisted = await updateSharedAccountStore((store) => {
      const current = store.accounts.find(
        (account) => account.id === sharedAccount.id,
      )
      if (
        current?.credential.type !== 'oauth' ||
        current.credential.refresh !== credentials.refresh
      ) {
        return false
      }
      current.credential.access = refreshed.access
      current.credential.refresh = refreshed.refresh
      current.credential.expires_at = refreshed.expires
      current.credential.refresh_expires_at =
        refreshed.refreshTokenExpiresAt ?? current.credential.refresh_expires_at
      current.last_error = undefined
      current.refresh_lease = undefined
      return true
    })
    if (!persisted.result) {
      const winner = (await loadSharedAccountStore()).store.accounts.find(
        (account) => account.id === sharedAccount.id,
      )
      if (winner?.credential.type !== 'oauth') {
        throw new Error('Anthropic OAuth refresh was superseded')
      }
      return {
        refresh: winner.credential.refresh,
        access: winner.credential.access,
        expires: winner.credential.expires_at,
      }
    }
  }

  return {
    refresh: refreshed.refresh,
    access: refreshed.access,
    expires: refreshed.expires,
  }
}

export default async function cortexKitPiAnthropicAuth(pi: ExtensionAPI) {
  registerCommands(pi)

  const catalog = await resolvePiModelCatalog()

  pi.registerProvider('anthropic', {
    name: 'Anthropic (CortexKit OAuth)',
    baseUrl: 'https://api.anthropic.com',
    api: 'cortexkit-anthropic-messages',
    models: catalog.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
    oauth: {
      name: 'Anthropic Claude Pro/Max (CortexKit)',
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials) => credentials.access,
    },
    streamSimple: streamCortexKitAnthropic,
  })
}
