import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  CLAUDE_TRUSTED_DEVICE_TOKEN_ENV,
  enrollTrustedDevice,
  resolveTrustedDeviceToken,
  TRUSTED_DEVICE_HEADER,
  TrustedDeviceEnrollmentError,
  TrustedDeviceToken,
  trustedDeviceHeadersForCowork,
  trustedDeviceHeadersForRemoteControl,
} from '../trusted-device.ts'

describe('trusted device enrollment', () => {
  test('matches the Claude Code enrollment wire contract', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      capturedUrl = String(url)
      capturedInit = init
      return Response.json(
        { device_token: 'trusted-device-secret', device_id: 'device-123' },
        { status: 201 },
      )
    }) as unknown as typeof fetch

    const enrollment = await enrollTrustedDevice({
      accessToken: 'oauth-secret',
      displayName: 'Claude Code on test-host · linux',
      baseUrl: 'http://127.0.0.1:8787/a/path?ignored=yes',
      fetchImpl,
    })

    expect(capturedUrl).toBe('http://127.0.0.1:8787/api/auth/trusted_devices')
    expect(capturedInit?.method).toBe('POST')
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer oauth-secret')
    expect(headers.get('content-type')).toBe('application/json')
    expect(await new Response(capturedInit?.body).json()).toEqual({
      display_name: 'Claude Code on test-host · linux',
    })
    expect(enrollment.deviceId).toBe('device-123')

    expect(String(enrollment.deviceToken)).toBe('[REDACTED]')
    expect(inspect(enrollment.deviceToken)).toBe(
      'TrustedDeviceToken([REDACTED])',
    )
    expect(Object.keys(enrollment.deviceToken)).toEqual([])
    expect(JSON.stringify(enrollment)).toBe('{"deviceId":"device-123"}')
    expect(JSON.stringify(enrollment)).not.toContain('trusted-device-secret')
  })

  test('accepts HTTP 200 and an omitted device_id', async () => {
    const enrollment = await enrollTrustedDevice({
      accessToken: 'oauth-secret',
      displayName: 'test device',
      fetchImpl: (async () =>
        Response.json(
          { device_token: 'trusted-device-secret' },
          { status: 200 },
        )) as unknown as typeof fetch,
    })

    expect(enrollment.deviceId).toBeUndefined()
    expect(JSON.stringify(enrollment)).toBe('{}')
  })

  test('allows HTTP only on loopback', async () => {
    let called = false
    await expect(
      enrollTrustedDevice({
        accessToken: 'oauth-secret',
        displayName: 'test device',
        baseUrl: 'http://api.example.test',
        fetchImpl: (async () => {
          called = true
          return Response.json({ device_token: 'never-used' })
        }) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid_url' })
    expect(called).toBe(false)

    await enrollTrustedDevice({
      accessToken: 'oauth-secret',
      displayName: 'test device',
      baseUrl: 'http://[::1]:8787',
      fetchImpl: (async () =>
        Response.json({
          device_token: 'loopback-secret',
        })) as unknown as typeof fetch,
    })
  })

  test('bounds and redacts HTTP response errors', async () => {
    const oauthSecret = 'sk-ant-oat01-super-secret'
    let error: unknown
    try {
      await enrollTrustedDevice({
        accessToken: oauthSecret,
        displayName: 'test device',
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              device_token: 'returned-device-secret',
              authorization: `Bearer ${oauthSecret}`,
              detail: 'x'.repeat(2_000),
            }),
            { status: 403 },
          )) as unknown as typeof fetch,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TrustedDeviceEnrollmentError)
    expect(error).toMatchObject({ code: 'http_error', status: 403 })
    const message = (error as Error).message
    expect(message.length).toBeLessThanOrEqual(512)
    expect(message).not.toContain(oauthSecret)
    expect(message).not.toContain('returned-device-secret')
    expect(message).toContain('[REDACTED]')
  })

  test('bounds and redacts thrown request errors', async () => {
    const oauthSecret = 'oauth-secret-that-must-not-leak'
    let error: unknown
    try {
      await enrollTrustedDevice({
        accessToken: oauthSecret,
        displayName: 'test device',
        fetchImpl: (async () => {
          throw new Error(`${oauthSecret}:${'y'.repeat(2_000)}`)
        }) as unknown as typeof fetch,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TrustedDeviceEnrollmentError)
    const message = (error as Error).message
    expect(message.length).toBeLessThanOrEqual(512)
    expect(message).not.toContain(oauthSecret)
    expect(message).toContain('[REDACTED]')
  })
})

describe('trusted device token resolution and explicit headers', () => {
  test('gives CLAUDE_TRUSTED_DEVICE_TOKEN precedence over stored state', () => {
    const token = resolveTrustedDeviceToken({
      env: { [CLAUDE_TRUSTED_DEVICE_TOKEN_ENV]: 'environment-secret' },
      storedToken: 'stored-secret',
    })

    expect(trustedDeviceHeadersForRemoteControl(token)).toEqual({
      [TRUSTED_DEVICE_HEADER]: 'environment-secret',
    })
    expect(String(token)).toBe('[REDACTED]')
  })

  test('measures the trusted-device token limit in UTF-8 bytes', () => {
    expect(() => TrustedDeviceToken.from('é'.repeat(9_000))).toThrow('16 KiB')
  })

  test('falls back to storage and exposes the secret only via explicit Remote Control/Cowork helpers', () => {
    const token = resolveTrustedDeviceToken({
      env: {},
      storedToken: 'stored-secret',
    })

    expect(JSON.stringify({ token })).toBe('{}')
    expect(trustedDeviceHeadersForRemoteControl(token)).toEqual({
      [TRUSTED_DEVICE_HEADER]: 'stored-secret',
    })
    expect(trustedDeviceHeadersForCowork(token)).toEqual({
      [TRUSTED_DEVICE_HEADER]: 'stored-secret',
    })
    expect(trustedDeviceHeadersForCowork(undefined)).toEqual({})
  })
})
