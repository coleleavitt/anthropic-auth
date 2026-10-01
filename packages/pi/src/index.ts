import {
  type CatalogModel,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  CLAUDE_OPUS_5_5_CONTEXT_WINDOW,
  CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_OPUS_5_5_MODEL_ID,
  claudeCodeLoginNotice,
  getClaudeCodeVersion,
  getSharedAccessToken,
  listSharedAccounts,
  resolveAnthropicModelCatalog,
  resolveModelCost,
  startSharedLoginWithLoopback,
} from '@cortexkit/anthropic-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { adoptSharedCredentialIntoHostAuth } from './adopt-host-credential.ts'
import { registerCommands } from './commands.ts'
import {
  currentSharedAccount,
  hostCredentialsFor,
  refreshAnthropicToken,
  sharedCredentialIsLive,
} from './shared-refresh.ts'
import { streamCortexKitAnthropic } from './stream.ts'
import { errorHttpStatus, withAuthSpan } from './trace-bridge.ts'

/**
 * Pi's `/login anthropic`. The Rust binding owns the PKCE verifier, the code
 * exchange and the store write, so no token passes through here except the
 * access token Pi needs for `getApiKey`; Pi's `auth.json` gets the store
 * placeholder instead of the refresh token.
 */
export async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const { login, loopback } = await startSharedLoginWithLoopback({
    mode: 'max',
  })
  callbacks.onAuth({ url: login.url })
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
  const account = await login.complete({ callback, setCurrent: true })
  // One login per account: a login of the account Claude Code is logged into
  // replaced Claude Code's (the binding published it to Claude Code's file).
  const notice = claudeCodeLoginNotice(account)
  if (notice) callbacks.onProgress?.(notice)
  return hostCredentialsFor(await getSharedAccessToken(account.id))
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
  fallbackModel(
    CLAUDE_OPUS_5_5_MODEL_ID,
    'Claude Opus 5.5',
    CLAUDE_OPUS_5_5_CONTEXT_WINDOW,
    CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS,
  ),
  fallbackModel('claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000),
  fallbackModel('claude-opus-4-8', 'Claude Opus 4.8', 1_000_000, 128_000),
  fallbackModel('claude-opus-4-5', 'Claude Opus 4.5', 200_000, 64_000),
  fallbackModel('claude-sonnet-4-5', 'Claude Sonnet 4.5', 200_000, 64_000),
  fallbackModel('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000),
  fallbackModel('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000),
]

/**
 * A live access token for the catalog request, only when the store already
 * holds one: fetching the model list is not a reason to spend a refresh token.
 */
async function currentSharedAccessToken(): Promise<string | undefined> {
  const accounts = await listSharedAccounts().catch(() => null)
  if (!accounts) return undefined
  const account = currentSharedAccount(accounts)
  if (!account || !sharedCredentialIsLive(account, Date.now())) return undefined
  const token = await getSharedAccessToken(account.id).catch(() => null)
  return token?.accessToken
}

export async function resolvePiModelCatalog(): Promise<CatalogModel[]> {
  return withAuthSpan('auth.catalog', undefined, async (span) => {
    const accessToken = await currentSharedAccessToken()
    span.setAttributes({ 'catalog.authenticated': Boolean(accessToken) })
    const resolved = await resolveAnthropicModelCatalog({
      accessToken,
      fallback: FALLBACK_MODEL_CATALOG,
      onError: (error) => {
        // A stale cache is served while the refresh runs in the background,
        // so this can land after the span has ended and go unreported; the
        // bridge never throws either way.
        span.setAttributes({
          'catalog.error':
            error instanceof Error ? error.message : String(error),
          'http.status': errorHttpStatus(error),
        })
      },
    })
    span.setAttributes({
      'catalog.models': resolved.models.length,
      'catalog.cached': resolved.source === 'cache',
      'catalog.source': resolved.source,
    })
    return resolved.models
  })
}

export default async function cortexKitPiAnthropicAuth(pi: ExtensionAPI) {
  registerCommands(pi)

  // Pi's pre-flight gate (`hasConfiguredAuth`) reads only Pi's own auth file,
  // while our request path reads the shared store, so a cold `auth.json` would
  // refuse a machine that is fully authenticated. Seed it before the provider
  // is registered, and never let a failure here block registration.
  await adoptSharedCredentialIntoHostAuth().catch(() => undefined)

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

export { refreshAnthropicToken }
