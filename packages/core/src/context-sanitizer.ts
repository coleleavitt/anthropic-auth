/**
 * Periodic full-context sanitization for accumulated context.
 * Abstracts technical details, consolidates redundant patterns, and reduces context score.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SanitizationConfig {
  /** Turns between sanitization passes (default: 25) */
  interval: number
  /** How aggressively to abstract content */
  aggressiveness: 'light' | 'moderate' | 'aggressive'
  /** Keep last N messages unsanitized (default: 5) */
  preserveRecent: number
}

export interface SanitizationResult {
  /** Total messages processed */
  messagesProcessed: number
  /** Number of blocks abstracted */
  blocksAbstracted: number
  /** Estimated score reduction (characters removed) */
  scoreReduction: number
  /** Detailed replacements made */
  replacements: Array<{ index: number; before: string; after: string }>
}

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SANITIZATION_CONFIG: SanitizationConfig = {
  interval: 25,
  aggressiveness: 'moderate',
  preserveRecent: 5,
}

// ─────────────────────────────────────────────────────────────────────────────
// Abstraction Patterns
// ─────────────────────────────────────────────────────────────────────────────

interface AbstractionPattern {
  name: string
  pattern: RegExp
  replacement: string | ((match: string, ...groups: string[]) => string)
  /** Minimum aggressiveness level required to apply this pattern */
  minLevel: 'light' | 'moderate' | 'aggressive'
}

export const ABSTRACTION_PATTERNS: AbstractionPattern[] = [
  // Light level - obviously sensitive patterns
  {
    name: 'ipv4_private',
    pattern:
      /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
    replacement: '[local IP]',
    minLevel: 'light',
  },
  {
    name: 'ipv4_public',
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: '[IP address]',
    minLevel: 'light',
  },
  {
    name: 'ipv6',
    pattern:
      /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,
    replacement: '[IPv6 address]',
    minLevel: 'light',
  },
  {
    name: 'api_key_like',
    pattern: /\b(?:sk-|pk-|api[-_]?key[-_]?)[a-zA-Z0-9_-]{20,}\b/gi,
    replacement: '[API key]',
    minLevel: 'light',
  },
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[a-zA-Z0-9_.-]{20,}/gi,
    replacement: 'Bearer [token]',
    minLevel: 'light',
  },
  {
    name: 'jwt_token',
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    replacement: '[JWT token]',
    minLevel: 'light',
  },

  // Moderate level - technical details
  {
    name: 'absolute_path_unix',
    pattern: /(?:\/[\w.-]+){3,}/g,
    replacement: '[file path]',
    minLevel: 'moderate',
  },
  {
    name: 'absolute_path_windows',
    pattern: /[A-Z]:\\(?:[\w.-]+\\){2,}[\w.-]*/gi,
    replacement: '[file path]',
    minLevel: 'moderate',
  },
  {
    name: 'hex_value_long',
    pattern: /\b0x[0-9a-fA-F]{8,}\b/g,
    replacement: '[hex value]',
    minLevel: 'moderate',
  },
  {
    name: 'uuid',
    pattern:
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    replacement: '[UUID]',
    minLevel: 'moderate',
  },
  {
    name: 'url_full',
    pattern: /https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?(?:\/[^\s)\]"'<>]*)*/g,
    replacement: (_match: string, domain: string) => `[URL: ${domain}]`,
    minLevel: 'moderate',
  },
  {
    name: 'email',
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: '[email]',
    minLevel: 'moderate',
  },
  {
    name: 'hostname_cloud',
    pattern:
      /\b(?:[a-z0-9-]+\.)?(?:amazonaws|azure|googleapis|cloudflare|remarkable)\.com\b/gi,
    replacement: '[cloud endpoint]',
    minLevel: 'moderate',
  },
  {
    name: 'sha_hash',
    pattern: /\b[0-9a-fA-F]{40,64}\b/g,
    replacement: '[hash]',
    minLevel: 'moderate',
  },

  // Aggressive level - heavily abstract
  {
    name: 'hex_value_short',
    pattern: /\b0x[0-9a-fA-F]{4,}\b/g,
    replacement: '[hex]',
    minLevel: 'aggressive',
  },
  {
    name: 'numeric_sequence',
    pattern: /\b\d{6,}\b/g,
    replacement: '[number]',
    minLevel: 'aggressive',
  },
  {
    name: 'base64_block',
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/g,
    replacement: '[base64 data]',
    minLevel: 'aggressive',
  },
  {
    name: 'json_object',
    pattern: /\{(?:[^{}]|\{[^{}]*\}){100,}\}/g,
    replacement: '[JSON object]',
    minLevel: 'aggressive',
  },
  {
    name: 'hostname_any',
    pattern:
      /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:[a-z]{2,6}|[a-z0-9-]+\.[a-z]{2,})\b/gi,
    replacement: '[hostname]',
    minLevel: 'aggressive',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Aggressiveness Level Ordering
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<'light' | 'moderate' | 'aggressive', number> = {
  light: 0,
  moderate: 1,
  aggressive: 2,
}

