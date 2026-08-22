import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { inspect } from 'node:util'

import {
  type DeviceIdentityPathOptions,
  getDeviceIdentityDirectory,
} from './device-identity.ts'
import {
  FileSecureSecretStore,
  type SecureSecretStore,
} from './secure-secret-store.ts'

export const CLAUDE_TRUSTED_DEVICE_TOKEN_ENV =
  'CLAUDE_TRUSTED_DEVICE_TOKEN' as const
export const TRUSTED_DEVICE_HEADER = 'X-Trusted-Device-Token' as const
export const TRUSTED_DEVICE_ENROLLMENT_PATH =
  '/api/auth/trusted_devices' as const

const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ERROR_DETAIL_LENGTH = 200
const MAX_ERROR_MESSAGE_LENGTH = 512
const MAX_RESPONSE_LENGTH = 64 * 1024
const REDACTED = '[REDACTED]'
const tokenValues = new WeakMap<TrustedDeviceToken, string>()

/** A trusted-device secret that does not expose its value through coercion or JSON. */
export class TrustedDeviceToken {
  private constructor(value: string) {
    tokenValues.set(this, value)
    Object.freeze(this)
  }

  static from(value: string): TrustedDeviceToken {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > 16 * 1024
    ) {
      throw new TypeError(
        'Trusted device token must be between 1 byte and 16 KiB',
      )
    }
    return new TrustedDeviceToken(value)
  }

  toString(): string {
    return REDACTED
  }

  valueOf(): string {
    return REDACTED
  }

  [Symbol.toPrimitive](): string {
    return REDACTED
  }

  /** Omits the token when it appears in a JSON object. */
  toJSON(): undefined {
    return undefined
  }

  [inspect.custom](): string {
    return `TrustedDeviceToken(${REDACTED})`
  }
}

export type TrustedDeviceEnrollment = {
  deviceToken: TrustedDeviceToken
  deviceId?: string
}

export type TrustedDeviceEnrollmentErrorCode =
  | 'invalid_input'
  | 'invalid_url'
  | 'request_failed'
  | 'http_error'
  | 'invalid_response'

export class TrustedDeviceEnrollmentError extends Error {
  constructor(
    public readonly code: TrustedDeviceEnrollmentErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(bound(message, MAX_ERROR_MESSAGE_LENGTH))
    this.name = 'TrustedDeviceEnrollmentError'
  }
}

export type ResolveTrustedDeviceTokenInput = {
  env?: Readonly<Record<string, string | undefined>>
  storedToken?: TrustedDeviceToken | string | null
}

/** Resolves the environment override before a stored token, matching Claude Code. */
export function resolveTrustedDeviceToken(
  input: ResolveTrustedDeviceTokenInput = {},
): TrustedDeviceToken | undefined {
  const environmentValue = (input.env ?? process.env)[
    CLAUDE_TRUSTED_DEVICE_TOKEN_ENV
  ]
  if (environmentValue) return TrustedDeviceToken.from(environmentValue)

  const stored = input.storedToken
  if (stored instanceof TrustedDeviceToken) return stored
  return stored ? TrustedDeviceToken.from(stored) : undefined
}

export function getTrustedDeviceTokenStorePath(
  accountId: string,
  options: DeviceIdentityPathOptions = {},
) {
  const normalized = accountId.trim()
  if (!normalized) throw new TypeError('Trusted device account id is required')
  const key = createHash('sha256').update(normalized).digest('hex').slice(0, 32)
  return join(
    getDeviceIdentityDirectory(options),
    'secrets',
    `trusted-device-${key}`,
  )
}

export async function saveTrustedDeviceToken(input: {
  accountId: string
  token: TrustedDeviceToken
  pathOptions?: DeviceIdentityPathOptions
  store?: SecureSecretStore
}) {
  const value = tokenValues.get(input.token)
  if (value === undefined) throw new TypeError('Invalid trusted device token')
  const store =
    input.store ??
    new FileSecureSecretStore(
      getTrustedDeviceTokenStorePath(input.accountId, input.pathOptions),
      { maxBytes: 16 * 1024 },
    )
  await store.write(value)
}

export async function loadTrustedDeviceToken(input: {
  accountId: string
  pathOptions?: DeviceIdentityPathOptions
  store?: Pick<SecureSecretStore, 'read'>
}) {
  const store =
    input.store ??
    new FileSecureSecretStore(
      getTrustedDeviceTokenStorePath(input.accountId, input.pathOptions),
      { maxBytes: 16 * 1024 },
    )
  const value = await store.read()
  return value ? TrustedDeviceToken.from(value) : undefined
}

export async function deleteTrustedDeviceToken(input: {
  accountId: string
  pathOptions?: DeviceIdentityPathOptions
  store?: Pick<SecureSecretStore, 'delete'>
}) {
  const store =
    input.store ??
    new FileSecureSecretStore(
      getTrustedDeviceTokenStorePath(input.accountId, input.pathOptions),
      { maxBytes: 16 * 1024 },
    )
  return store.delete()
}

