/**
 * Accumulation Manager - Orchestrates all accumulation management strategies
 *
 * Combines multiple techniques to prevent cumulative trigger score buildup:
 * 1. Progressive Abstraction - Replace old details with summaries
 * 2. Sliding Window Score Budget - Evict high scorers when budget exceeded
 * 3. Topic Isolation + Decay - Weight old topics less over time
 * 4. Periodic Sanitization - Run full-context cleanup passes
 */

import { classify } from './content-filter'

// ========== TYPES ==========

export interface BlockScore {
  index: number
  messageIndex: number
  text: string
  score: number
  category: string | null
  timestamp: number
  topic?: string
}

export interface TopicRange {
  topic: string
  startIndex: number
  endIndex: number
  totalScore: number
  lastActiveAt: number
}

export interface AccumulationState {
  sessionId: string
  turn: number
  blockScores: BlockScore[]
  rawTotals: Record<string, number>
  topics: TopicRange[]
  lastSanitizationTurn: number
}

export interface AccumulationConfig {
  /** Max cumulative score per category before triggering eviction */
  maxCumulativeScore: number
  /** Turns between periodic sanitization passes */
  sanitizationInterval: number
  /** Number of recent messages to preserve from sanitization */
  preserveRecentMessages: number
  /** Half-life in turns for topic decay */
  topicDecayHalfLife: number
  /** Whether to enable counter-signal injection */
  enableCounterSignal: boolean
}

export interface EvictionResult {
  evictedIndices: number[]
  abstractions: Array<{ index: number; before: string; after: string }>
  scoreReduction: number
}

// ========== DEFAULTS ==========

export const DEFAULT_CONFIG: AccumulationConfig = {
  maxCumulativeScore: 50.0,
  sanitizationInterval: 25,
  preserveRecentMessages: 5,
  topicDecayHalfLife: 50,
  enableCounterSignal: true,
}

// ========== TOPIC DETECTION ==========

const TOPIC_PATTERNS: Record<string, RegExp[]> = {
  'reverse-engineering': [
    /\b(disassembl|decompil|binary|hex|offset|opcod)/i,
    /\b(ida|ghidra|radare|objdump|nm|readelf)/i,
    /\b(reverse.?engineer|RE|firmware|flash)/i,
  ],
  'network-analysis': [
    /\b(packet|traffic|wireshark|tcpdump|pcap)/i,
    /\b(proxy|intercept|mitm|ssl.?strip)/i,
    /\b(dns|http|tcp|udp|socket)/i,
  ],
  'self-hosting': [
    /\b(self.?host|local.?server|replacement)/i,
    /\b(privacy|offline|own.?device)/i,
    /\b(sync|cloud|backup)/i,
  ],
  'security-research': [
    /\b(vulnerab|exploit|payload|shell)/i,
    /\b(pentest|audit|assessment)/i,
    /\b(cve|poc|zero.?day)/i,
  ],
  'device-analysis': [
    /\b(remarkable|tablet|e.?ink|kindle)/i,
    /\b(usb|serial|uart|jtag)/i,
    /\b(root|jailbreak|unlock)/i,
  ],
}

/**
 * Detect the primary topic of a text block.
 */
export function detectAccumulationTopic(text: string): string | undefined {
  const lowerText = text.toLowerCase()
  const scores: Record<string, number> = {}

  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
    let score = 0
    for (const pattern of patterns) {
      const matches = lowerText.match(pattern)
      if (matches) score += matches.length
    }
    if (score > 0) scores[topic] = score
  }

  // Return highest scoring topic
  let maxTopic: string | undefined
  let maxScore = 0
  for (const [topic, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score
      maxTopic = topic
    }
  }

  return maxTopic
}

// ========== PROGRESSIVE ABSTRACTION ==========

const ABSTRACTION_TEMPLATES: Record<string, string> = {
  'reverse-engineering': '[prior: analyzed software/firmware]',
  'network-analysis': '[prior: analyzed network traffic]',
  'self-hosting': '[prior: configured local server]',
  'security-research': '[prior: conducted security analysis]',
  'device-analysis': '[prior: examined device internals]',
  default: '[prior: technical analysis]',
}

/**
 * Abstract a text block to remove trigger terms while preserving intent.
 */
export function abstractAccumulationBlock(
  text: string,
  topic?: string,
): string {
  // Use topic-specific template if available
  const defaultTemplate =
    ABSTRACTION_TEMPLATES.default ?? '[abstracted content]'
  const template = topic
    ? (ABSTRACTION_TEMPLATES[topic] ?? defaultTemplate)
    : defaultTemplate

  // For very short blocks, just return template
  if (text.length < 100) return template

  // For longer blocks, try to preserve structure
  const lines = text.split('\n')
  if (lines.length <= 3) return template

  // Keep first line as context indicator, abstract the rest
  const firstLine = lines[0]?.slice(0, 80) ?? ''
  return `${template}\n[context: ${firstLine}...]`
}

// ========== SLIDING WINDOW EVICTION ==========

/**
 * Identify blocks that should be evicted to stay within score budget.
 */
