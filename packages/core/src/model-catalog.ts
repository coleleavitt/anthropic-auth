import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  getCachedClaudeCodeVersion,
  getClaudeCodeUserAgent,
} from './claude-version.ts'
import { OAUTH_BETA } from './constants.ts'
import {
  CLAUDE_MYTHOS_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_PRICING,
  isClaudeFableOrMythos5Model,
  resolveClaudeFableMythos5Pricing,
} from './models.ts'
import { getSharedAccountStoreDirectory } from './shared-account-store.ts'

/**
 * Anthropic's model list endpoint. Accepts a subscription OAuth bearer token,
 * so the catalog can be discovered with the same credential used for inference
 * rather than restated as a hand-maintained array in every consumer package.
 */
export const ANTHROPIC_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models'

export const MODEL_CATALOG_FILE_NAME = 'model-catalog.json'
export const MODEL_CATALOG_FILE_ENV = 'ANTHROPIC_MODEL_CATALOG_FILE'

/** Matches Claude Code's gateway-discovery timeout. */
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 3_000
export const MODEL_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000

export type ModelCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type CatalogModel = {
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  /** Effort levels the API reports as usable, empty when effort is unsupported. */
  effortLevels: string[]
  /** True when `thinking.types.adaptive` is supported. */
  adaptiveThinking: boolean
  /** True when `thinking.types.enabled` (token budgets) is supported. */
  budgetThinking: boolean
  /** Restricted-access model, surfaced for display only. */
  limited?: boolean
}

export type ModelCatalog = {
  models: CatalogModel[]
  fetchedAt: number
  /**
   * The Claude Code version this catalog was fetched under. A Claude Code
   * release is how new models reach the API, and Anthropic gates a new model on
   * the declared version, so a version change invalidates the cache regardless
   * of its age — otherwise a launch-day model stays invisible for up to
   * {@link MODEL_CATALOG_MAX_AGE_MS}. Absent on caches written before this
   * field existed, which invalidates them exactly once.
   */
  claudeCodeVersion?: string
}

export type ModelCatalogSource = 'live' | 'cache' | 'fallback'

export type ResolvedModelCatalog = {
  models: CatalogModel[]
  source: ModelCatalogSource
  fetchedAt?: number
}

/**
 * Anthropic does not expose pricing on `/v1/models`, so cost stays local.
 * Keys are matched longest-prefix-first; families cover models released after
 * this table was written. Under subscription OAuth these figures drive
 * reporting only — billing is the plan, not per-token cost.
 */
