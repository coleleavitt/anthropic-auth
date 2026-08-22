import { describe, expect, test } from 'bun:test'

import { relayWebSocketSessionKey } from '../relay.ts'

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
