/**
 * `Retry-After` parsing for quota and API responses.
 *
 * The OAuth login (authorize URL, PKCE, code exchange, including the
 * non-persisting Console exchange) lives in the Rust binding
 * (`startSharedLogin`, `SharedLogin.exchange`); the TypeScript copies were
 * removed.
 */
export function parseRetryAfterHeader(
  value: string | undefined | null,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000)
    return delta > 0 ? delta : undefined
  }
  return undefined
}

export function parseRetryAfterSeconds(
  retryAfter: string | undefined | null,
  retryAfterMs?: string | undefined | null,
): number | undefined {
  if (retryAfterMs) {
    const milliseconds = Number(retryAfterMs)
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return Math.ceil(milliseconds / 1000)
    }
  }
  return parseRetryAfterHeader(retryAfter)
}
