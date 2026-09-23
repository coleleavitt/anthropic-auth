/**
 * Refusal Logger - Captures and logs refusal events to JSONL file
 * for training the local refusal classifier.
 *
 * Log file: ~/.prime/agent/refusal-events.jsonl
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

/**
 * Log directory can be overridden via REFUSAL_LOG_DIR for test isolation.
 * Tests should set this to a temp directory to avoid polluting the real log.
 */
const LOG_DIR = process.env.REFUSAL_LOG_DIR || join(homedir(), '.prime/agent')
const LOG_PATH = join(LOG_DIR, 'refusal-events.jsonl')

/** Exported for tests to verify isolation */
export function getLogPath(): string {
  return LOG_PATH
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

/**
 * Log a refusal event to the JSONL file
 */
export function logRefusal(event: RefusalEvent): void {
  try {
    // Ensure directory exists
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true })
    }

    // Rotate if too large
    if (existsSync(LOG_PATH)) {
      const stat = statSync(LOG_PATH)
      if (stat.size > MAX_LOG_SIZE) {
        const rotatedPath = LOG_PATH.replace('.jsonl', `-${Date.now()}.jsonl`)
        renameSync(LOG_PATH, rotatedPath)
      }
    }

    // Append the event
    const line = JSON.stringify({
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    })
    appendFileSync(LOG_PATH, `${line}\n`, 'utf8')
  } catch (error) {
    // Don't fail the request on logging errors
    console.error('[refusal-logger] Failed to log refusal:', error)
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
