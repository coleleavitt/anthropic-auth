/**
 * Refusal Logger - Captures refusal events and per-request content-filter
 * outcomes to JSONL files for training and measuring the local classifier.
 *
 * Log files (directory overridable with REFUSAL_LOG_DIR):
 * - ~/.prime/agent/refusal-events.jsonl          every refusal
 * - ~/.prime/agent/content-filter-outcomes.jsonl every finished request with
 *   the filter summary and the stop reason, so refusal rates can be compared
 *   between requests the filter changed and requests it passed
 * - ~/.prime/agent/refused-bodies/*.json.gz      the exact request body of
 *   every refusal, saved when the refusal arrives (the dump directory is
 *   swept by size and loses them). Capped at 256MB, oldest removed first.
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { ContentFilterSummary } from './content-filter'
import { LEGACY_TRIGGER_PATTERNS } from './content-filter-terms'
import { logger } from './logger'

/**
 * Log directory. REFUSAL_LOG_DIR overrides it for test isolation. Resolved on
 * every call so a test setup that sets the variable after this module loads
 * still redirects writes.
 */
function getLogDir(): string {
  return process.env.REFUSAL_LOG_DIR || join(homedir(), '.prime/agent')
}

/** Exported for tests to verify isolation */
export function getLogPath(): string {
  return join(getLogDir(), 'refusal-events.jsonl')
}

export function getContentFilterOutcomeLogPath(): string {
  return join(getLogDir(), 'content-filter-outcomes.jsonl')
}

export function getRefusedBodyDir(): string {
  return join(getLogDir(), 'refused-bodies')
}

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB max before rotation
/** Total size cap for saved refused bodies; oldest files go first. */
const REFUSED_BODY_MAX_BYTES = 256 * 1024 * 1024

export interface RefusalEvent {
  timestamp: string
  sessionId?: string
  model: string
  category: string | null
  explanation?: string | null
  requestId?: string | null
  bodySize?: number
  messageCount?: number
  inputTokens?: number
  outputTokens?: number
  wasRerouted: boolean
  fallbackModel?: string
  triggerTerms?: string[]
  /** Saved request body for this refusal (see saveRefusedRequestBody). */
  bodyFile?: string
}

export interface ContentFilterOutcomeEvent {
  timestamp?: string
  host: 'opencode' | 'pi'
  sessionId?: string | null
  model: string
  requestId?: string | null
  /** Raw Anthropic stop_reason (end_turn, tool_use, refusal, ...). */
  stopReason: string
  refusalCategory?: string | null
  /** null when the filter did not run for this request. */
  filter: ContentFilterSummary | null
}

function appendJsonLine(path: string, record: Record<string, unknown>) {
  const dir = getLogDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(path) && statSync(path).size > MAX_LOG_SIZE) {
    renameSync(path, path.replace(/\.jsonl$/, `-${Date.now()}.jsonl`))
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Log a refusal event to the JSONL file
 */
export function logRefusal(event: RefusalEvent): void {
  try {
    appendJsonLine(getLogPath(), {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    })
  } catch (error) {
    // Don't fail the request on logging errors. Use the file logger: a
    // console write would draw over the host TUI.
    logger.warn('refusal-logger', 'failed to log refusal', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface RefusedRequestBody {
  host: 'opencode' | 'pi'
  /** The exact request body sent to Anthropic (after the content filter). */
  body: string
  sessionId?: string | null
  model: string
  requestId?: string | null
  category?: string | null
}

function safeFileSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/**
 * Removes the oldest saved bodies until the directory fits the cap. File
 * names start with an ISO timestamp, so name order is age order. The file
 * just written is never removed.
 */
function pruneRefusedBodies(dir: string, maxBytes: number, keep: string) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json.gz'))
    .sort()
    .map((name) => {
      const path = join(dir, name)
      try {
        return { path, size: statSync(path).size }
      } catch {
        return { path, size: 0 }
      }
    })
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files) {
    if (total <= maxBytes) break
    if (file.path === keep) continue
    try {
      unlinkSync(file.path)
      total -= file.size
    } catch {
      // A concurrent process may have removed it already.
    }
  }
}

/**
 * Saves the body of a refused request as gzip JSON under
 * getRefusedBodyDir(), private to the user (dir 0700, file 0600). Returns the
 * file path, or undefined when saving failed. Never throws.
 */
export function saveRefusedRequestBody(
  input: RefusedRequestBody,
  options: { maxBytes?: number } = {},
): string | undefined {
  try {
    const dir = getRefusedBodyDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const id = safeFileSegment(
      input.requestId ||
        createHash('sha256').update(input.body).digest('hex').slice(0, 16),
    )
    const path = join(dir, `${stamp}-${input.host}-${id}.json.gz`)
    const record = JSON.stringify({
      savedAt: new Date().toISOString(),
      host: input.host,
      sessionId: input.sessionId ?? null,
      model: input.model,
      requestId: input.requestId ?? null,
      category: input.category ?? null,
      body: input.body,
    })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, gzipSync(record), { mode: 0o600 })
    renameSync(temp, path)
    pruneRefusedBodies(dir, options.maxBytes ?? REFUSED_BODY_MAX_BYTES, path)
    return path
  } catch (error) {
    logger.warn('refusal-logger', 'failed to save refused request body', {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/**
 * Log one finished request with its filter summary and stop reason. Never
 * throws: telemetry must not fail a request.
 */
export function logContentFilterOutcome(
  event: ContentFilterOutcomeEvent,
): void {
  try {
    appendJsonLine(getContentFilterOutcomeLogPath(), {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    })
  } catch {
    // Telemetry only.
  }
}

/**
 * Hash request body for deduplication
 */
export function hashRequestBody(body: string | object): string {
  const content = typeof body === 'string' ? body : JSON.stringify(body)
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Extract trigger terms from content using the known trigger patterns
 */
export function extractTriggerTerms(content: string): string[] {
  const contentLower = content.toLowerCase()
  const found: string[] = []
  for (const term of LEGACY_TRIGGER_PATTERNS) {
    if (contentLower.includes(term.toLowerCase())) {
      found.push(term)
    }
  }
  return found
}

/**
 * Estimate the trigger score based on known patterns
 * This mirrors the Python classifier's scoring logic
 */
export function estimateTriggerScore(content: string): number {
  const terms = extractTriggerTerms(content)
  if (terms.length === 0) return 0

  // Simple heuristic: 0.15 per term, capped at 1.0
  // More sophisticated scoring would weight by term confidence
  return Math.min(1.0, terms.length * 0.15)
}