function shouldApplyPattern(
  patternLevel: 'light' | 'moderate' | 'aggressive',
  configLevel: 'light' | 'moderate' | 'aggressive',
): boolean {
  return LEVEL_ORDER[patternLevel] <= LEVEL_ORDER[configLevel]
}

// ─────────────────────────────────────────────────────────────────────────────
// Code Block Detection & Abstraction
// ─────────────────────────────────────────────────────────────────────────────

const CODE_BLOCK_PATTERN = /```(\w*)\n([\s\S]*?)```/g
const SHELL_OUTPUT_PATTERN = /^\$\s+.+\n(?:(?!\$\s)[\s\S])*?(?=\n\$|\n```|$)/gm

function abstractCodeBlocks(
  text: string,
  aggressiveness: 'light' | 'moderate' | 'aggressive',
): { text: string; abstractedCount: number } {
  let abstractedCount = 0

  // For moderate and aggressive, abstract code blocks
  if (aggressiveness !== 'light') {
    text = text.replace(
      CODE_BLOCK_PATTERN,
      (_match, lang: string, code: string) => {
        const lines = code.trim().split('\n').length
        abstractedCount++
        const langLabel = lang ? `: ${lang}` : ''
        return `[code${langLabel}, ${lines} lines]`
      },
    )
  }

  // For aggressive, also abstract shell command outputs
  if (aggressiveness === 'aggressive') {
    text = text.replace(SHELL_OUTPUT_PATTERN, (match) => {
      const lines = match.trim().split('\n').length
      abstractedCount++
      return `[command output: ${lines} lines]`
    })
  }

  return { text, abstractedCount }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block Abstraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract sensitive/verbose content from a text block.
 * @param text The text to sanitize
 * @param aggressiveness How aggressively to abstract
 * @returns Abstracted text
 */
export function abstractSanitizationBlock(
  text: string,
  aggressiveness: 'light' | 'moderate' | 'aggressive',
): string {
  let result = text

  // First, handle code blocks (before pattern matching to avoid partial matches)
  const { text: withCodeAbstracted } = abstractCodeBlocks(
    result,
    aggressiveness,
  )
  result = withCodeAbstracted

  // Apply regex patterns based on aggressiveness level
  for (const pattern of ABSTRACTION_PATTERNS) {
    if (shouldApplyPattern(pattern.minLevel, aggressiveness)) {
      if (typeof pattern.replacement === 'function') {
        result = result.replace(pattern.pattern, pattern.replacement)
      } else {
        result = result.replace(pattern.pattern, pattern.replacement)
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Content Extraction
// ─────────────────────────────────────────────────────────────────────────────

function getMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content
    .filter(
      (block): block is ContentBlock & { text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

function setMessageText(message: Message, text: string): Message {
  if (typeof message.content === 'string') {
    return { ...message, content: text }
  }
  // For array content, update text blocks
  const newContent = message.content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return { ...block, text }
    }
    return block
  })
  return { ...message, content: newContent }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message History Sanitization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a message history, abstracting older messages while preserving recent ones.
 * @param messages Array of messages to sanitize
 * @param config Sanitization configuration
 * @returns Sanitization result with statistics and sanitized messages
 */
export function sanitizeMessageHistory(
  messages: Message[],
  config: Partial<SanitizationConfig> = {},
): { messages: Message[]; result: SanitizationResult } {
  const fullConfig: SanitizationConfig = {
    ...DEFAULT_SANITIZATION_CONFIG,
    ...config,
  }
  const { preserveRecent, aggressiveness } = fullConfig

  const result: SanitizationResult = {
    messagesProcessed: 0,
    blocksAbstracted: 0,
    scoreReduction: 0,
    replacements: [],
  }

  // Calculate which messages to process (skip recent ones)
  const processUntilIndex = Math.max(0, messages.length - preserveRecent)

  const sanitizedMessages = messages.map((message, index) => {
    // Skip recent messages
    if (index >= processUntilIndex) {
      return message
    }

    const originalText = getMessageText(message)
    const sanitizedText = abstractSanitizationBlock(
      originalText,
      aggressiveness,
    )

    // Track changes
    if (sanitizedText !== originalText) {
      result.messagesProcessed++
      result.blocksAbstracted++
      result.scoreReduction += originalText.length - sanitizedText.length
      result.replacements.push({
        index,
        before:
          originalText.slice(0, 100) + (originalText.length > 100 ? '...' : ''),
        after:
          sanitizedText.slice(0, 100) +
          (sanitizedText.length > 100 ? '...' : ''),
      })

      return setMessageText(message, sanitizedText)
    }

    return message
  })

  return { messages: sanitizedMessages, result }
}

// ─────────────────────────────────────────────────────────────────────────────
// Redundancy Consolidation
// ─────────────────────────────────────────────────────────────────────────────

interface TextFingerprint {
  index: number
  text: string
  normalized: string
}

/**
 * Normalize text for comparison (lowercase, collapse whitespace, remove punctuation variance).
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

/**
 * Calculate similarity ratio between two strings (0-1).
 */
function similarityRatio(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  // Simple length-based similarity for efficiency
  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a

  // Check if shorter is contained in longer
  if (longer.includes(shorter)) {
    return shorter.length / longer.length
  }

  // Check prefix/suffix overlap
  let overlap = 0
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) overlap++
    else break
  }

  return overlap / Math.max(a.length, b.length)
}

/**
 * Detect and consolidate repeated explanations/patterns in messages.
 * @param messages Array of messages to consolidate
 * @returns Consolidated messages with redundancy summary
 */
export function consolidateRedundant(messages: Message[]): {
  messages: Message[]
  consolidatedCount: number
} {
  const MIN_TEXT_LENGTH = 50 // Minimum text length to consider for consolidation
  const SIMILARITY_THRESHOLD = 0.8 // 80% similarity to consider redundant

  // Extract text fingerprints from all messages
  const fingerprints: TextFingerprint[] = messages
    .map((msg, index) => ({
      index,
      text: getMessageText(msg),
      normalized: normalizeForComparison(getMessageText(msg)),
    }))
    .filter((fp) => fp.text.length >= MIN_TEXT_LENGTH)

  // Find groups of similar messages
  const groups: Map<number, number[]> = new Map()
  const processed = new Set<number>()

  for (let i = 0; i < fingerprints.length; i++) {
    const fpI = fingerprints[i]
    if (!fpI || processed.has(fpI.index)) continue

    const group: number[] = [fpI.index]
    processed.add(fpI.index)

    for (let j = i + 1; j < fingerprints.length; j++) {
      const fpJ = fingerprints[j]
      if (!fpJ || processed.has(fpJ.index)) continue

      const similarity = similarityRatio(fpI.normalized, fpJ.normalized)

      if (similarity >= SIMILARITY_THRESHOLD) {
        group.push(fpJ.index)
        processed.add(fpJ.index)
      }
    }

    if (group.length > 1) {
      const firstIndex = group[0]
      if (firstIndex !== undefined) {
        groups.set(firstIndex, group)
      }
    }
  }

  // No redundancy found
  if (groups.size === 0) {
    return { messages, consolidatedCount: 0 }
  }

  // Build consolidated message array
  const toRemove = new Set<number>()
  const consolidatedMessages = messages.map((msg, index) => {
    const group = groups.get(index)
    if (group && group.length > 1) {
      // This is the first message in a redundant group
      const originalText = getMessageText(msg)
      const summary = originalText.slice(0, 80).trim()
      const consolidatedText = `[repeated ${group.length} times: ${summary}...]`

      // Mark other messages in group for removal
      for (let i = 1; i < group.length; i++) {
        const removeIndex = group[i]
        if (removeIndex !== undefined) {
          toRemove.add(removeIndex)
        }
      }

      return setMessageText(msg, consolidatedText)
    }
    return msg
  })

  // Filter out removed messages
  const finalMessages = consolidatedMessages.filter(
    (_, index) => !toRemove.has(index),
  )

  return {
    messages: finalMessages,
    consolidatedCount: toRemove.size,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: Full Sanitization Pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform a full sanitization pass: abstract patterns, then consolidate redundancy.
 */
export function fullSanitizationPass(
  messages: Message[],
  config: Partial<SanitizationConfig> = {},
): {
  messages: Message[]
  sanitizationResult: SanitizationResult
  consolidatedCount: number
} {
  const { messages: sanitized, result: sanitizationResult } =
    sanitizeMessageHistory(messages, config)
  const { messages: consolidated, consolidatedCount } =
    consolidateRedundant(sanitized)

  return {
    messages: consolidated,
    sanitizationResult,
    consolidatedCount,
  }
}
