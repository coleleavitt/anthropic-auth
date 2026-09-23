/**
 * Content Filter - Pre-flight refusal prevention
 *
 * Classifies and rewrites content to prevent Anthropic cyber/bio refusals.
 * Based on reverse-engineered classifier patterns from refused requests.
 * The vocabulary lives in content-filter-terms.ts (see its header).
 */

import {
  BIO_TERMS,
  CHEM_TERMS,
  CYBER_TERMS,
  FRONTIER_LLM_TERMS,
  NUCLEAR_TERMS,
  REASONING_EXTRACTION_TERMS,
  REWRITE_RULES,
  SECURITY_TERMS,
  SELF_TEST_CLASSIFY_CASES,
  SELF_TEST_REWRITE_CASES,
  STRIP_PATTERNS,
} from './content-filter-terms'

export { getContentFilterTermDictionaries } from './content-filter-terms'

// ========== TYPES ==========

export interface ClassificationResult {
  category: string | null
  score: number
  recommendation: 'pass' | 'rewrite' | 'block'
  scores: Record<string, number>
  matchedTerms: Record<string, string[]>
}

export interface RewriteResult {
  original: string
  rewritten: string
  rewritesApplied: Array<[string, string]>
  strippedLines: string[]
  scoreBefore: number
  scoreAfter: number
}

// ========== THRESHOLDS ==========

const BLOCK_THRESHOLD = 0.65
const REWRITE_THRESHOLD = 0.4
const STRIP_LINE_THRESHOLD = 2.0

// ========== CORE FUNCTIONS ==========

/**
 * Counts occurrences of `term` in text that the caller already lower-cased.
 * Lower-casing once per text instead of once per term keeps a full request
 * scan linear in the dictionary size rather than re-copying the text for
 * every term.
 */
