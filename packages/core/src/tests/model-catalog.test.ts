import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type CatalogModel,
  fetchAnthropicModelCatalog,
  isModelCatalogFresh,
  normalizeCatalogModel,
  readModelCatalogCache,
  readModelCatalogCacheSync,
  resolveAnthropicModelCatalog,
  resolveModelCost,
  writeModelCatalogCache,
} from '../model-catalog.ts'

const tempDirectories: string[] = []
const originalFetch = globalThis.fetch

async function tempCatalogPath() {
  const directory = await mkdtemp(join(tmpdir(), 'model-catalog-'))
  tempDirectories.push(directory)
  return join(directory, 'model-catalog.json')
}

function apiModel(overrides: Record<string, unknown> = {}) {
  return {
    type: 'model',
    id: 'claude-opus-5',
    display_name: 'Claude Opus 5',
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      image_input: { supported: true },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      },
      thinking: {
        supported: true,
        types: {
          enabled: { supported: false },
          adaptive: { supported: true },
        },
      },
    },
    ...overrides,
  }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: URL | RequestInfo, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}

const fallback: CatalogModel[] = [
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    effortLevels: [],
    adaptiveThinking: false,
    budgetThinking: true,
  },
]

afterEach(async () => {
  globalThis.fetch = originalFetch
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('normalizeCatalogModel', () => {
  test('maps live capabilities onto the catalog shape', () => {
    const model = normalizeCatalogModel(apiModel())
    expect(model).not.toBeNull()
    expect(model?.id).toBe('claude-opus-5')
    expect(model?.name).toBe('Claude Opus 5')
    expect(model?.reasoning).toBe(true)
    expect(model?.input).toEqual(['text', 'image'])
    expect(model?.contextWindow).toBe(1_000_000)
    expect(model?.maxTokens).toBe(128_000)
    expect(model?.adaptiveThinking).toBe(true)
    expect(model?.budgetThinking).toBe(false)
    expect(model?.effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  test('drops effort levels the API marks unsupported', () => {
    const model = normalizeCatalogModel(
      apiModel({
        id: 'claude-opus-4-6',
        capabilities: {
          image_input: { supported: true },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: false },
            max: { supported: true },
          },
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: true },
            },
          },
        },
      }),
    )
    expect(model?.effortLevels).toEqual(['low', 'medium', 'high', 'max'])
    expect(model?.budgetThinking).toBe(true)
  })

  test('reports text-only input when image support is absent', () => {
    const model = normalizeCatalogModel(
      apiModel({ capabilities: { thinking: { supported: false } } }),
    )
    expect(model?.input).toEqual(['text'])
    expect(model?.reasoning).toBe(false)
    expect(model?.effortLevels).toEqual([])
  })

  test('rejects entries that are not usable Claude models', () => {
    expect(normalizeCatalogModel(apiModel({ id: 'gpt-4o' }))).toBeNull()
    expect(normalizeCatalogModel(apiModel({ id: '' }))).toBeNull()
    expect(normalizeCatalogModel(null)).toBeNull()
    expect(normalizeCatalogModel('claude-opus-5')).toBeNull()
  })

  test('marks Mythos as limited access', () => {
    const model = normalizeCatalogModel(apiModel({ id: 'claude-mythos-5' }))
    expect(model?.limited).toBe(true)
    expect(normalizeCatalogModel(apiModel())?.limited).toBeUndefined()
  })

  test('rejects degraded entries that omit max_input_tokens', () => {
    expect(
      normalizeCatalogModel(
        apiModel({ max_input_tokens: null, max_tokens: 0 }),
      ),
    ).toBeNull()
    expect(
      normalizeCatalogModel(apiModel({ max_input_tokens: undefined })),
    ).toBeNull()
    expect(normalizeCatalogModel(apiModel({ max_input_tokens: 0 }))).toBeNull()
  })
})

describe('resolveModelCost', () => {
  test('uses the Fable/Mythos pricing block', () => {
    expect(resolveModelCost('claude-fable-5')).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    })
  })

  test('prefers the longest matching prefix over the family default', () => {
    expect(resolveModelCost('claude-sonnet-5')).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    })
    expect(resolveModelCost('claude-sonnet-4-6')).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    })
  })

  test('falls back to family pricing for unreleased ids', () => {
    expect(resolveModelCost('claude-opus-9-9')).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    })
    expect(resolveModelCost('claude-haiku-9')).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    })
  })
})

describe('fetchAnthropicModelCatalog', () => {
  test('sends the OAuth bearer token and parses the model list', async () => {
    let seenUrl = ''
    let seenAuth: string | null = null
    stubFetch((url, init) => {
      seenUrl = url
      seenAuth = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify({ data: [apiModel()] }), {
        status: 200,
      })
    })

    const models = await fetchAnthropicModelCatalog({ accessToken: 'token-1' })
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('claude-opus-5')
    expect(seenUrl).toContain('/v1/models')
    expect(seenUrl).toContain('limit=1000')
    expect(seenAuth).toBe('Bearer token-1')
  })

  test('follows model list pagination', async () => {
    const seenUrls: string[] = []
    stubFetch((url) => {
      seenUrls.push(url)
      const afterId = new URL(url).searchParams.get('after_id')
      return new Response(
        JSON.stringify(
          afterId
            ? { data: [apiModel({ id: 'claude-sonnet-5' })], has_more: false }
            : {
                data: [apiModel({ id: 'claude-opus-5' })],
                has_more: true,
                last_id: 'claude-opus-5',
              },
        ),
        { status: 200 },
      )
    })

    const models = await fetchAnthropicModelCatalog({ accessToken: 'token-1' })
    expect(models.map((model) => model.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ])
    expect(new URL(seenUrls[1] ?? '').searchParams.get('after_id')).toBe(
      'claude-opus-5',
    )
  })

  test('throws on a non-OK response', async () => {
    stubFetch(() => new Response('nope', { status: 401 }))
    await expect(
      fetchAnthropicModelCatalog({ accessToken: 'token-1' }),
    ).rejects.toThrow('HTTP 401')
  })

  test('throws when no usable models come back', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: [apiModel({ id: 'gpt-4o' })] }), {
          status: 200,
        }),
    )
    await expect(
      fetchAnthropicModelCatalog({ accessToken: 'token-1' }),
    ).rejects.toThrow('no usable models')
  })
})