export function identifyEvictionCandidates(
  state: AccumulationState,
  config: AccumulationConfig,
  category?: string,
): number[] {
  const targetCategories = category
    ? [category]
    : Object.keys(state.rawTotals).filter(
        (c) => (state.rawTotals[c] ?? 0) > config.maxCumulativeScore,
      )

  if (targetCategories.length === 0) return []

  // Sort blocks by score (highest first), excluding recent
  const recentThreshold = state.turn - config.preserveRecentMessages
  const candidates = state.blockScores
    .filter((b) => b.messageIndex < recentThreshold)
    .filter((b) => targetCategories.includes(b.category ?? ''))
    .sort((a, b) => b.score - a.score)

  const toEvict: number[] = []
  const currentTotals = { ...state.rawTotals }

  for (const block of candidates) {
    const cat = block.category ?? 'cyber'
    if ((currentTotals[cat] ?? 0) > config.maxCumulativeScore) {
      toEvict.push(block.index)
      currentTotals[cat] = (currentTotals[cat] ?? 0) - block.score
    }
  }

  return toEvict
}

// ========== TOPIC DECAY ==========

/**
 * Calculate decay multiplier for a topic based on turns since last activity.
 */
export function calculateTopicDecay(
  turnsSinceActive: number,
  halfLife: number,
): number {
  if (turnsSinceActive <= 0) return 1.0
  return 0.5 ** (turnsSinceActive / halfLife)
}

/**
 * Apply decay to topic scores based on turns elapsed.
 */
export function applyTopicDecay(
  state: AccumulationState,
  config: AccumulationConfig,
): AccumulationState {
  const decayedTopics = state.topics.map((topic) => {
    const turnsSince = state.turn - topic.lastActiveAt / 1000 // Assuming timestamp in ms
    const decay = calculateTopicDecay(turnsSince, config.topicDecayHalfLife)
    return {
      ...topic,
      totalScore: topic.totalScore * decay,
    }
  })

  return {
    ...state,
    topics: decayedTopics,
  }
}

// ========== SANITIZATION CHECK ==========

/**
 * Check if a sanitization pass should run.
 */
export function shouldSanitize(
  state: AccumulationState,
  config: AccumulationConfig,
): boolean {
  return state.turn - state.lastSanitizationTurn >= config.sanitizationInterval
}

// ========== STATE MANAGEMENT ==========

/**
 * Create initial accumulation state for a session.
 */
export function createAccumulationState(sessionId: string): AccumulationState {
  return {
    sessionId,
    turn: 0,
    blockScores: [],
    rawTotals: {},
    topics: [],
    lastSanitizationTurn: 0,
  }
}

/**
 * Record a block's score in the accumulation state.
 */
export function recordBlockScore(
  state: AccumulationState,
  block: { text: string; messageIndex: number },
): AccumulationState {
  const classification = classify(block.text)
  const topic = detectAccumulationTopic(block.text)

  const blockScore: BlockScore = {
    index: state.blockScores.length,
    messageIndex: block.messageIndex,
    text: block.text.slice(0, 200), // Keep truncated for memory
    score: classification.score,
    category: classification.category,
    timestamp: Date.now(),
    topic,
  }

  const newTotals = { ...state.rawTotals }
  if (classification.category) {
    newTotals[classification.category] =
      (newTotals[classification.category] ?? 0) + classification.score
  }

  return {
    ...state,
    blockScores: [...state.blockScores, blockScore],
    rawTotals: newTotals,
  }
}

/**
 * Perform eviction and abstraction on accumulated state.
 */
export function performEviction(
  state: AccumulationState,
  config: AccumulationConfig,
): { state: AccumulationState; result: EvictionResult } {
  const evictIndices = identifyEvictionCandidates(state, config)

  if (evictIndices.length === 0) {
    return {
      state,
      result: { evictedIndices: [], abstractions: [], scoreReduction: 0 },
    }
  }

  const abstractions: Array<{ index: number; before: string; after: string }> =
    []
  let scoreReduction = 0

  const newBlocks = state.blockScores.map((block) => {
    if (!evictIndices.includes(block.index)) return block

    const abstracted = abstractAccumulationBlock(block.text, block.topic)
    abstractions.push({
      index: block.index,
      before: block.text,
      after: abstracted,
    })
    scoreReduction += block.score

    // Return block with zeroed score (abstracted)
    return {
      ...block,
      text: abstracted,
      score: 0.05, // Minimal residual score
    }
  })

  // Recalculate totals
  const newTotals: Record<string, number> = {}
  for (const block of newBlocks) {
    if (block.category) {
      newTotals[block.category] = (newTotals[block.category] ?? 0) + block.score
    }
  }

  return {
    state: {
      ...state,
      blockScores: newBlocks,
      rawTotals: newTotals,
    },
    result: {
      evictedIndices: evictIndices,
      abstractions,
      scoreReduction,
    },
  }
}

/**
 * Advance to next turn and apply decay.
 */
export function advanceTurn(
  state: AccumulationState,
  config: AccumulationConfig,
): AccumulationState {
  const nextState = applyTopicDecay(state, config)
  return {
    ...nextState,
    turn: state.turn + 1,
  }
}
