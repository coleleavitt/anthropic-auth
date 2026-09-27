import {
  authorize,
  type CatalogModel,
  CLAUDE_FABLE_MYTHOS_5_1_PRICING,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  CLAUDE_OPUS_5_5_CONTEXT_WINDOW,
  CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_OPUS_5_5_MODEL_ID,
  type ClaustrumScopedClient,
  exchange,
  findSharedAccountByCredential,
  getClaudeCodeVersion,
  getClaustrumMode,
  isClaudeFableOrMythos51Model,
  loadAccounts,
  loadSharedAccountStore,
  type MidConversationEffortTransition,
  resolveAnthropicModelCatalog,
  resolveModelCost,
  startOAuthLoopbackSession,
  updateSharedAccountStore,
} from '@cortexkit/anthropic-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  Provider,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ProviderConfig,
} from '@earendil-works/pi-coding-agent'

import { adoptSharedCredentialIntoHostAuth } from './adopt-host-credential.ts'
import { registerCommands } from './commands.ts'
import { createPiCustodyCommands, requirePiEnrollment } from './custody.ts'
import {
  collectPiEffortHistory,
  deriveContextEntries,
} from './effort-history.ts'
import { getPiAccountStoragePath } from './paths.ts'
import {
  assertLocalAuthentication,
  currentSharedAccount,
  forgetDeadRefreshTokens,
  refreshAnthropicToken,
  sharedCredentialIsLive,
} from './shared-refresh.ts'
import {
  closePiScopedRuntime,
  getPiScopedRuntime,
  streamCortexKitAnthropic,
} from './stream.ts'
import { errorHttpStatus, withAuthSpan } from './trace-bridge.ts'

export async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  await assertLocalAuthentication()
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
  await assertLocalAuthentication()
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
  ...Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((model) => {
    const pricing = isClaudeFableOrMythos51Model(model.id)
      ? CLAUDE_FABLE_MYTHOS_5_1_PRICING
      : CLAUDE_FABLE_MYTHOS_5_PRICING
    return {
      ...fallbackModel(
        model.id,
        model.name,
        CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
        CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
        model.limited,
      ),
      cost: {
        input: pricing.input,
        output: pricing.output,
        cacheRead: pricing.cacheRead,
        cacheWrite: pricing.cacheWrite5m,
      },
    }
  }),
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

async function currentSharedAccessToken(): Promise<string | undefined> {
  const loaded = await loadSharedAccountStore().catch(() => null)
  if (!loaded) return undefined
  const account = currentSharedAccount(loaded.store)
  if (!account || !sharedCredentialIsLive(account, Date.now())) return undefined
  const credential = account.credential
  return credential.type === 'oauth' ? credential.access : undefined
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

export default async function cortexKitPiAnthropicAuth(
  pi: ExtensionAPI,
  options: {
    connectScoped?: () => Promise<ClaustrumScopedClient>
    pollIntervalMs?: number
  } = {},
) {
  const storagePath = getPiAccountStoragePath()
  registerCommands(
    pi,
    createPiCustodyCommands({
      storagePath,
      reconfigure: configureProvider,
      connect: options.connectScoped,
    }),
  )
  const effortHistoryBySession = new Map<
    string,
    MidConversationEffortTransition[]
  >()
  pi.on('turn_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return
    // This hook only adds mid-conversation effort markers to Fable/Mythos 5.1
    // requests. A host whose session entries do not match what this reads must
    // cost the session its transitions and nothing else: the handler runs
    // before every turn, and an exception here surfaced as a per-turn extension
    // error while collecting no effort history at all (issue #200).
    //
    // The catch stays quiet: `ExtensionAPI` carries no log surface on either
    // host, and writing to stdout from a per-turn hook corrupts the host's
    // rendering — which is the same per-turn noise this fix removes. The
    // degraded state is observable in the request: no effort markers.
    let transitions: MidConversationEffortTransition[]
    try {
      const branch = ctx.sessionManager.getBranch()
      transitions = collectPiEffortHistory(deriveContextEntries(branch), branch)
    } catch {
      transitions = []
    }
    effortHistoryBySession.delete(sessionId)
    effortHistoryBySession.set(sessionId, transitions)
    while (effortHistoryBySession.size > 128) {
      const oldest = effortHistoryBySession.keys().next().value
      if (oldest) effortHistoryBySession.delete(oldest)
      else break
    }
  })
  pi.on('session_shutdown', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    if (sessionId) effortHistoryBySession.delete(sessionId)
    closePiScopedRuntime(storagePath)
  })

  // Pi's pre-flight gate (`hasConfiguredAuth`) reads only Pi's own auth file,
  // while our request path reads the shared store, so a cold `auth.json` would
  // refuse a machine that is fully authenticated. Seed it before the provider
  // is registered, and never let a failure here block registration.
  // Under Claustrum custody Pi must hold no local OAuth credential, so the
  // host auth file is left alone.
  if (getClaustrumMode(await loadAccounts(storagePath)) !== 'claustrum') {
    await adoptSharedCredentialIntoHostAuth().catch(() => undefined)
  }

  // Warm the live Claude Code version so request fingerprints track the
  // published CLI instead of the compiled floor; Anthropic hard-rejects
  // fingerprints that are too old for newer models.
  void getClaudeCodeVersion().catch(() => {})

  const catalog = await resolvePiModelCatalog()

  const configuration: ProviderConfig = {
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
    streamSimple: (model, context, options) =>
      streamCortexKitAnthropic(
        model,
        context,
        options,
        options?.sessionId
          ? effortHistoryBySession.get(options.sessionId)
          : undefined,
      ),
  }

  async function configureProvider() {
    if (getClaustrumMode(await loadAccounts(storagePath)) !== 'claustrum') {
      closePiScopedRuntime(storagePath)
      pi.registerProvider('anthropic', configuration)
      return
    }
    const streamSimple = configuration.streamSimple
    if (!streamSimple)
      throw new Error('Anthropic stream implementation is unavailable')
    const configured = async () => {
      if (getClaustrumMode(await loadAccounts(storagePath)) !== 'claustrum')
        return false
      await requirePiEnrollment()
      return true
    }
    const provider: Provider = {
      id: 'anthropic',
      name: 'Anthropic (Claustrum)',
      baseUrl: 'https://api.anthropic.com',
      auth: {
        // Native ambient auth avoids fake keys and local OAuth refresh. Pi refuses
        // a leftover stored OAuth credential because this provider has no OAuth
        // handler; setup must obtain consent before removing that local entry.
        apiKey: {
          name: 'Claustrum',
          check: async () =>
            (await configured())
              ? { type: 'api_key', source: 'Claustrum' }
              : undefined,
          resolve: async () =>
            (await configured())
              ? { auth: {}, source: 'Claustrum' }
              : undefined,
        },
      },
      getModels: () =>
        (configuration.models ?? []).map((model) => ({
          ...model,
          provider: 'anthropic',
          api: model.api ?? 'cortexkit-anthropic-messages',
          baseUrl: model.baseUrl ?? 'https://api.anthropic.com',
        })),
      // Preserve the legacy provider's simplified option surface for raw calls.
      stream: (model, context, options) =>
        streamSimple(model, context, options as SimpleStreamOptions),
      streamSimple,
    }
    pi.registerProvider(provider)
    getPiScopedRuntime(storagePath, {
      ...(options.connectScoped && { connect: options.connectScoped }),
      ...(options.pollIntervalMs !== undefined && {
        pollIntervalMs: options.pollIntervalMs,
      }),
    }).start()
  }
  await configureProvider()
}

export { forgetDeadRefreshTokens, refreshAnthropicToken }