describe('catalog cache', () => {
  test('round-trips through disk and reads synchronously', async () => {
    const path = await tempCatalogPath()
    const model = normalizeCatalogModel(apiModel())
    if (!model) throw new Error('expected a normalized model')
    await writeModelCatalogCache({ models: [model], fetchedAt: 1234 }, path)

    const loaded = await readModelCatalogCache(path)
    expect(loaded?.fetchedAt).toBe(1234)
    expect(loaded?.models[0]?.id).toBe('claude-opus-5')
    expect(readModelCatalogCacheSync(path)?.models[0]?.id).toBe('claude-opus-5')
  })

  test('treats missing and malformed caches as absent', async () => {
    const path = await tempCatalogPath()
    expect(await readModelCatalogCache(path)).toBeNull()
    await writeFile(path, 'not json', 'utf8')
    expect(await readModelCatalogCache(path)).toBeNull()
    await writeFile(path, JSON.stringify({ models: [] }), 'utf8')
    expect(await readModelCatalogCache(path)).toBeNull()
  })

  test('freshness is bounded by max age', () => {
    expect(
      isModelCatalogFresh({ models: [], fetchedAt: Date.now() }, 1000),
    ).toBe(true)
    expect(
      isModelCatalogFresh({ models: [], fetchedAt: Date.now() - 5000 }, 1000),
    ).toBe(false)
    expect(isModelCatalogFresh(null)).toBe(false)
  })
})

describe('resolveAnthropicModelCatalog', () => {
  test('fetches and caches on a cold start', async () => {
    const path = await tempCatalogPath()
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: [apiModel()] }), { status: 200 }),
    )

    const resolved = await resolveAnthropicModelCatalog({
      accessToken: 'token-1',
      fallback,
      path,
    })
    expect(resolved.source).toBe('live')
    expect(resolved.models[0]?.id).toBe('claude-opus-5')
    expect((await readModelCatalogCache(path))?.models[0]?.id).toBe(
      'claude-opus-5',
    )
  })

  test('serves a fresh cache without touching the network', async () => {
    const path = await tempCatalogPath()
    const model = normalizeCatalogModel(apiModel({ id: 'claude-opus-4-8' }))
    if (!model) throw new Error('expected a normalized model')
    await writeModelCatalogCache(
      { models: [model], fetchedAt: Date.now() },
      path,
    )
    stubFetch(() => {
      throw new Error('network should not be used')
    })

    const resolved = await resolveAnthropicModelCatalog({
      accessToken: 'token-1',
      fallback,
      path,
    })
    expect(resolved.source).toBe('cache')
    expect(resolved.models[0]?.id).toBe('claude-opus-4-8')
  })

  test('returns the fallback when there is no cache and the fetch fails', async () => {
    const path = await tempCatalogPath()
    stubFetch(() => new Response('boom', { status: 500 }))
    const errors: unknown[] = []

    const resolved = await resolveAnthropicModelCatalog({
      accessToken: 'token-1',
      fallback,
      path,
      onError: (error) => errors.push(error),
    })
    expect(resolved.source).toBe('fallback')
    expect(resolved.models).toEqual(fallback)
    expect(errors).toHaveLength(1)
  })

  test('returns the fallback when no access token is available', async () => {
    const path = await tempCatalogPath()
    stubFetch(() => {
      throw new Error('network should not be used')
    })

    const resolved = await resolveAnthropicModelCatalog({ fallback, path })
    expect(resolved.source).toBe('fallback')
    expect(resolved.models).toEqual(fallback)
  })

  test('serves a stale cache immediately and refreshes behind it', async () => {
    const path = await tempCatalogPath()
    const stale = normalizeCatalogModel(apiModel({ id: 'claude-opus-4-8' }))
    if (!stale) throw new Error('expected a normalized model')
    await writeModelCatalogCache({ models: [stale], fetchedAt: 1 }, path)

    let resolveFetch: (() => void) | undefined
    const fetched = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    stubFetch(() => {
      resolveFetch?.()
      return new Response(JSON.stringify({ data: [apiModel()] }), {
        status: 200,
      })
    })

    const resolved = await resolveAnthropicModelCatalog({
      accessToken: 'token-1',
      fallback,
      path,
    })
    expect(resolved.source).toBe('cache')
    expect(resolved.models[0]?.id).toBe('claude-opus-4-8')

    await fetched
    await Bun.sleep(20)
    expect((await readModelCatalogCache(path))?.models[0]?.id).toBe(
      'claude-opus-5',
    )
  })
})
