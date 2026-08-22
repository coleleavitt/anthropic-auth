import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
  timingSafeEqual,
} from 'node:crypto'
import { join } from 'node:path'

import {
  type DeviceIdentityPathOptions,
  getDeviceIdentityDirectory,
} from './device-identity.ts'
import {
  FileSecureSecretStore,
  type SecureSecretStore,
} from './secure-secret-store.ts'

export const COWORK_REMOTE_DEVICE_PATH =
  '/api/organizations/:orgUUID/cowork/remote_devices' as const
export const COWORK_OAUTH_BETA = 'oauth-2025-04-20' as const
export const DEVICE_REGISTRY_KID_PREFIX = 'creg_' as const
export const CREATE_SESSION_BIND_DOMAIN =
  'anthropic.ccr.create_session_bind.v1' as const

const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_LENGTH = 64 * 1024
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREATE_SESSION_BIND_DOMAIN_BYTES = Buffer.from(
  CREATE_SESSION_BIND_DOMAIN,
  'utf8',
)

export type CoworkDeviceKeyPair = {
  privateKey: KeyObject
  publicKey: KeyObject
  /** Software fallback; never claim Secure Enclave/TPM attestation. */
  isHardwareBacked: false
}

export type SerializedCoworkDeviceKeyPair = {
  privateKeyPkcs8B64: string
  publicKeySpkiB64: string
}

export type RegisteredCoworkRemoteDevice = {
  deviceUUID: string
}

export type CoworkRemoteDeviceRegistrationErrorCode =
  | 'invalid_input'
  | 'invalid_url'
  | 'request_failed'
  | 'http_error'
  | 'invalid_response'
  | 'key_revoked'

export class CoworkRemoteDeviceRegistrationError extends Error {
  constructor(
    public readonly code: CoworkRemoteDeviceRegistrationErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'CoworkRemoteDeviceRegistrationError'
  }
}

export type CreateSessionBindSignature = {
  deviceUUID: string
  kid: string
  signature: string
  issuedAt: string
}

export type CoworkBindingFields = {
  target_device_id: string
  bind_attestation: {
    kid: string
    signature: string
  }
  bind_attestation_issued_at: string
}

/** Generates a software-backed P-256 key pair. */
export function generateCoworkDeviceKeyPair(): CoworkDeviceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  return { privateKey, publicKey, isHardwareBacked: false }
}

/** Exports a P-256 private key as standard Base64 of PKCS#8 DER. */
export function exportCoworkPrivateKeyPkcs8Base64(
  privateKey: KeyObject,
): string {
  assertP256Key(privateKey, 'private')
  return Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'der' }),
  ).toString('base64')
}

/** Imports and validates standard Base64 PKCS#8 DER as a P-256 private key. */
export function importCoworkPrivateKeyPkcs8Base64(value: string): KeyObject {
  const privateKey = createPrivateKey({
    key: decodeStandardBase64(value, 'private key'),
    format: 'der',
    type: 'pkcs8',
  })
  assertP256Key(privateKey, 'private')
  return privateKey
}

/** Exports a P-256 public key as standard Base64 of SPKI DER. */
export function exportCoworkPublicKeySpkiBase64(publicKey: KeyObject): string {
  const normalized =
    publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey
  assertP256Key(normalized, 'public')
  return Buffer.from(
    normalized.export({ type: 'spki', format: 'der' }),
  ).toString('base64')
}

/** Imports and validates standard Base64 SPKI DER as a P-256 public key. */
export function importCoworkPublicKeySpkiBase64(value: string): KeyObject {
  const publicKey = createPublicKey({
    key: decodeStandardBase64(value, 'public key'),
    format: 'der',
    type: 'spki',
  })
  assertP256Key(publicKey, 'public')
  return publicKey
}

export function exportCoworkDeviceKeyPair(
  keyPair: CoworkDeviceKeyPair,
): SerializedCoworkDeviceKeyPair {
  assertMatchingKeyPair(keyPair.privateKey, keyPair.publicKey)
  return {
    privateKeyPkcs8B64: exportCoworkPrivateKeyPkcs8Base64(keyPair.privateKey),
    publicKeySpkiB64: exportCoworkPublicKeySpkiBase64(keyPair.publicKey),
  }
}