export type ExplicitTrustedDeviceHeaders = Partial<
  Record<typeof TRUSTED_DEVICE_HEADER, string>
>

/** Adds device proof only for a Remote Control request. */
export function trustedDeviceHeadersForRemoteControl(
  token?: TrustedDeviceToken | null,
): ExplicitTrustedDeviceHeaders {
  return explicitTrustedDeviceHeaders(token)
}

/** Adds device proof only for a Cowork request. */
export function trustedDeviceHeadersForCowork(
  token?: TrustedDeviceToken | null,
): ExplicitTrustedDeviceHeaders {
  return explicitTrustedDeviceHeaders(token)
}

function explicitTrustedDeviceHeaders(
  token?: TrustedDeviceToken | null,
): ExplicitTrustedDeviceHeaders {
  if (!token) return {}
  const value = tokenValues.get(token)
  if (value === undefined) {
    throw new TypeError('Invalid trusted device token')
  }
  return { [TRUSTED_DEVICE_HEADER]: value }
}

export async function enrollTrustedDevice(input: {
  accessToken: string
  displayName: string
  baseUrl?: string | URL
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<TrustedDeviceEnrollment> {
  if (typeof input.accessToken !== 'string' || input.accessToken.length === 0) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_input',
      'Trusted device enrollment requires a non-empty OAuth access token',
    )
  }
  const displayName = input.displayName?.trim()
  if (!displayName || displayName.length > 255) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_input',
      'Trusted device enrollment display name must be between 1 and 255 characters',
    )
  }

  const url = enrollmentUrl(input.baseUrl ?? DEFAULT_API_BASE_URL)
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_input',
      'Trusted device enrollment timeout must be positive',
    )
  }

  const request = createRequestSignal(input.signal, timeoutMs)
  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: displayName }),
      signal: request.signal,
    })
  } catch (error) {
    const detail = request.timedOut()
      ? 'request timed out'
      : safeErrorDetail(error, [input.accessToken])
    throw new TrustedDeviceEnrollmentError(
      'request_failed',
      detail
        ? `Trusted device enrollment request failed: ${detail}`
        : 'Trusted device enrollment request failed',
    )
  } finally {
    request.cleanup()
  }

  const { text: responseText, truncated } = await readBoundedResponse(response)
  if (response.status !== 200 && response.status !== 201) {
    const detail = redactAndBound(
      `${responseText}${truncated ? '…<truncated>' : ''}`,
      [input.accessToken],
    )
    throw new TrustedDeviceEnrollmentError(
      'http_error',
      `Trusted device enrollment failed with HTTP ${response.status}${
        detail ? `: ${detail}` : ''
      }`,
      response.status,
    )
  }

  if (truncated) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_response',
      'Trusted device enrollment returned an oversized response',
      response.status,
    )
  }

  let body: unknown
  try {
    body = JSON.parse(responseText)
  } catch {
    throw new TrustedDeviceEnrollmentError(
      'invalid_response',
      'Trusted device enrollment returned invalid JSON',
      response.status,
    )
  }

  if (!isRecord(body)) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_response',
      'Trusted device enrollment returned an invalid response',
      response.status,
    )
  }
  if (typeof body.device_token !== 'string' || body.device_token.length === 0) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_response',
      'Trusted device enrollment response is missing device_token',
      response.status,
    )
  }

  const deviceId = body.device_id
  if (
    deviceId !== undefined &&
    deviceId !== null &&
    (typeof deviceId !== 'string' || deviceId.length === 0)
  ) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_response',
      'Trusted device enrollment response has an invalid device_id',
      response.status,
    )
  }

  return {
    deviceToken: TrustedDeviceToken.from(body.device_token),
    ...(typeof deviceId === 'string' ? { deviceId } : {}),
  }
}

async function readBoundedResponse(response: Response) {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  while (size < MAX_RESPONSE_LENGTH) {
    const chunk = await reader.read().catch(() => ({
      done: true as const,
      value: undefined,
    }))
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

function enrollmentUrl(baseUrl: string | URL): URL {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new TrustedDeviceEnrollmentError(
      'invalid_url',
      'Trusted device enrollment requires a valid API base URL',
    )
  }

  if (parsed.username || parsed.password) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_url',
      'Trusted device enrollment API URL must not contain credentials',
    )
  }
  if (parsed.protocol !== 'https:' && !isHttpLoopback(parsed)) {
    throw new TrustedDeviceEnrollmentError(
      'invalid_url',
      'Trusted device enrollment requires HTTPS except on loopback',
    )
  }
  return new URL(TRUSTED_DEVICE_ENROLLMENT_PATH, parsed.origin)
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

function safeErrorDetail(error: unknown, secrets: readonly string[]): string {
  const value = error instanceof Error ? error.message : String(error)
  return redactAndBound(value, secrets)
}

function redactAndBound(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join(REDACTED)
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(
      /("(?:access_token|refresh_token|device_token|authorization|token)"\s*:\s*")[^"]*(")/gi,
      `$1${REDACTED}$2`,
    )
  redacted = [...redacted]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return bound(redacted, MAX_ERROR_DETAIL_LENGTH)
}

function bound(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
