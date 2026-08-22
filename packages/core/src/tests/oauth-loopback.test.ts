import { describe, expect, test } from 'bun:test'
import { connect } from 'node:net'

import {
  OAuthLoopbackError,
  startOAuthLoopbackSession,
} from '../oauth-loopback.ts'

function connectURL(redirectUri: string, query = '') {
  return `${redirectUri.replace('localhost', '127.0.0.1')}${query}`
}

async function closeQuietly(
  session: Awaited<ReturnType<typeof startOAuthLoopbackSession>>,
) {
  await session.close().catch(() => {})
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(request))
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}

describe('OAuth loopback session', () => {
  test('binds IPv4 loopback, advertises localhost, and completes one callback', async () => {
    const session = await startOAuthLoopbackSession({ state: 'expected-state' })
    try {
      expect(session.redirectUri).toBe(
        `http://localhost:${session.port}/callback`,
      )
      const response = await fetch(
        connectURL(
          session.redirectUri,
          '?code=authorization-code&state=expected-state',
        ),
        { redirect: 'manual' },
      )
      const page = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      )
      expect(page).toContain('Authentication complete')
      expect(page).not.toContain('authorization-code')
      expect(page).not.toContain('expected-state')
      expect(await session.waitForCallback()).toEqual({
        code: 'authorization-code',
        state: 'expected-state',
        source: 'loopback',
      })
    } finally {
      await closeQuietly(session)
    }
  })

  test('rejects non-exact methods, paths, duplicate queries, missing values, and wrong states without consuming the flow', async () => {
    const session = await startOAuthLoopbackSession({ state: 'right-state' })
    try {
      const cases: Array<{ path: string; init?: RequestInit; status: number }> =
        [
          {
            path: '?code=code&state=right-state',
            init: { method: 'POST' },
            status: 405,
          },
          {
            path: '/?code=code&state=right-state',
            status: 404,
          },
          {
            path: '?code=one&code=two&state=right-state',
            status: 400,
          },
          {
            path: '?code=code&state=right-state&state=right-state',
            status: 400,
          },
          { path: '?state=right-state', status: 400 },
          { path: '?code=code', status: 400 },
          { path: '?code=code&state=x', status: 400 },
          { path: '?code=code&state=a-different-length-state', status: 400 },
        ]

      for (const testCase of cases) {
        const base = connectURL(session.redirectUri)
        const url = testCase.path.startsWith('/')
          ? `${base}/${testCase.path}`
          : `${base}${testCase.path}`
        const response = await fetch(url, testCase.init)
        const page = await response.text()
        expect(response.status).toBe(testCase.status)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(page).toContain('Authentication failed')
        expect(page).not.toContain('right-state')
        expect(page).not.toContain('code=')
      }

      const valid = await fetch(
        connectURL(session.redirectUri, '?code=good&state=right-state'),
      )
      expect(valid.status).toBe(200)
      await valid.text()
      expect(await session.result).toMatchObject({ code: 'good' })
    } finally {
      await closeQuietly(session)
    }
  })

  test('enforces a strict 16 KiB parser bound while leaving the flow pending', async () => {
    const session = await startOAuthLoopbackSession({ state: 'bounded-state' })
    try {
      const oversized = await rawRequest(
        session.port,
        `GET /callback?code=bad&state=bounded-state HTTP/1.1\r\nHost: localhost:${session.port}\r\nX-Fill: ${'x'.repeat(17 * 1024)}\r\n\r\n`,
      )
      expect(oversized).toMatch(/^HTTP\/1\.1 431 /)
      expect(oversized).not.toContain('bounded-state')
      expect(oversized).not.toContain('code=bad')

      const response = await fetch(
        connectURL(session.redirectUri, '?code=good&state=bounded-state'),
      )
      await response.text()
      expect(await session.result).toMatchObject({ code: 'good' })
    } finally {
      await closeQuietly(session)
    }
  })

  test('supports a manual CLI/TUI fallback and rejects a second completion', async () => {
    const session = await startOAuthLoopbackSession({ state: 'manual-state' })
    try {
      expect(
        session.submitManualCallback({
          code: 'manual-code',
          state: 'manual-state',
        }),
      ).toEqual({
        code: 'manual-code',
        state: 'manual-state',
        source: 'manual',
      })
      expect(await session.result).toMatchObject({ source: 'manual' })
      expect(() =>
        session.submitManualCallback({
          code: 'second',
          state: 'manual-state',
        }),
      ).toThrow('no longer pending')
    } finally {
      await closeQuietly(session)
    }
  })

  test('valid-state OAuth errors use a static page and reject the pending flow', async () => {
    const session = await startOAuthLoopbackSession({ state: 'error-state' })
    try {
      const response = await fetch(
        connectURL(
          session.redirectUri,
          '?error=access_denied&error_description=do-not-render&state=error-state',
        ),
      )
      const page = await response.text()
      expect(response.status).toBe(400)
      expect(page).toContain('Authentication failed')
      expect(page).not.toContain('access_denied')
      expect(page).not.toContain('do-not-render')
      await expect(session.result).rejects.toMatchObject({
        code: 'oauth_error',
      })
    } finally {
      await closeQuietly(session)
    }
  })

  test('rejects a pre-aborted start without opening a listener', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      startOAuthLoopbackSession({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  test('times out idle connections, supports cancellation, and applies an overall timeout', async () => {
    const connectionSession = await startOAuthLoopbackSession({
      state: 'connection-state',
      connectionTimeoutMs: 25,
      overallTimeoutMs: 5_000,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(connectionSession.port, '127.0.0.1')
        socket.once('connect', () => {})
        socket.once('close', () => resolve())
        socket.once('error', reject)
      })
      connectionSession.cancel()
      await expect(connectionSession.result).rejects.toBeInstanceOf(
        OAuthLoopbackError,
      )
    } finally {
      await closeQuietly(connectionSession)
    }

    const overallSession = await startOAuthLoopbackSession({
      state: 'overall-state',
      overallTimeoutMs: 25,
    })
    try {
      await expect(overallSession.result).rejects.toMatchObject({
        code: 'timed_out',
      })
      await overallSession.closed
    } finally {
      await closeQuietly(overallSession)
    }
  })
})
