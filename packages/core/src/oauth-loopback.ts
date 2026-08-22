import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export const OAUTH_LOOPBACK_CALLBACK_PATH = '/callback'
export const OAUTH_LOOPBACK_MAX_REQUEST_BYTES = 16 * 1024
export const OAUTH_LOOPBACK_DEFAULT_CONNECTION_TIMEOUT_MS = 10_000
export const OAUTH_LOOPBACK_DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60_000

const SUCCESS_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authentication complete</title></head><body><main><h1>Authentication complete</h1><p>You can close this window and return to the application.</p></main></body></html>'
const ERROR_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authentication failed</title></head><body><main><h1>Authentication failed</h1><p>Return to the application and try again.</p></main></body></html>'

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const

export type OAuthLoopbackResult = {
  code: string
  state: string
  source: 'loopback' | 'manual'
}

export type OAuthLoopbackErrorCode =
  | 'cancelled'
  | 'closed'
  | 'invalid_callback'
  | 'oauth_error'
  | 'server_error'
  | 'timed_out'

export class OAuthLoopbackError extends Error {
  constructor(
    public readonly code: OAuthLoopbackErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OAuthLoopbackError'
  }
}

export type OAuthLoopbackSessionOptions = {
  /** Expected OAuth state. A cryptographically random state is generated when omitted. */
  state?: string
  /** Maximum idle time for a single TCP connection. */
  connectionTimeoutMs?: number
  /** Maximum lifetime of the pending OAuth flow. */
  overallTimeoutMs?: number
  /** Cancels the pending flow when aborted. */
  signal?: AbortSignal
}

export type OAuthManualCallback = {
  code: string
  state: string
}

/** Generates the same 256-bit, base64url state shape used by Claude Code. */
export function createOAuthLoopbackState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * A one-shot OAuth callback listener.
 *
 * The socket is bound to 127.0.0.1 while `redirectUri` deliberately advertises
 * localhost, matching Claude Code's registered loopback redirect shape.
 */
export class OAuthLoopbackSession {
  readonly state: string
  readonly result: Promise<OAuthLoopbackResult>
  readonly closed: Promise<void>

  private boundPort = 0
  private advertisedRedirectUri = ''

  private readonly server
  private readonly sockets = new Set<Socket>()
  private readonly socketTimers = new Map<
    Socket,
    ReturnType<typeof setTimeout>
  >()
  private readonly connectionTimeoutMs: number
  private readonly overallTimeoutMs: number
  private readonly signal: AbortSignal | undefined
  private readonly resolveResult: (result: OAuthLoopbackResult) => void
  private readonly rejectResult: (error: OAuthLoopbackError) => void
  private readonly resolveClosed: () => void

  private overallTimer: ReturnType<typeof setTimeout> | undefined
  private forceCloseTimer: ReturnType<typeof setTimeout> | undefined
  private pending = true
  private shuttingDown = false
  private started = false

  private constructor(options: OAuthLoopbackSessionOptions) {
    this.state = options.state ?? createOAuthLoopbackState()
    assertSafeCallbackValue(this.state, 'OAuth state')
    this.connectionTimeoutMs = positiveTimeout(
      options.connectionTimeoutMs,
      OAUTH_LOOPBACK_DEFAULT_CONNECTION_TIMEOUT_MS,
      'connectionTimeoutMs',
    )
    this.overallTimeoutMs = positiveTimeout(
      options.overallTimeoutMs,
      OAUTH_LOOPBACK_DEFAULT_OVERALL_TIMEOUT_MS,
      'overallTimeoutMs',
    )
    this.signal = options.signal

    let resolveResult!: (result: OAuthLoopbackResult) => void
    let rejectResult!: (error: OAuthLoopbackError) => void
    this.result = new Promise<OAuthLoopbackResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    this.resolveResult = resolveResult
    this.rejectResult = rejectResult
    // Cancellation and timeout are normal control flow. Mark the internal
    // promise handled even when a caller only uses callbacks and never awaits it.
    void this.result.catch(() => {})

    let resolveClosed!: () => void
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    this.resolveClosed = resolveClosed

    this.server = createServer(
      { maxHeaderSize: OAUTH_LOOPBACK_MAX_REQUEST_BYTES },
      (request, response) => this.handleRequest(request, response),
    )
    this.server.headersTimeout = this.connectionTimeoutMs
    this.server.requestTimeout = this.connectionTimeoutMs
    this.server.keepAliveTimeout = 1
    this.server.maxRequestsPerSocket = 1
    this.server.on('connection', (socket) => this.trackSocket(socket))
    this.server.on('clientError', (error, socket) =>
      this.handleClientError(error as NodeJS.ErrnoException, socket),
    )
    this.server.on('error', this.handleServerError)
    this.server.once('close', () => {
      this.clearTimers()
      for (const timer of this.socketTimers.values()) clearTimeout(timer)
      this.socketTimers.clear()
      this.removeAbortListener()
      this.resolveClosed()
    })
  }