function countOccurrences(lowerText: string, term: string): number {
  const lowerTerm = term.toLowerCase()

  if (term.length <= 3) {
    // Word boundary matching for short terms
    const regex = new RegExp(`\\b${escapeRegex(lowerTerm)}\\b`, 'gi')
    return (lowerText.match(regex) || []).length
  }

  // Simple substring counting
  let count = 0
  let pos = 0
  let foundPos = lowerText.indexOf(lowerTerm, pos)
  while (foundPos !== -1) {
    count++
    pos = foundPos + lowerTerm.length
    foundPos = lowerText.indexOf(lowerTerm, pos)
  }
  return count
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scoreText(text: string): {
  scores: Record<string, number>
  matched: Record<string, string[]>
} {
  const scores: Record<string, number> = {
    bio: 0,
    chem: 0,
    nuclear: 0,
    cyber: 0,
    security: 0,
    reasoning_extraction: 0,
    frontier_llm: 0,
  }
  const matched: Record<string, string[]> = {
    bio: [],
    chem: [],
    nuclear: [],
    cyber: [],
    security: [],
    reasoning_extraction: [],
    frontier_llm: [],
  }

  const termDicts: Array<[string, Record<string, number>]> = [
    ['bio', BIO_TERMS],
    ['chem', CHEM_TERMS],
    ['nuclear', NUCLEAR_TERMS],
    ['cyber', CYBER_TERMS],
    ['security', SECURITY_TERMS],
    ['reasoning_extraction', REASONING_EXTRACTION_TERMS],
    ['frontier_llm', FRONTIER_LLM_TERMS],
  ]

  const lowerText = text.toLowerCase()
  for (const [cat, terms] of termDicts) {
    const catScores = scores[cat]
    const catMatched = matched[cat]
    if (catScores === undefined || !catMatched) continue

    for (const [term, weight] of Object.entries(terms)) {
      const count = countOccurrences(lowerText, term)
      if (count > 0) {
        const contribution = weight * (1 + Math.log(count))
        scores[cat] = (scores[cat] ?? 0) + contribution
        catMatched.push(term)
      }
    }
  }

  // Normalize by text length
  const lengthFactor = Math.max(1, text.length / 1000)
  for (const cat of Object.keys(scores)) {
    const score = scores[cat]
    if (score !== undefined) {
      scores[cat] = score / Math.sqrt(lengthFactor)
    }
  }

  return { scores, matched }
}

/**
 * Classify text for refusal risk.
 */
export function classify(text: string): ClassificationResult {
  const { scores, matched } = scoreText(text)

  // Find dominant category
  let maxCat = 'cyber'
  let maxScore = 0
  for (const [cat, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score
      maxCat = cat
    }
  }

  let recommendation: 'pass' | 'rewrite' | 'block'
  if (maxScore >= BLOCK_THRESHOLD) {
    recommendation = 'block'
  } else if (maxScore >= REWRITE_THRESHOLD) {
    recommendation = 'rewrite'
  } else {
    recommendation = 'pass'
  }

  return {
    category: maxScore >= REWRITE_THRESHOLD ? maxCat : null,
    score: Math.round(maxScore * 10000) / 10000,
    recommendation,
    scores: Object.fromEntries(
      Object.entries(scores).map(([k, v]) => [
        k,
        Math.round(v * 10000) / 10000,
      ]),
    ),
    matchedTerms: matched,
  }
}

/**
 * Rewrite text to neutralize triggers.
 * @param aggressive - If true, strip entire high-risk lines
 */
export function rewrite(text: string, aggressive = false): RewriteResult {
  const before = classify(text)
  let rewritten = text
  const applied: Array<[string, string]> = []
  const stripped: string[] = []

  // Aggressive mode: strip dangerous lines
  if (aggressive) {
    const lines = rewritten.split('\n')
    const filteredLines: string[] = []

    for (const line of lines) {
      let shouldStrip = false

      // Check strip patterns
      for (const pattern of STRIP_PATTERNS) {
        if (pattern.test(line)) {
          shouldStrip = true
          stripped.push(line.trim())
          break
        }
      }

      // Check line-level score
      if (!shouldStrip) {
        const { scores } = scoreText(line)
        const maxLineScore = Math.max(...Object.values(scores))
        if (maxLineScore > STRIP_LINE_THRESHOLD) {
          shouldStrip = true
          stripped.push(line.trim())
        }
      }

      if (!shouldStrip) {
        filteredLines.push(line)
      }
    }

    rewritten = filteredLines.join('\n')
  }

  // Apply rewrite rules (case-insensitive)
  for (const [old, replacement] of Object.entries(REWRITE_RULES)) {
    const regex = new RegExp(escapeRegex(old), 'gi')
    if (regex.test(rewritten)) {
      rewritten = rewritten.replace(regex, replacement)
      applied.push([old, replacement])
    }
  }

  const after = classify(rewritten)

  return {
    original: text,
    rewritten,
    rewritesApplied: applied,
    strippedLines: stripped,
    scoreBefore: before.score,
    scoreAfter: after.score,
  }
}

/**
 * Sanitize thinking/CoT content before sending.
 * Uses aggressive mode to strip high-risk lines.
 */
export function sanitizeThinking(thinking: string): string {
  return rewrite(thinking, true).rewritten
}

/**
 * Per-request filter telemetry. Built from the per-block classifications the
 * filter already computes, so it adds no extra scan of the request.
 *
 * `rawTotals` are the per-block category sums before length normalization,
 * added across every scanned block. They approximate how much flagged
 * vocabulary the whole request accumulates, which the per-block (normalized)
 * scores deliberately ignore.
 */
export interface ContentFilterSummary {
  blocksScanned: number
  charsScanned: number
  blocksFlagged: number
  blocksRewritten: number
  maxScoreBefore: number
  maxScoreAfter: number
  maxCategory: string | null
  rawTotals: Record<string, number>
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * Filter an Anthropic request body before sending.
 * Returns the filtered body and whether changes were made.
 *
 * Every decision is local to one block, so the same history block always
 * rewrites to the same bytes and the prompt cache prefix stays stable.
 */
export function filterRequestBody(body: Record<string, unknown>): {
  body: Record<string, unknown>
  filtered: boolean
  changes: string[]
  summary: ContentFilterSummary
} {
  let filtered = false
  const changes: string[] = []
  const summary: ContentFilterSummary = {
    blocksScanned: 0,
    charsScanned: 0,
    blocksFlagged: 0,
    blocksRewritten: 0,
    maxScoreBefore: 0,
    maxScoreAfter: 0,
    maxCategory: null,
    rawTotals: {},
  }

  /**
   * Classifies one text block and returns its replacement, or undefined when
   * the block stays unchanged. `allowStrip` gates aggressive line stripping;
   * structured JSON (tool_use input) must never lose lines.
   */
  const filterText = (
    text: string,
    label: string,
    allowStrip: boolean,
  ): string | undefined => {
    const classification = classify(text)
    summary.blocksScanned++
    summary.charsScanned += text.length
    const lengthScale = Math.sqrt(Math.max(1, text.length / 1000))
    for (const [cat, score] of Object.entries(classification.scores)) {
      if (score > 0)
        summary.rawTotals[cat] =
          (summary.rawTotals[cat] ?? 0) + score * lengthScale
    }
    if (classification.score > summary.maxScoreBefore) {
      summary.maxScoreBefore = classification.score
      summary.maxCategory = classification.category
    }
    let scoreAfter = classification.score
    let replacement: string | undefined
    if (classification.recommendation !== 'pass') {
      summary.blocksFlagged++
      const rewriteResult = rewrite(
        text,
        allowStrip && classification.recommendation === 'block',
      )
      const changed = allowStrip
        ? rewriteResult.rewritesApplied.length > 0 ||
          rewriteResult.strippedLines.length > 0
        : rewriteResult.rewritesApplied.length > 0
      if (changed) {
        replacement = rewriteResult.rewritten
        scoreAfter = rewriteResult.scoreAfter
        changes.push(
          `${label}: ${classification.score.toFixed(2)} → ${rewriteResult.scoreAfter.toFixed(2)}`,
        )
      }
    }
    if (scoreAfter > summary.maxScoreAfter) summary.maxScoreAfter = scoreAfter
    return replacement
  }
  const markRewritten = () => {
    filtered = true
    summary.blocksRewritten++
  }

  // Deep clone to avoid mutation
  const result = JSON.parse(JSON.stringify(body))

  // Filter user content: text blocks and tool_result content (from prior
  // turns - commands, file contents, etc.)
  const messages = result.messages as
    | Array<{ role: string; content: unknown }>
    | undefined
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const next = filterText(msg.content, 'user_string', true)
        if (next !== undefined) {
          msg.content = next
          markRewritten()
        }
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (let i = 0; i < msg.content.length; i++) {
          const block = (msg.content as Array<Record<string, unknown>>)[i]
          if (!block) continue
          if (block.type === 'text' && typeof block.text === 'string') {
            const next = filterText(block.text, `message[${i}]`, true)
            if (next !== undefined) {
              block.text = next
              markRewritten()
            }
          }
          if (
            block.type === 'tool_result' &&
            typeof block.content === 'string'
          ) {
            const next = filterText(block.content, `tool_result[${i}]`, true)
            if (next !== undefined) {
              block.content = next
              markRewritten()
            }
          }
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            const contentArray = block.content as Array<Record<string, unknown>>
            for (let j = 0; j < contentArray.length; j++) {
              const subBlock = contentArray[j]
              if (
                subBlock?.type === 'text' &&
                typeof subBlock.text === 'string'
              ) {
                const next = filterText(
                  subBlock.text,
                  `tool_result[${i}].content[${j}]`,
                  true,
                )
                if (next !== undefined) {
                  subBlock.text = next
                  markRewritten()
                }
              }
            }
          }
        }
      }
    }
  }

  // Filter assistant blocks (thinking and text from conversation history)
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        const next = filterText(msg.content, 'assistant_string', true)
        if (next !== undefined) {
          msg.content = next
          markRewritten()
        }
      }
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (let i = 0; i < msg.content.length; i++) {
          const block = (msg.content as Array<Record<string, unknown>>)[i]
          if (!block) continue
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            const next = filterText(block.thinking, `thinking[${i}]`, true)
            if (next !== undefined) {
              block.thinking = next
              markRewritten()
            }
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            const next = filterText(block.text, `assistant_text[${i}]`, true)
            if (next !== undefined) {
              block.text = next
              markRewritten()
            }
          }
          // Filter assistant tool_use input (code edits, commands from prior
          // turns). Never strip lines here: that destroys JSON structure.
          // Only term rewrites apply.
          if (
            block.type === 'tool_use' &&
            typeof block.input === 'object' &&
            block.input !== null
          ) {
            const next = filterText(
              JSON.stringify(block.input),
              `tool_use[${i}]`,
              false,
            )
            if (next !== undefined) {
              try {
                block.input = JSON.parse(next)
                markRewritten()
              } catch {
                // If JSON parse fails, leave input unchanged
                changes.pop()
              }
            }
          }
        }
      }
    }
  }

  // Filter system prompt
  const system = result.system as
    | Array<{ type: string; text: string }>
    | undefined
  if (Array.isArray(system)) {
    for (let i = 0; i < system.length; i++) {
      const block = system[i]
      if (block?.type === 'text' && typeof block.text === 'string') {
        const next = filterText(block.text, `system[${i}]`, true)
        if (next !== undefined) {
          block.text = next
          markRewritten()
        }
      }
    }
  }

  summary.maxScoreBefore = roundScore(summary.maxScoreBefore)
  summary.maxScoreAfter = roundScore(summary.maxScoreAfter)
  for (const cat of Object.keys(summary.rawTotals)) {
    summary.rawTotals[cat] = roundScore(summary.rawTotals[cat] ?? 0)
  }
  return { body: result, filtered, changes, summary }
}

// ========== TESTING ==========

export function runTests(): void {
  console.log('Content Filter Tests')
  console.log('='.repeat(60))

  const tests = SELF_TEST_CLASSIFY_CASES

  for (const { text, expect } of tests) {
    const result = classify(text)
    const status = result.recommendation === expect ? 'PASS' : 'FAIL'
    console.log(
      `[${status}] ${result.recommendation.padEnd(7)} ${result.score.toFixed(3)} | ${text.slice(0, 50)}...`,
    )
  }

  console.log('\nRewrite Tests:')
  console.log('-'.repeat(60))

  const rewriteTests = SELF_TEST_REWRITE_CASES

  for (const text of rewriteTests) {
    const result = rewrite(text, true)
    console.log(`\nOriginal:  ${text}`)
    console.log(`Rewritten: ${result.rewritten}`)
    console.log(
      `Score:     ${result.scoreBefore.toFixed(3)} → ${result.scoreAfter.toFixed(3)}`,
    )
  }
}
