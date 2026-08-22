import { describe, expect, test } from 'bun:test'
import { verify as cryptoVerify } from 'node:crypto'

import {
  buildCoworkBindingFields,
  buildCreateSessionBindPreimage,
  COWORK_OAUTH_BETA,
  CREATE_SESSION_BIND_DOMAIN,
  createCoworkBindingFields,
  DEVICE_REGISTRY_KID_PREFIX,
  exportCoworkDeviceKeyPair,
  exportCoworkPrivateKeyPkcs8Base64,
  exportCoworkPublicKeySpkiBase64,
  generateCoworkDeviceKeyPair,
  importCoworkDeviceKeyPair,
  importCoworkPrivateKeyPkcs8Base64,
  importCoworkPublicKeySpkiBase64,
  loadCoworkDeviceKeyPair,
  registerCoworkRemoteDevice,
  saveCoworkDeviceKeyPair,
  signCreateSessionBind,
} from '../cowork-binding.ts'

const ORG_UUID = '00112233-4455-6677-8899-aabbccddeeff'
const ACCOUNT_UUID = '10213243-5465-7687-98a9-bacbdcedfe0f'
const DEVICE_UUID = 'ffeeddcc-bbaa-9988-7766-554433221100'

describe('Cowork software device keys', () => {
  test('uses stable PKCS#8/SPKI DER and secure-store round trips', async () => {
    const generated = generateCoworkDeviceKeyPair()
    expect(generated.isHardwareBacked).toBe(false)
    const serialized = exportCoworkDeviceKeyPair(generated)

    expect(serialized.privateKeyPkcs8B64).toBe(
      exportCoworkPrivateKeyPkcs8Base64(generated.privateKey),
    )
    expect(serialized.publicKeySpkiB64).toBe(
      exportCoworkPublicKeySpkiBase64(generated.publicKey),
    )
    expect(Buffer.from(serialized.privateKeyPkcs8B64, 'base64')[0]).toBe(0x30)
    expect(Buffer.from(serialized.publicKeySpkiB64, 'base64')[0]).toBe(0x30)

    const imported = importCoworkDeviceKeyPair(serialized)
    expect(exportCoworkDeviceKeyPair(imported)).toEqual(serialized)
    expect(
      exportCoworkPrivateKeyPkcs8Base64(
        importCoworkPrivateKeyPkcs8Base64(serialized.privateKeyPkcs8B64),
      ),
    ).toBe(serialized.privateKeyPkcs8B64)
    expect(
      exportCoworkPublicKeySpkiBase64(
        importCoworkPublicKeySpkiBase64(serialized.publicKeySpkiB64),
      ),
    ).toBe(serialized.publicKeySpkiB64)

    let stored: string | null = null
    const store = {
      read: async () => stored,
      write: async (value: string) => {
        stored = value
      },
      delete: async () => {
        const existed = stored !== null
        stored = null
        return existed
      },
    }
    await saveCoworkDeviceKeyPair({
      accountId: 'account',
      keyPair: generated,
      store,
    })
    expect(stored).not.toContain('[object KeyObject]')
    const restored = await loadCoworkDeviceKeyPair({
      accountId: 'account',
      store,
    })
    expect(restored?.isHardwareBacked).toBe(false)
    expect(exportCoworkDeviceKeyPair(restored!)).toEqual(serialized)
  })
})