  static async start(
    options: OAuthLoopbackSessionOptions = {},
  ): Promise<OAuthLoopbackSession> {
    const session = new OAuthLoopbackSession(options)
    await session.listen()
    return session
  }

  get port(): number {
    return this.boundPort
  }

  get redirectUri(): string {
    return this.advertisedRedirectUri
  }

  /** Waits for either the browser callback or a manual completion. */
  waitForCallback(): Promise<OAuthLoopbackResult> {
    return this.result
  }

  /**
   * Completes the same pending flow from a CLI/TUI manual fallback.
   *
   * The object form is preferred. A full callback URL is also accepted for a
   * paste-oriented UI; duplicate parameters and state are validated exactly as
   * they are on the HTTP path.
   */
  submitManualCallback(
    callback: OAuthManualCallback | URL | string,
  ): OAuthLoopbackResult {
    if (!this.pending) {
      throw new OAuthLoopbackError(
        'closed',
        'The OAuth flow is no longer pending',
      )
    }
    const parsed = parseManualCallback(callback)
    if (!parsed.code) {
      throw new OAuthLoopbackError(
        'invalid_callback',
        'The manual OAuth callback is missing a code',
      )
    }
    assertSafeCallbackValue(parsed.code, 'Authorization code')
    assertSafeCallbackValue(parsed.state, 'OAuth state')
    if (!statesMatch(parsed.state, this.state)) {
      throw new OAuthLoopbackError(
        'invalid_callback',
        'The manual OAuth callback state is invalid',
      )
    }

    const result: OAuthLoopbackResult = {
      code: parsed.code,
      state: parsed.state,
      source: 'manual',
    }
    this.resolvePending(result)
    this.shutdown()
    return result
  }

  /** Cancels the pending flow and releases every listener/socket. */
  cancel(): void {
    if (this.pending) {
      this.rejectPending(
        new OAuthLoopbackError('cancelled', 'The OAuth flow was cancelled'),
      )
    }
    this.shutdown()
  }

  /** Idempotently closes the session. A still-pending flow is cancelled. */
  async close(): Promise<void> {
    this.cancel()
    await this.closed
  }

