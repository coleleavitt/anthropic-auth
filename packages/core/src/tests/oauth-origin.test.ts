import { afterEach, expect, test } from 'bun:test'
import {
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  AnthropicOAuthOriginError,
  createAnthropicOAuthFetch,
  requireAnthropicOAuthOrigin,
} from '../oauth-origin.ts'
import { sendViaRelay } from '../relay.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const SECRET = 'sk-ant-oat01-origin-secret-canary'

test.each([
  'https://api.anthropic.com/v1/messages?beta=true',
  'HTTPS://API.ANTHROPIC.COM:443/v1/messages',
])('accepts the official Anthropic origin %s', (url) => {
  expect(requireAnthropicOAuthOrigin(url).origin).toBe(
    'https://api.anthropic.com',
  )
})

test.each([
  'http://127.0.0.1:43123/v1/messages',
  'https://proxy.example.test/v1/messages',
  'http://api.anthropic.com/v1/messages',
  'https://api.anthropic.com:8443/v1/messages',
  `https://user:${SECRET}@api.anthropic.com/v1/messages`,
  'https://user@api.anthropic.com/v1/messages',
  'https://api.anthropic.com.example.test/v1/messages',
  'blob:https://api.anthropic.com/opaque',
  'not a URL',
])('refuses %s with the fixed message and no URL or token in it', (url) => {
  let caught: unknown
  try {
    requireAnthropicOAuthOrigin(url)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AnthropicOAuthOriginError)
  const message = (caught as Error).message
  expect(message).toBe(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
  expect(message).not.toContain(SECRET)
  expect(message).not.toContain('127.0.0.1')
  expect(message).not.toContain('example.test')
  expect(message).not.toContain('8443')
})

test('an extra origin is matched exactly, including its scheme', () => {
  const options = { extraOrigin: 'http://127.0.0.1:43123' }
  expect(
    requireAnthropicOAuthOrigin('http://127.0.0.1:43123/v1/messages', options)
      .host,
  ).toBe('127.0.0.1:43123')
  for (const url of [
    'http://127.0.0.1:43124/v1/messages',
    'https://127.0.0.1:43123/v1/messages',
    'blob:http://127.0.0.1:43123/opaque',
    'http://user:pass@127.0.0.1:43123/v1/messages',
  ])
    expect(() => requireAnthropicOAuthOrigin(url, options)).toThrow(
      AnthropicOAuthOriginError,
    )
})

test('the OAuth fetch refuses a foreign URL without dispatch and forces redirect errors', async () => {
  const sent: Array<{ url: string; redirect: RequestInit['redirect'] }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push({ url: String(input), redirect: init?.redirect })
      return new Response('{}')
    },
    { preconnect: originalFetch.preconnect },
  )
  const oauthFetch = createAnthropicOAuthFetch()
  await oauthFetch('https://api.anthropic.com/v1/messages', {
    redirect: 'follow',
  })
  await expect(
    oauthFetch('http://127.0.0.1:9/v1/messages', {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  ).rejects.toThrow(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
  expect(sent).toEqual([
    { url: 'https://api.anthropic.com/v1/messages', redirect: 'error' },
  ])
})

test('relay upstream check refuses a foreign upstream.url before the relay receives anything', async () => {
  const relayed: string[] = []
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      relayed.push(await request.text())
      return new Response('relayed')
    },
  })
  let fallbacks = 0
  try {
    const failure = await sendViaRelay({
      config: {
        enabled: true,
        url: relay.url.href,
        token: 'relay-token',
        fallbackToDirect: true,
        transport: 'http',
      },
      input: 'https://proxy.example.test/v1/messages?beta=true',
      init: { method: 'POST' },
      headers: new Headers({
        'x-session-affinity': 'ses-relay-origin',
        authorization: `Bearer ${SECRET}`,
      }),
      body: JSON.stringify({ messages: ['hello'] }),
      fallback: async () => {
        fallbacks++
        return new Response('direct')
      },
      requireUpstreamUrl: requireAnthropicOAuthOrigin,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AnthropicOAuthOriginError)
    expect(relayed).toEqual([])
    expect(fallbacks).toBe(0)
  } finally {
    relay.stop(true)
  }
})

test('relay upstream check lets the official upstream through to the relay', async () => {
  const relayed: Array<{ upstream: { url: string } }> = []
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      relayed.push(await request.json())
      return new Response('relayed')
    },
  })
  try {
    const response = await sendViaRelay({
      config: {
        enabled: true,
        url: relay.url.href,
        token: 'relay-token',
        fallbackToDirect: false,
        transport: 'http',
      },
      input: 'https://api.anthropic.com/v1/messages?beta=true',
      init: { method: 'POST' },
      headers: new Headers({ 'x-session-affinity': 'ses-relay-official' }),
      body: JSON.stringify({ messages: ['hello'] }),
      fallback: async () => new Response('direct'),
      requireUpstreamUrl: requireAnthropicOAuthOrigin,
    })
    expect(await response.text()).toBe('relayed')
    expect(relayed.map((payload) => payload.upstream.url)).toEqual([
      'https://api.anthropic.com/v1/messages?beta=true',
    ])
  } finally {
    relay.stop(true)
  }
})