export function importCoworkDeviceKeyPair(
  serialized: SerializedCoworkDeviceKeyPair,
): CoworkDeviceKeyPair {
  const privateKey = importCoworkPrivateKeyPkcs8Base64(
    serialized.privateKeyPkcs8B64,
  )
  const publicKey = importCoworkPublicKeySpkiBase64(serialized.publicKeySpkiB64)
  assertMatchingKeyPair(privateKey, publicKey)
  return { privateKey, publicKey, isHardwareBacked: false }
}

export function getCoworkDeviceKeyStorePath(
  accountId: string,
  options: DeviceIdentityPathOptions = {},
) {
  const normalized = accountId.trim()
  if (!normalized) throw new TypeError('Cowork account id is required')
  const key = createHash('sha256').update(normalized).digest('hex').slice(0, 32)
  return join(
    getDeviceIdentityDirectory(options),
    'secrets',
    `cowork-device-${key}`,
  )
}

export async function saveCoworkDeviceKeyPair(input: {
  accountId: string
  keyPair: CoworkDeviceKeyPair
  pathOptions?: DeviceIdentityPathOptions
  store?: SecureSecretStore
}) {
  const serialized = exportCoworkDeviceKeyPair(input.keyPair)
  const store =
    input.store ??
    new FileSecureSecretStore(
      getCoworkDeviceKeyStorePath(input.accountId, input.pathOptions),
      { maxBytes: 16 * 1024 },
    )
  await store.write(JSON.stringify(serialized))
}

export async function loadCoworkDeviceKeyPair(input: {
  accountId: string
  pathOptions?: DeviceIdentityPathOptions
  store?: Pick<SecureSecretStore, 'read'>
}) {
  const store =
    input.store ??
    new FileSecureSecretStore(
      getCoworkDeviceKeyStorePath(input.accountId, input.pathOptions),
      { maxBytes: 16 * 1024 },
    )
  const raw = await store.read()
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new TypeError('Stored Cowork device key is invalid')
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.privateKeyPkcs8B64 !== 'string' ||
    typeof parsed.publicKeySpkiB64 !== 'string'
  ) {
    throw new TypeError('Stored Cowork device key is invalid')
  }
  return importCoworkDeviceKeyPair({
    privateKeyPkcs8B64: parsed.privateKeyPkcs8B64,
    publicKeySpkiB64: parsed.publicKeySpkiB64,
  })
}

export async function deleteCoworkDeviceKeyPair(input: {
  accountId: string
  pathOptions?: DeviceIdentityPathOptions
  store?: Pick<SecureSecretStore, 'delete'>
}) {
  const store =
    input.store ??
    new FileSecureSecretStore(
      getCoworkDeviceKeyStorePath(input.accountId, input.pathOptions),
      { maxBytes: 16 * 1024 },
    )
  return store.delete()
}

