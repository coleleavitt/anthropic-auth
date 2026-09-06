/**
 * Optional bridge to the host's tracing API.
 *
 * Prime Agent's `@earendil-works/pi-ai` exposes `withSpan` and friends, and
 * the host aliases the package to its own instance, so a span opened here
 * nests under the host's `llm.request` through ambient async context. Stock
 * Pi ships no tracing exports at all. The bridge resolves the module once,
 * uses `withSpan` when it is a function, and otherwise runs the traced body
 * directly. Tracing never throws: a broken host implementation degrades to
 * an untraced call rather than a failed refresh.
 */
export type SpanAttributeValue = string | number | boolean | undefined
export type SpanAttributes = Record<string, SpanAttributeValue>
export type SpanStatus = 'ok' | 'error'

/** The subset of the host span the plugin relies on. */
export interface TraceSpan {
  /** Attributes set so far (undefined values are dropped). */
  readonly attrs: SpanAttributes
  setAttributes(attrs: SpanAttributes): void
  recordError(error: unknown): void
  end(status?: SpanStatus): void
}

/** What the plugin needs from the host module; everything is optional. */
export interface TraceApi {
  withSpan?: unknown
}

type HostWithSpan = <T>(
  name: string,
  attrs: SpanAttributes | undefined,
  fn: (span: TraceSpan) => T,
) => T

let resolvedApi: Promise<TraceApi | null> | undefined

/**
 * Replace the host module for tests. `undefined` restores auto-resolution on
 * the next call; `null` forces the untraced path.
 */
export function setTraceApiForTests(api: TraceApi | null | undefined) {
  resolvedApi = api === undefined ? undefined : Promise.resolve(api)
}

function resolveTraceApi(): Promise<TraceApi | null> {
  if (!resolvedApi) {
    resolvedApi = import('@earendil-works/pi-ai')
      .then((module) => module as TraceApi)
      .catch(() => null)
  }
  return resolvedApi
}

function cleanAttrs(attrs: SpanAttributes | undefined): SpanAttributes {
  const out: SpanAttributes = {}
  if (!attrs) return out
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** A span that records attributes locally and reports nowhere. */
function noopSpan(attrs: SpanAttributes | undefined): TraceSpan {
  const held = cleanAttrs(attrs)
  return {
    attrs: held,
    setAttributes(next) {
      Object.assign(held, cleanAttrs(next))
    },
    recordError() {},
    end() {},
  }
}

/**
 * Wrap a host span so a throwing method cannot break the traced body, and so
 * the attributes stay readable even when the host keeps its own copy.
 */
function guardedSpan(inner: TraceSpan, attrs: SpanAttributes | undefined) {
  const held = cleanAttrs(attrs)
  const span: TraceSpan = {
    attrs: held,
    setAttributes(next) {
      Object.assign(held, cleanAttrs(next))
      try {
        inner.setAttributes(next)
      } catch {}
    },
    recordError(error) {
      try {
        inner.recordError(error)
      } catch {}
    },
    end(status) {
      try {
        inner.end(status)
      } catch {}
    },
  }
  return span
}

/**
 * Run `fn` inside a host span named `name`, or directly when the host has no
 * tracing. Errors thrown by `fn` propagate unchanged; errors thrown by the
 * tracing layer itself are swallowed, and the body's own settled result is
 * what the caller sees.
 */
export async function withAuthSpan<T>(
  name: string,
  attrs: SpanAttributes | undefined,
  fn: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const api = await resolveTraceApi()
  const withSpan =
    typeof api?.withSpan === 'function'
      ? (api.withSpan as HostWithSpan)
      : undefined
  if (!withSpan) return fn(noopSpan(attrs))

  let invoked = false
  let settled:
    | { ok: true; value: T }
    | { ok: false; error: unknown }
    | undefined
  try {
    return await withSpan(name, cleanAttrs(attrs), async (inner) => {
      invoked = true
      const span = guardedSpan(inner, attrs)
      try {
        const value = await fn(span)
        settled = { ok: true, value }
        return value
      } catch (error) {
        settled = { ok: false, error }
        throw error
      }
    })
  } catch (error) {
    // The host threw before running the body: trace nothing, still do the work.
    if (!invoked) return fn(noopSpan(attrs))
    if (settled === undefined) throw error
    if (settled.ok) return settled.value
    throw settled.error
  }
}

/** The numeric HTTP status an error carries, when it carries one. */
export function errorHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) return status
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string') {
    const match = /\bHTTP (\d{3})\b/.exec(message)
    if (match) return Number(match[1])
  }
  return undefined
}