const MODEL_PRICING: Array<{ prefix: string; cost: ModelCost }> = [
  {
    // Opus 5.5 is cheaper than Opus 5 on every axis; it must win the
    // longest-prefix match below or it inherits Opus 5's rates.
    prefix: CLAUDE_OPUS_5_5_MODEL_ID,
    cost: {
      input: CLAUDE_OPUS_5_5_PRICING.input,
      output: CLAUDE_OPUS_5_5_PRICING.output,
      cacheRead: CLAUDE_OPUS_5_5_PRICING.cacheRead,
      cacheWrite: CLAUDE_OPUS_5_5_PRICING.cacheWrite5m,
    },
  },
  {
    prefix: 'claude-opus-5',
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    prefix: 'claude-sonnet-5',
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    prefix: 'claude-opus-4',
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    prefix: 'claude-sonnet-4',
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    prefix: 'claude-haiku-4',
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
]

const FAMILY_PRICING: Array<{ match: string; cost: ModelCost }> = [
  {
    match: 'opus',
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    match: 'sonnet',
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    match: 'haiku',
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
]

const FALLBACK_COST: ModelCost = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
}

export function resolveModelCost(modelId: string): ModelCost {
  if (isClaudeFableOrMythos5Model(modelId)) {
    // 5.1 point releases sit on a cheaper cache-read tier than 5.0.
    const pricing = resolveClaudeFableMythos5Pricing(modelId)
    return {
      input: pricing.input,
      output: pricing.output,
      cacheRead: pricing.cacheRead,
      cacheWrite: pricing.cacheWrite5m,
    }
  }
  const exact = [...MODEL_PRICING]
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .find((entry) => modelId.startsWith(entry.prefix))
  if (exact) return { ...exact.cost }
  const family = FAMILY_PRICING.find((entry) => modelId.includes(entry.match))
  return { ...(family?.cost ?? FALLBACK_COST) }
}

type RawCapabilityFlag = { supported?: unknown }

type RawModel = {
  id?: unknown
  display_name?: unknown
  max_input_tokens?: unknown
  max_tokens?: unknown
  capabilities?: {
    image_input?: RawCapabilityFlag
    effort?: RawCapabilityFlag & Record<string, unknown>
    thinking?: RawCapabilityFlag & {
      types?: {
        enabled?: RawCapabilityFlag
        adaptive?: RawCapabilityFlag
      }
    }
  }
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function isSupported(flag: unknown): boolean {
  return (
    typeof flag === 'object' &&
    flag !== null &&
    (flag as RawCapabilityFlag).supported === true
  )
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/**
 * Anthropic occasionally lists non-Claude entries; Claude Code filters the same
 * way before caching, so the catalog never offers a model this provider cannot
 * serve.
 */
function isUsableModelId(id: string): boolean {
  return /^(claude|anthropic)/i.test(id)
}

export function normalizeCatalogModel(raw: unknown): CatalogModel | null {
  if (typeof raw !== 'object' || raw === null) return null
  const model = raw as RawModel
  const id = typeof model.id === 'string' ? model.id.trim() : ''
  if (!id || !isUsableModelId(id)) return null

  // Reject degraded entries (no max_input_tokens) so they can't overwrite the cache with 200k/64k default-collapse.
  if (
    !(typeof model.max_input_tokens === 'number' && model.max_input_tokens > 0)
  ) {
    return null
  }

  const capabilities = model.capabilities ?? {}
  const thinkingTypes = capabilities.thinking?.types ?? {}
  const adaptiveThinking = isSupported(thinkingTypes.adaptive)
  const budgetThinking = isSupported(thinkingTypes.enabled)
  const effortSupported = isSupported(capabilities.effort)
  const effortLevels = effortSupported
    ? EFFORT_LEVELS.filter((level) => isSupported(capabilities.effort?.[level]))
    : []

  return {
    id,
    name: typeof model.display_name === 'string' ? model.display_name : id,
    reasoning: isSupported(capabilities.thinking),
    input: isSupported(capabilities.image_input) ? ['text', 'image'] : ['text'],
    cost: resolveModelCost(id),
    contextWindow: positiveInt(model.max_input_tokens, 200_000),
    maxTokens: positiveInt(model.max_tokens, 64_000),
    effortLevels: [...effortLevels],
    adaptiveThinking,
    budgetThinking,
    ...(id.startsWith(CLAUDE_MYTHOS_5_MODEL_ID) ? { limited: true } : {}),
  }
}

export function getModelCatalogPath(): string {
  return (
    process.env[MODEL_CATALOG_FILE_ENV]?.trim() ||
    join(getSharedAccountStoreDirectory(), MODEL_CATALOG_FILE_NAME)
  )
}

// Cached entries are already normalized (contextWindow/maxTokens); re-running the raw-API
// normalizeCatalogModel over them recomputes from absent max_input_tokens → 200k/64k collapse.
function coerceCachedCatalogModel(raw: unknown): CatalogModel | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Partial<CatalogModel>
  const id = typeof m.id === 'string' ? m.id.trim() : ''
  if (!id || !isUsableModelId(id)) return null
  if (!(typeof m.contextWindow === 'number' && m.contextWindow > 0)) return null
  if (!(typeof m.maxTokens === 'number' && m.maxTokens > 0)) return null
  return {
    id,
    name: typeof m.name === 'string' ? m.name : id,
    reasoning: m.reasoning === true,
    input:
      Array.isArray(m.input) && m.input.includes('image')
        ? ['text', 'image']
        : ['text'],
    cost: resolveModelCost(id),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    effortLevels: Array.isArray(m.effortLevels)
      ? m.effortLevels.filter((l): l is string => typeof l === 'string')
      : [],
    adaptiveThinking: m.adaptiveThinking === true,
    budgetThinking: m.budgetThinking === true,
    ...(m.limited === true ? { limited: true } : {}),
  }
}

function parseCatalog(text: string): ModelCatalog | null {
  try {
    const parsed = JSON.parse(text) as {
      models?: unknown
      fetchedAt?: unknown
      claudeCodeVersion?: unknown
    }
    if (!Array.isArray(parsed.models)) return null
    const models = parsed.models.flatMap((entry) => {
      const model = coerceCachedCatalogModel(entry)
      return model ? [model] : []
    })
    if (models.length === 0) return null
    return {
      models,
      fetchedAt:
        typeof parsed.fetchedAt === 'number' && parsed.fetchedAt > 0
          ? parsed.fetchedAt
          : 0,
      ...(typeof parsed.claudeCodeVersion === 'string' &&
      parsed.claudeCodeVersion
        ? { claudeCodeVersion: parsed.claudeCodeVersion }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * Synchronous so a consumer can seed its provider registration during module
 * initialization without paying a network round trip on every launch.
 */
export function readModelCatalogCacheSync(
  path = getModelCatalogPath(),
): ModelCatalog | null {
  try {
    return parseCatalog(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export async function readModelCatalogCache(
  path = getModelCatalogPath(),
): Promise<ModelCatalog | null> {
  try {
    return parseCatalog(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

export async function writeModelCatalogCache(
  catalog: ModelCatalog,
  path = getModelCatalogPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function fetchAnthropicModelCatalog(options: {
  accessToken: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<CatalogModel[]> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? MODEL_CATALOG_FETCH_TIMEOUT_MS,
  )
  const abortOuter = () => controller.abort()
  options.signal?.addEventListener('abort', abortOuter, { once: true })
  try {
    const models = new Map<string, CatalogModel>()
    let afterId: string | undefined
    for (let page = 0; page < 100; page++) {
      const url = new URL(ANTHROPIC_MODELS_ENDPOINT)
      url.searchParams.set('limit', '1000')
      if (afterId) url.searchParams.set('after_id', afterId)
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${options.accessToken}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': OAUTH_BETA,
          'user-agent': getClaudeCodeUserAgent(),
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`Anthropic model list failed: HTTP ${response.status}`)
      }
      const payload = (await response.json()) as {
        data?: unknown
        has_more?: unknown
        last_id?: unknown
      }
      if (!Array.isArray(payload.data)) {
        throw new Error('Anthropic model list returned an unexpected body')
      }
      for (const entry of payload.data) {
        const model = normalizeCatalogModel(entry)
        if (model) models.set(model.id, model)
      }
      if (payload.has_more !== true) break
      if (
        typeof payload.last_id !== 'string' ||
        payload.last_id.length === 0 ||
        payload.last_id === afterId
      ) {
        throw new Error(
          'Anthropic model list returned an invalid pagination cursor',
        )
      }
      afterId = payload.last_id
      if (page === 99) {
        throw new Error('Anthropic model list exceeded the pagination limit')
      }
    }
    if (models.size === 0) {
      throw new Error('Anthropic model list returned no usable models')
    }
    return [...models.values()]
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortOuter)
  }
}

export function isModelCatalogFresh(
  catalog: ModelCatalog | null,
  maxAgeMs = MODEL_CATALOG_MAX_AGE_MS,
  claudeCodeVersion = getCachedClaudeCodeVersion(),
): boolean {
  if (!catalog) return false
  if (catalog.claudeCodeVersion !== claudeCodeVersion) return false
  return Date.now() - catalog.fetchedAt < maxAgeMs
}

/**
 * True when the cache was written under a different Claude Code version than
 * the one this process declares. New models ship with a Claude Code release and
 * are version-gated by the API, so this cache is known wrong rather than merely
 * old — the caller should wait for the refresh instead of serving it.
 */
export function modelCatalogVersionChanged(
  catalog: ModelCatalog | null,
  claudeCodeVersion = getCachedClaudeCodeVersion(),
): boolean {
  if (!catalog) return false
  return catalog.claudeCodeVersion !== claudeCodeVersion
}

/**
 * Cache-first: a fresh cache resolves without network I/O, a stale cache is
 * served immediately while a refresh runs in the background, and only a cold
 * start blocks on the live fetch. `fallback` covers the offline first run.
 */
export async function resolveAnthropicModelCatalog(options: {
  accessToken?: string
  fallback: CatalogModel[]
  maxAgeMs?: number
  timeoutMs?: number
  path?: string
  onError?: (error: unknown) => void
}): Promise<ResolvedModelCatalog> {
  const path = options.path ?? getModelCatalogPath()
  const cached = await readModelCatalogCache(path)
  const fresh = isModelCatalogFresh(cached, options.maxAgeMs)

  if (cached && fresh) {
    return {
      models: cached.models,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    }
  }

  if (!options.accessToken) {
    return cached
      ? { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt }
      : { models: options.fallback, source: 'fallback' }
  }

  const accessToken = options.accessToken
  const refresh = async () => {
    const models = await fetchAnthropicModelCatalog({
      accessToken,
      timeoutMs: options.timeoutMs,
    })
    await writeModelCatalogCache(
      {
        models,
        fetchedAt: Date.now(),
        claudeCodeVersion: getCachedClaudeCodeVersion(),
      },
      path,
    )
    return models
  }

  if (cached && !modelCatalogVersionChanged(cached)) {
    // Stale but usable: never make the caller wait on the network.
    void refresh().catch((error) => options.onError?.(error))
    return {
      models: cached.models,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    }
  }

  if (cached) {
    // The Claude Code version moved, so this cache predates whatever models
    // that release added. Wait for the refresh (bounded by `timeoutMs`) and
    // fall back to the stale list only if it fails.
    try {
      const models = await refresh()
      return { models, source: 'live', fetchedAt: Date.now() }
    } catch (error) {
      options.onError?.(error)
      return {
        models: cached.models,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
      }
    }
  }

  try {
    const models = await refresh()
    return { models, source: 'live', fetchedAt: Date.now() }
  } catch (error) {
    options.onError?.(error)
    return { models: options.fallback, source: 'fallback' }
  }
}