export async function registerCoworkRemoteDevice(input: {
  orgUUID: string
  accessToken: string
  displayName: string
  platform?: string
  publicKey?: KeyObject | string
  publicKeySpkiB64?: string
  baseUrl?: string | URL
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<RegisteredCoworkRemoteDevice> {
  const orgUUID = normalizeUuid(input.orgUUID, 'organization UUID')
  if (typeof input.accessToken !== 'string' || input.accessToken.length === 0) {
    throw registrationError(
      'invalid_input',
      'Cowork device registration requires a non-empty OAuth access token',
    )
  }
  const displayName = input.displayName?.trim()
  if (!displayName || displayName.length > 255) {
    throw registrationError(
      'invalid_input',
      'Cowork device registration display name must be between 1 and 255 characters',
    )
  }
  const platform = input.platform ?? process.platform
  if (
    typeof platform !== 'string' ||
    platform.length === 0 ||
    platform.length > 64
  ) {
    throw registrationError(
      'invalid_input',
      'Cowork device registration requires a non-empty platform',
    )
  }
  if (input.publicKey !== undefined && input.publicKeySpkiB64 !== undefined) {
    throw registrationError(
      'invalid_input',
      'Cowork device registration accepts only one public key input',
    )
  }

  const suppliedPublicKey = input.publicKey ?? input.publicKeySpkiB64
  if (suppliedPublicKey === undefined) {
    throw registrationError(
      'invalid_input',
      'Cowork device registration requires a public key',
    )
  }

  let publicKey: string
  try {
    publicKey =
      typeof suppliedPublicKey === 'string'
        ? exportCoworkPublicKeySpkiBase64(
            importCoworkPublicKeySpkiBase64(suppliedPublicKey),
          )
        : exportCoworkPublicKeySpkiBase64(suppliedPublicKey)
  } catch {
    throw registrationError(
      'invalid_input',
      'Cowork device registration requires a P-256 SPKI public key',
    )
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw registrationError(
      'invalid_input',
      'Cowork device registration timeout must be positive',
    )
  }
  const url = coworkRegistrationUrl(
    input.baseUrl ?? DEFAULT_API_BASE_URL,
    orgUUID,
  )
  const request = createRequestSignal(input.signal, timeoutMs)

  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': COWORK_OAUTH_BETA,
      },
      body: JSON.stringify({
        display_name: displayName,
        platform,
        public_key: publicKey,
      }),
      signal: request.signal,
    })
  } catch {
    throw registrationError(
      'request_failed',
      request.timedOut()
        ? 'Cowork device registration request timed out'
        : 'Cowork device registration request failed',
    )
  } finally {
    request.cleanup()
  }

  const { text: responseText, truncated } =
    await readBoundedRegistrationResponse(response)
  if (response.status !== 201) {
    throw registrationError(
      'http_error',
      `Cowork device registration failed with HTTP ${response.status}`,
      response.status,
    )
  }
  if (truncated) {
    throw registrationError(
      'invalid_response',
      'Cowork device registration returned an oversized response',
      response.status,
    )
  }

  let body: unknown
  try {
    body = JSON.parse(responseText)
  } catch {
    throw registrationError(
      'invalid_response',
      'Cowork device registration returned invalid JSON',
      response.status,
    )
  }
  if (!isRecord(body)) {
    throw registrationError(
      'invalid_response',
      'Cowork device registration returned an invalid response',
      response.status,
    )
  }
  if (body.revoked_at !== undefined && body.revoked_at !== null) {
    throw registrationError(
      'key_revoked',
      'Cowork device registration returned a revoked device',
      response.status,
    )
  }
  if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
    throw registrationError(
      'invalid_response',
      'Cowork device registration response is missing a valid device UUID',
      response.status,
    )
  }

  return { deviceUUID: body.id.toLowerCase() }
}

/**
 * domain UTF-8 || org UUID bytes || account UUID bytes || device UUID bytes ||
 * unsigned 64-bit big-endian timestamp milliseconds.
 */
export function buildCreateSessionBindPreimage(
  orgUUID: string,
  accountUUID: string,
  deviceUUID: string,
  issuedAtMs: number | bigint,
): Buffer {
  const timestamp = normalizeU64(issuedAtMs)
  const preimage = Buffer.alloc(
    CREATE_SESSION_BIND_DOMAIN_BYTES.length + 16 * 3 + 8,
  )
  let offset = 0
  offset += CREATE_SESSION_BIND_DOMAIN_BYTES.copy(preimage, offset)
  offset += uuidBytes(orgUUID).copy(preimage, offset)
  offset += uuidBytes(accountUUID).copy(preimage, offset)
  offset += uuidBytes(deviceUUID).copy(preimage, offset)
  preimage.writeBigUInt64BE(timestamp, offset)
  return preimage
}

/** Signs a create-session binding with ECDSA/SHA-256 in fixed P1363 form. */
export function signCreateSessionBind(
  orgUUID: string,
  accountUUID: string,
  deviceUUID: string,
  privateKey: KeyObject | string,
  issuedAtMs = Date.now(),
): CreateSessionBindSignature {
  const normalizedPrivateKey =
    typeof privateKey === 'string'
      ? importCoworkPrivateKeyPkcs8Base64(privateKey)
      : privateKey
  assertP256Key(normalizedPrivateKey, 'private')
  const preimage = buildCreateSessionBindPreimage(
    orgUUID,
    accountUUID,
    deviceUUID,
    issuedAtMs,
  )
  const signature = cryptoSign('sha256', preimage, {
    key: normalizedPrivateKey,
    dsaEncoding: 'ieee-p1363',
  })
  if (signature.length !== 64) {
    throw new Error('Cowork binding signature was not 64-byte IEEE-P1363')
  }

  const issuedAt = new Date(issuedAtMs).toISOString()
  return {
    deviceUUID,
    kid: `${DEVICE_REGISTRY_KID_PREFIX}${deviceUUID}`,
    signature: signature.toString('base64'),
    issuedAt,
  }
}