  private async listen(): Promise<void> {
    if (this.signal?.aborted) {
      const error = new OAuthLoopbackError(
        'cancelled',
        'The OAuth flow was cancelled',
      )
      this.rejectPending(error)
      this.shutdown()
      throw error
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        this.server.once('error', onError)
        this.server.listen(0, '127.0.0.1', () => {
          this.server.off('error', onError)
          resolve()
        })
      })
    } catch {
      const error = new OAuthLoopbackError(
        'server_error',
        'Failed to start the OAuth callback server',
      )
      this.rejectPending(error)
      this.shutdown()
      throw error
    }

    this.started = true
    const address = this.server.address()
    if (!address || typeof address === 'string' || !address.port) {
      const error = new OAuthLoopbackError(
        'server_error',
        'Failed to determine the OAuth callback port',
      )
      this.rejectPending(error)
      this.shutdown()
      throw error
    }

    this.boundPort = address.port
    this.advertisedRedirectUri = `http://localhost:${this.boundPort}${OAUTH_LOOPBACK_CALLBACK_PATH}`
    this.server.unref()

    this.overallTimer = setTimeout(() => {
      this.rejectPending(
        new OAuthLoopbackError('timed_out', 'The OAuth flow timed out'),
      )
      this.shutdown()
    }, this.overallTimeoutMs)
    this.overallTimer.unref?.()
    this.signal?.addEventListener('abort', this.handleAbort, { once: true })
  }

  private readonly handleAbort = () => this.cancel()

  private readonly handleServerError = () => {
    if (!this.started || this.shuttingDown) return
    this.rejectPending(
      new OAuthLoopbackError(
        'server_error',
        'The OAuth callback server stopped unexpectedly',
      ),
    )
    this.shutdown()
  }

  private removeAbortListener(): void {
    this.signal?.removeEventListener('abort', this.handleAbort)
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket)
    const timer = setTimeout(() => socket.destroy(), this.connectionTimeoutMs)
    timer.unref?.()
    this.socketTimers.set(socket, timer)
    socket.once('close', () => {
      this.sockets.delete(socket)
      const socketTimer = this.socketTimers.get(socket)
      if (socketTimer !== undefined) clearTimeout(socketTimer)
      this.socketTimers.delete(socket)
    })
  }

  private handleClientError(
    error: NodeJS.ErrnoException,
    socket: Duplex,
  ): void {
    if (!socket.writable || socket.destroyed) {
      socket.destroy()
      return
    }
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400
    socket.end(rawPageResponse(status, ERROR_PAGE))
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (requestByteLength(request) > OAUTH_LOOPBACK_MAX_REQUEST_BYTES) {
      this.respond(response, 431, ERROR_PAGE)
      return
    }
    if (request.method !== 'GET') {
      this.respond(response, 405, ERROR_PAGE, { Allow: 'GET' })
      return
    }
    if (request.headers['transfer-encoding'] !== undefined) {
      this.respond(response, 400, ERROR_PAGE)
      return
    }
    const contentLength = request.headers['content-length']
    if (
      contentLength !== undefined &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) !== 0)
    ) {
      this.respond(response, 400, ERROR_PAGE)
      return
    }

    const target = request.url ?? ''
    const queryIndex = target.indexOf('?')
    const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex)
    if (rawPath !== OAUTH_LOOPBACK_CALLBACK_PATH || !target.startsWith('/')) {
      this.respond(response, 404, ERROR_PAGE)
      return
    }
    if (!this.pending) {
      this.respond(response, 410, ERROR_PAGE)
      return
    }

    let url: URL
    try {
      url = new URL(target, this.advertisedRedirectUri)
    } catch {
      this.respond(response, 400, ERROR_PAGE)
      return
    }
    if (hasDuplicateQueryParameter(url.searchParams)) {
      this.respond(response, 400, ERROR_PAGE)
      return
    }

    const state = singleQueryValue(url.searchParams, 'state')
    if (!state || !statesMatch(state, this.state)) {
      this.respond(response, 400, ERROR_PAGE)
      return
    }

    const code = singleQueryValue(url.searchParams, 'code')
    const oauthError = singleQueryValue(url.searchParams, 'error')
    if ((code && oauthError) || (!code && !oauthError)) {
      this.respond(response, 400, ERROR_PAGE)
      return
    }

    if (oauthError) {
      this.rejectPending(
        new OAuthLoopbackError(
          'oauth_error',
          'The authorization server rejected the OAuth request',
        ),
      )
      this.respondAndShutdown(response, 400, ERROR_PAGE)
      return
    }

    try {
      assertSafeCallbackValue(code ?? '', 'Authorization code')
    } catch {
      this.respond(response, 400, ERROR_PAGE)
      return
    }

    this.resolvePending({
      code: code ?? '',
      state,
      source: 'loopback',
    })
    this.respondAndShutdown(response, 200, SUCCESS_PAGE)
  }

  private respondAndShutdown(
    response: ServerResponse,
    status: number,
    page: string,
  ): void {
    const socket = response.socket
    response.once('finish', () => this.shutdown())
    response.once('close', () => this.shutdown())
    this.respond(response, status, page)
    // `Connection: close` normally releases this immediately. Keep one short
    // upper bound for runtimes that retain the completed response socket.
    if (socket) {
      this.forceCloseTimer = setTimeout(() => socket.destroy(), 1_000)
      this.forceCloseTimer.unref?.()
    }
  }

  private respond(
    response: ServerResponse,
    status: number,
    page: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (response.headersSent || response.writableEnded || response.destroyed) {
      return
    }
    response.writeHead(status, {
      ...PAGE_HEADERS,
      ...extraHeaders,
      Connection: 'close',
      'Content-Length': String(Buffer.byteLength(page)),
    })
    response.end(page)
  }

  private resolvePending(result: OAuthLoopbackResult): void {
    if (!this.pending) return
    this.pending = false
    this.clearOverallTimer()
    this.removeAbortListener()
    this.resolveResult(result)
  }

  private rejectPending(error: OAuthLoopbackError): void {
    if (!this.pending) return
    this.pending = false
    this.clearOverallTimer()
    this.removeAbortListener()
    this.rejectResult(error)
  }

  private shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.clearTimers()
    this.removeAbortListener()

    if (!this.started) {
      this.resolveClosed()
      return
    }

    this.server.close()
    for (const socket of this.sockets) {
      if (!socket.destroyed && socket.writableLength === 0) socket.destroy()
    }
  }

  private clearOverallTimer(): void {
    if (this.overallTimer !== undefined) clearTimeout(this.overallTimer)
    this.overallTimer = undefined
  }

  private clearTimers(): void {
    this.clearOverallTimer()
    if (this.forceCloseTimer !== undefined) clearTimeout(this.forceCloseTimer)
    this.forceCloseTimer = undefined
  }
}

