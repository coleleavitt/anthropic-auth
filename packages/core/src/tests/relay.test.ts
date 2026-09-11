import { describe, expect, test } from 'bun:test'

import { relayWebSocketSessionKey, sendViaRelay } from '../relay.ts'

describe('relay websocket session keying', () => {
  test('distinguishes different auth material on the same affinity', () => {
    const affinity = 'session-123'
    const oauthA = relayWebSocketSessionKey(
      affinity,
      new Headers({ authorization: 'Bearer token-a' }),
    )
    const oauthB = relayWebSocketSessionKey(
      affinity,
      new Headers({ authorization: 'Bearer token-b' }),
    )
    const api = relayWebSocketSessionKey(
      affinity,
      new Headers({ 'x-api-key': 'key-a' }),
    )

    expect(oauthA).not.toBe(oauthB)
    expect(oauthA).not.toBe(api)
  })

  test('keeps legacy affinity-only key when auth headers are absent', () => {
    expect(relayWebSocketSessionKey('session-123', new Headers())).toBe(
      'session-123',
    )
  })
})

const websocketConfig = {
  enabled: true,
  url: 'https://relay.example.test',
  token: 'relay-token',
  fallbackToDirect: true,
  transport: 'websocket' as const,
}

function relayOptions(
  affinity: string,
  signal: AbortSignal,
  fallback: () => Promise<Response>,
) {
  return {
    config: websocketConfig,
    input: 'https://api.anthropic.com/v1/messages?beta=true',
    init: { method: 'POST', signal },
    headers: new Headers({
      'x-session-affinity': affinity,
      authorization: 'Bearer core-relay-test',
    }),
    body: 'body',
    fallback,
  }
}

describe('persistent relay abort propagation', () => {
  test('aborts a connection wait without HTTP or direct fallback', async () => {
    const originalWebSocket = globalThis.WebSocket
    let closes = 0
    let fallbacks = 0
    class ConnectingWebSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 0
      close() {
        closes++
        this.dispatchEvent(new Event('close'))
      }
    }
    globalThis.WebSocket = ConnectingWebSocket as unknown as typeof WebSocket
    const controller = new AbortController()
    const reason = new DOMException('connect cancelled', 'AbortError')
    try {
      const result = sendViaRelay(
        relayOptions('core-abort-connect', controller.signal, async () => {
          fallbacks++
          return new Response('direct')
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort(reason)
      await expect(result).rejects.toBe(reason)
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
    expect(closes).toBe(1)
    expect(fallbacks).toBe(0)
  })

  test('aborts a pending response, closes the socket, and does not replay', async () => {
    const originalWebSocket = globalThis.WebSocket
    let sends = 0
    let closes = 0
    let fallbacks = 0
    class PendingWebSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 1
      constructor() {
        super()
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          ),
        )
      }
      send() {
        sends++
      }
      close() {
        closes++
      }
    }
    globalThis.WebSocket = PendingWebSocket as unknown as typeof WebSocket
    const controller = new AbortController()
    const reason = new DOMException('pending cancelled', 'AbortError')
    try {
      const result = sendViaRelay(
        relayOptions('core-abort-pending', controller.signal, async () => {
          fallbacks++
          return new Response('direct')
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort(reason)
      await expect(result).rejects.toBe(reason)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
    expect(sends).toBe(1)
    expect(closes).toBe(1)
    expect(fallbacks).toBe(0)
  })

  test('errors an active response stream and closes the socket on abort', async () => {
    const originalWebSocket = globalThis.WebSocket
    let socket: StreamingWebSocket | undefined
    let payloadId = ''
    let closes = 0
    let fallbacks = 0
    class StreamingWebSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 1
      constructor() {
        super()
        socket = this
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          ),
        )
      }
      send(data: string) {
        payloadId = JSON.parse(data).id
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'response_start',
                id: payloadId,
                status: 200,
              }),
            }),
          ),
        )
      }
      close() {
        closes++
      }
    }
    globalThis.WebSocket = StreamingWebSocket as unknown as typeof WebSocket
    const controller = new AbortController()
    const reason = new DOMException('stream cancelled', 'AbortError')
    try {
      const response = await sendViaRelay(
        relayOptions('core-abort-stream', controller.signal, async () => {
          fallbacks++
          return new Response('direct')
        }),
      )
      const text = response.text()
      controller.abort(reason)
      await expect(text).rejects.toBe(reason)
      socket?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'done', id: payloadId }),
        }),
      )
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
    expect(closes).toBe(1)
    expect(fallbacks).toBe(0)
  })

  test('ignores a delayed close from an aborted socket after the next request starts', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sockets: SequencedWebSocket[] = []
    let fallbacks = 0
    class SequencedWebSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 1
      sends = 0
      payloadId = ''
      constructor() {
        super()
        sockets.push(this)
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          ),
        )
      }
      send(data: string) {
        this.sends++
        this.payloadId = JSON.parse(data).id
      }
      close() {
        this.readyState = 2
        // Delay the close event so a successor request can install its socket.
      }
    }
    globalThis.WebSocket = SequencedWebSocket as unknown as typeof WebSocket
    const firstAbort = new AbortController()
    try {
      const first = sendViaRelay(
        relayOptions('core-abort-stale-close', firstAbort.signal, async () => {
          fallbacks++
          return new Response('direct')
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      firstAbort.abort(new DOMException('first cancelled', 'AbortError'))
      await expect(first).rejects.toBeInstanceOf(DOMException)

      const second = sendViaRelay(
        relayOptions(
          'core-abort-stale-close',
          new AbortController().signal,
          async () => {
            fallbacks++
            return new Response('direct')
          },
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sockets).toHaveLength(2)
      expect(sockets[1]?.sends).toBe(1)

      sockets[0]?.dispatchEvent(new CloseEvent('close'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sockets).toHaveLength(2)
      expect(sockets[1]?.sends).toBe(1)
      expect(fallbacks).toBe(0)

      // Settle the successor so its queued promise does not leak past the test.
      const current = sockets[1]
      current?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'response_start',
            id: current.payloadId,
            status: 200,
          }),
        }),
      )
      current?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'done', id: current.payloadId }),
        }),
      )
      expect((await second).status).toBe(200)
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })
})