/** Maps a signature to the exact create-session request fields. */
export function buildCoworkBindingFields(
  binding: CreateSessionBindSignature,
): CoworkBindingFields {
  return {
    target_device_id: binding.deviceUUID,
    bind_attestation: {
      kid: binding.kid,
      signature: binding.signature,
    },
    bind_attestation_issued_at: binding.issuedAt,
  }
}

/** Signs and maps a binding in one operation. */
export function createCoworkBindingFields(
  orgUUID: string,
  accountUUID: string,
  deviceUUID: string,
  privateKey: KeyObject | string,
  issuedAtMs = Date.now(),
): CoworkBindingFields {
  return buildCoworkBindingFields(
    signCreateSessionBind(
      orgUUID,
      accountUUID,
      deviceUUID,
      privateKey,
      issuedAtMs,
    ),
  )
}

function assertMatchingKeyPair(
  privateKey: KeyObject,
  publicKey: KeyObject,
): void {
  assertP256Key(privateKey, 'private')
  assertP256Key(publicKey, 'public')
  const derived = Buffer.from(
    createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
  )
  const supplied = Buffer.from(
    publicKey.export({ type: 'spki', format: 'der' }),
  )
  if (
    derived.length !== supplied.length ||
    !timingSafeEqual(derived, supplied)
  ) {
    throw new TypeError('Cowork public key does not match the private key')
  }
}

function assertP256Key(
  key: KeyObject,
  expectedType: 'private' | 'public',
): void {
  if (
    key.type !== expectedType ||
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new TypeError(`Cowork ${expectedType} key must be P-256`)
  }
}

function decodeStandardBase64(value: string, label: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new TypeError(`Cowork ${label} must be standard Base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new TypeError(`Cowork ${label} must be canonical standard Base64`)
  }
  return decoded
}

function uuidBytes(value: string): Buffer {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`Malformed UUID '${value}'`)
  }
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

function normalizeUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw registrationError('invalid_input', `Cowork ${label} is malformed`)
  }
  return value.toLowerCase()
}

function normalizeU64(value: number | bigint): bigint {
  let normalized: bigint
  if (typeof value === 'bigint') normalized = value
  else {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        'Cowork binding timestamp must be a safe U64 integer',
      )
    }
    normalized = BigInt(value)
  }
  if (normalized < 0n || normalized > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('Cowork binding timestamp is outside U64 range')
  }
  return normalized
}

async function readBoundedRegistrationResponse(response: Response) {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  while (size < MAX_RESPONSE_LENGTH) {
    const chunk = await reader.read().catch(() => null)
    if (!chunk) return { text: '', truncated: false }
    if (chunk.done) {
      text += decoder.decode()
      return { text, truncated: false }
    }
    const remaining = MAX_RESPONSE_LENGTH - size
    const bytes = chunk.value.subarray(0, remaining)
    size += bytes.byteLength
    text += decoder.decode(bytes, { stream: true })
    if (chunk.value.byteLength > remaining || size === MAX_RESPONSE_LENGTH) {
      await reader.cancel().catch(() => {})
      text += decoder.decode()
      return { text, truncated: true }
    }
  }
  return { text, truncated: true }
}

function coworkRegistrationUrl(baseUrl: string | URL, orgUUID: string): URL {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw registrationError(
      'invalid_url',
      'Cowork device registration requires a valid API base URL',
    )
  }
  if (parsed.username || parsed.password) {
    throw registrationError(
      'invalid_url',
      'Cowork device registration API URL must not contain credentials',
    )
  }
  if (parsed.protocol !== 'https:' && !isHttpLoopback(parsed)) {
    throw registrationError(
      'invalid_url',
      'Cowork device registration requires HTTPS except on loopback',
    )
  }
  const path = COWORK_REMOTE_DEVICE_PATH.replace(':orgUUID', orgUUID)
  return new URL(path, parsed.origin)
}

function isHttpLoopback(url: URL): boolean {
  if (url.protocol !== 'http:') return false
  const hostname = url.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]'
  ) {
    return true
  }
  const match = hostname.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return Boolean(
    match &&
      Number(match[1]) <= 255 &&
      Number(match[2]) <= 255 &&
      Number(match[3]) <= 255,
  )
}

function createRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController()
  let didTimeout = false
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })

  const timeout = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, timeoutMs)
  timeout.unref?.()

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

function registrationError(
  code: CoworkRemoteDeviceRegistrationErrorCode,
  message: string,
  status?: number,
): CoworkRemoteDeviceRegistrationError {
  return new CoworkRemoteDeviceRegistrationError(code, message, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
