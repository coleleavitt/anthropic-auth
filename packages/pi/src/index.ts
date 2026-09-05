import {
  authorize,
  type CatalogModel,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  exchange,
  findSharedAccountByCredential,
  getClaudeCodeVersion,
  loadSharedAccountStore,
  resolveAnthropicModelCatalog,
  resolveModelCost,
  startOAuthLoopbackSession,
  updateSharedAccountStore,
} from '@cortexkit/anthropic-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerCommands } from './commands.ts'
import {
  currentSharedAccount,
  forgetDeadRefreshTokens,
  refreshAnthropicToken,
  sharedCredentialIsLive,
} from './shared-refresh.ts'
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
  fallbackModel('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000),
]

async function currentSharedAccessToken(): Promise<string | undefined> {
  const loaded = await loadSharedAccountStore().catch(() => null)
  if (!loaded) return undefined
  const account = currentSharedAccount(loaded.store)
  if (!account || !sharedCredentialIsLive(account, Date.now())) return undefined
  const credential = account.credential
  return credential.type === 'oauth' ? credential.access : undefined
}

export async function resolvePiModelCatalog(): Promise<CatalogModel[]> {
  const resolved = await resolveAnthropicModelCatalog({
    accessToken: await currentSharedAccessToken(),
    fallback: FALLBACK_MODEL_CATALOG,
  })
  return resolved.models
}

export default async function cortexKitPiAnthropicAuth(pi: ExtensionAPI) {
  registerCommands(pi)

  // Warm the live Claude Code version so request fingerprints track the
  // published CLI instead of the compiled floor; Anthropic hard-rejects
  // fingerprints that are too old for newer models.
  void getClaudeCodeVersion().catch(() => {})

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

export { forgetDeadRefreshTokens, refreshAnthropicToken }
