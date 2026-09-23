/**
 * Refusal Logger - Captures refusal events and per-request content-filter
 * outcomes to JSONL files for training and measuring the local classifier.
 *
 * Log files (directory overridable with REFUSAL_LOG_DIR):
 * - ~/.prime/agent/refusal-events.jsonl          every refusal
 * - ~/.prime/agent/content-filter-outcomes.jsonl every finished request with
 *   the filter summary and the stop reason, so refusal rates can be compared
 *   between requests the filter changed and requests it passed
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContentFilterSummary } from './content-filter'
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

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB max before rotation

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
  const TRIGGER_PATTERNS = [
    // High confidence (0.8+)
    'exploit',
    'vulnerability',
    'hack',
    'malware',
    'payload',
    'shellcode',
    'rootkit',
    'backdoor',
    'bypass',
    'injection',
    'man-in-the-middle',
    'mitm',
    'privilege escalation',
    'buffer overflow',
    'heap spray',
    'rop chain',
    'code execution',
    // Medium confidence (0.5-0.8)
    'firmware',
    'binary',
    'reverse engineer',
    'disassemble',
    'decompile',
    'intercept',
    'sniff',
    'reconnaissance',
    'enumeration',
    'attack surface',
    'probe',
    'scan',
    'brute force',
    // Tool names
    'ida',
    'ghidra',
    'radare',
    'objdump',
    'gdb',
    'frida',
    'burp',
    'metasploit',
    'nmap',
    'wireshark',
  ]

  const contentLower = content.toLowerCase()
  const found: string[] = []
  for (const term of TRIGGER_PATTERNS) {
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