export function startOAuthLoopbackSession(
  options: OAuthLoopbackSessionOptions = {},
): Promise<OAuthLoopbackSession> {
  return OAuthLoopbackSession.start(options)
}

function positiveTimeout(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive finite number`)
  }
  return Math.floor(resolved)
}

function assertSafeCallbackValue(value: string, label: string): void {
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > OAUTH_LOOPBACK_MAX_REQUEST_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new OAuthLoopbackError(
      'invalid_callback',
      `${label} is empty or invalid`,
    )
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function statesMatch(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualDigest, expectedDigest)
}

function hasDuplicateQueryParameter(params: URLSearchParams): boolean {
  const seen = new Set<string>()
  for (const key of params.keys()) {
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function singleQueryValue(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const values = params.getAll(name)
  return values.length === 1 && values[0] ? values[0] : undefined
}

function parseManualCallback(
  callback: OAuthManualCallback | URL | string,
): OAuthManualCallback {
  if (typeof callback === 'object' && !(callback instanceof URL)) {
    return { code: callback.code, state: callback.state }
  }

  let url: URL
  try {
    url = callback instanceof URL ? callback : new URL(callback.trim())
  } catch {
    throw new OAuthLoopbackError(
      'invalid_callback',
      'The manual OAuth callback must be a full URL',
    )
  }
  if (hasDuplicateQueryParameter(url.searchParams)) {
    throw new OAuthLoopbackError(
      'invalid_callback',
      'The manual OAuth callback contains duplicate query parameters',
    )
  }
  const code = singleQueryValue(url.searchParams, 'code')
  const state = singleQueryValue(url.searchParams, 'state')
  if (!code || !state || singleQueryValue(url.searchParams, 'error')) {
    throw new OAuthLoopbackError(
      'invalid_callback',
      'The manual OAuth callback is incomplete',
    )
  }
  return { code, state }
}

function requestByteLength(request: IncomingMessage): number {
  let length = Buffer.byteLength(
    `${request.method ?? ''} ${request.url ?? ''} HTTP/${request.httpVersion}\r\n`,
  )
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    length += Buffer.byteLength(request.rawHeaders[index] ?? '')
    length += 2
    length += Buffer.byteLength(request.rawHeaders[index + 1] ?? '')
    length += 2
  }
  return length + 2
}

function rawPageResponse(status: number, page: string): string {
  const reason =
    status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'
  const headers = Object.entries({
    ...PAGE_HEADERS,
    Connection: 'close',
    'Content-Length': String(Buffer.byteLength(page)),
  })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')
  return `HTTP/1.1 ${status} ${reason}\r\n${headers}\r\n\r\n${page}`
}