describe('Cowork remote device registration', () => {
  test('matches the exact registration wire contract', async () => {
    const keyPair = generateCoworkDeviceKeyPair()
    const publicKey = exportCoworkPublicKeySpkiBase64(keyPair.publicKey)
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      capturedUrl = String(url)
      capturedInit = init
      return Response.json(
        { id: DEVICE_UUID.toUpperCase(), revoked_at: null },
        { status: 201 },
      )
    }) as unknown as typeof fetch

    const registered = await registerCoworkRemoteDevice({
      orgUUID: ORG_UUID,
      accessToken: 'oauth-secret',
      displayName: 'Claude Code on test-host · linux',
      platform: 'linux',
      publicKey: keyPair.publicKey,
      baseUrl: 'http://localhost:8787/ignored',
      fetchImpl,
    })

    expect(capturedUrl).toBe(
      `http://localhost:8787/api/organizations/${ORG_UUID}/cowork/remote_devices`,
    )
    expect(capturedInit?.method).toBe('POST')
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer oauth-secret')
    expect(headers.get('anthropic-beta')).toBe(COWORK_OAUTH_BETA)
    expect(headers.get('content-type')).toBe('application/json')
    expect(await new Response(capturedInit?.body).json()).toEqual({
      display_name: 'Claude Code on test-host · linux',
      platform: 'linux',
      public_key: publicKey,
    })
    expect(registered).toEqual({ deviceUUID: DEVICE_UUID })
  })

  test('requires HTTP 201, a valid UUID, and absent or null revoked_at', async () => {
    const publicKey = generateCoworkDeviceKeyPair().publicKey
    const registerWith = (body: unknown, status = 201) =>
      registerCoworkRemoteDevice({
        orgUUID: ORG_UUID,
        accessToken: 'oauth-secret',
        displayName: 'test device',
        platform: 'linux',
        publicKey,
        baseUrl: 'http://127.0.0.1:8787',
        fetchImpl: (async () =>
          Response.json(body, { status })) as unknown as typeof fetch,
      })

    await expect(registerWith({ id: DEVICE_UUID }, 200)).rejects.toMatchObject({
      code: 'http_error',
      status: 200,
    })
    await expect(registerWith({ id: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(
      registerWith({ id: DEVICE_UUID, revoked_at: '2026-08-15T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'key_revoked' })

    await expect(registerWith({ id: DEVICE_UUID })).resolves.toEqual({
      deviceUUID: DEVICE_UUID,
    })
    await expect(
      registerWith({ id: DEVICE_UUID, revoked_at: null }),
    ).resolves.toEqual({ deviceUUID: DEVICE_UUID })
  })

  test('rejects non-loopback HTTP before invoking fetch', async () => {
    let called = false
    await expect(
      registerCoworkRemoteDevice({
        orgUUID: ORG_UUID,
        accessToken: 'oauth-secret',
        displayName: 'test device',
        publicKey: generateCoworkDeviceKeyPair().publicKey,
        baseUrl: 'http://api.example.test',
        fetchImpl: (async () => {
          called = true
          return Response.json({ id: DEVICE_UUID }, { status: 201 })
        }) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid_url' })
    expect(called).toBe(false)
  })
})

describe('Cowork create-session binding', () => {
  test('builds the exact domain + UUID bytes + U64_BE preimage', () => {
    const timestamp = 0x0102_0304_0506_0708n
    const timestampBytes = Buffer.alloc(8)
    timestampBytes.writeBigUInt64BE(timestamp)
    const expected = Buffer.concat([
      Buffer.from(CREATE_SESSION_BIND_DOMAIN, 'utf8'),
      Buffer.from(ORG_UUID.replaceAll('-', ''), 'hex'),
      Buffer.from(ACCOUNT_UUID.replaceAll('-', ''), 'hex'),
      Buffer.from(DEVICE_UUID.replaceAll('-', ''), 'hex'),
      timestampBytes,
    ])

    const actual = buildCreateSessionBindPreimage(
      ORG_UUID,
      ACCOUNT_UUID,
      DEVICE_UUID,
      timestamp,
    )
    expect(actual).toEqual(expected)
    expect(actual.subarray(-8).toString('hex')).toBe('0102030405060708')
  })

  test('signs SHA-256 as fixed 64-byte IEEE-P1363 and maps exact body fields', () => {
    const keyPair = generateCoworkDeviceKeyPair()
    const issuedAtMs = 1_700_000_000_123
    const signed = signCreateSessionBind(
      ORG_UUID,
      ACCOUNT_UUID,
      DEVICE_UUID,
      keyPair.privateKey,
      issuedAtMs,
    )
    const signature = Buffer.from(signed.signature, 'base64')
    const preimage = buildCreateSessionBindPreimage(
      ORG_UUID,
      ACCOUNT_UUID,
      DEVICE_UUID,
      issuedAtMs,
    )

    expect(signature.length).toBe(64)
    expect(signature.toString('base64')).toBe(signed.signature)
    expect(
      cryptoVerify(
        'sha256',
        preimage,
        { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true)
    expect(signed.kid).toBe(`${DEVICE_REGISTRY_KID_PREFIX}${DEVICE_UUID}`)
    expect(signed.issuedAt).toBe('2023-11-14T22:13:20.123Z')
    expect(signed.issuedAt).toMatch(/\.\d{3}Z$/)

    const expectedFields = {
      target_device_id: DEVICE_UUID,
      bind_attestation: {
        kid: `creg_${DEVICE_UUID}`,
        signature: signed.signature,
      },
      bind_attestation_issued_at: '2023-11-14T22:13:20.123Z',
    }
    expect(buildCoworkBindingFields(signed)).toEqual(expectedFields)
    expect(
      createCoworkBindingFields(
        ORG_UUID,
        ACCOUNT_UUID,
        DEVICE_UUID,
        keyPair.privateKey,
        issuedAtMs,
      ),
    ).toMatchObject({
      target_device_id: DEVICE_UUID,
      bind_attestation: { kid: `creg_${DEVICE_UUID}` },
      bind_attestation_issued_at: '2023-11-14T22:13:20.123Z',
    })
  })
})
