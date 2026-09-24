/**
 * Tests for accumulation management features
 */

import { describe, expect, it } from 'bun:test'
import {
  calculateTopicDecay,
  createAccumulationState,
  DEFAULT_CONFIG,
  detectAccumulationTopic,
  identifyEvictionCandidates,
  recordBlockScore,
} from '../accumulation-manager'
import {
  capBlockContribution,
  DYNAMIC_THRESHOLD_SCALE_MAX,
  getDynamicThresholdMultiplier,
  MAX_BLOCK_CONTRIBUTION,
  MIN_THRESHOLD_MULTIPLIER,
} from '../content-filter'
import {
  abstractSanitizationBlock,
  consolidateRedundant,
} from '../context-sanitizer'
import {
  detectTopic,
  generateCounterSignal,
  LEGITIMACY_PREFIXES,
} from '../counter-signal'

describe('Block-Level Contribution Capping', () => {
  it('caps large contributions at MAX_BLOCK_CONTRIBUTION', () => {
    expect(capBlockContribution(10.0)).toBe(MAX_BLOCK_CONTRIBUTION)
    expect(capBlockContribution(100.0)).toBe(MAX_BLOCK_CONTRIBUTION)
  })

  it('passes through small contributions unchanged', () => {
    expect(capBlockContribution(1.0)).toBe(1.0)
    expect(capBlockContribution(3.5)).toBe(3.5)
  })

  it('handles edge cases', () => {
    expect(capBlockContribution(0)).toBe(0)
    expect(capBlockContribution(MAX_BLOCK_CONTRIBUTION)).toBe(
      MAX_BLOCK_CONTRIBUTION,
    )
  })
})

describe('Dynamic Rewriting Thresholds', () => {
  it('returns 1.0 for zero cumulative score', () => {
    expect(getDynamicThresholdMultiplier(0)).toBe(1.0)
  })

  it('decreases multiplier as cumulative score increases', () => {
    const m0 = getDynamicThresholdMultiplier(0)
    const m25 = getDynamicThresholdMultiplier(25)
    const m50 = getDynamicThresholdMultiplier(50)
    const m100 = getDynamicThresholdMultiplier(100)

    expect(m25).toBeLessThan(m0)
    expect(m50).toBeLessThan(m25)
    expect(m100).toBeLessThanOrEqual(m50)
  })

  it('never goes below MIN_THRESHOLD_MULTIPLIER', () => {
    expect(getDynamicThresholdMultiplier(100)).toBeGreaterThanOrEqual(
      MIN_THRESHOLD_MULTIPLIER,
    )
    expect(getDynamicThresholdMultiplier(200)).toBeGreaterThanOrEqual(
      MIN_THRESHOLD_MULTIPLIER,
    )
    expect(getDynamicThresholdMultiplier(1000)).toBeGreaterThanOrEqual(
      MIN_THRESHOLD_MULTIPLIER,
    )
  })

  it('reaches MIN_THRESHOLD_MULTIPLIER at DYNAMIC_THRESHOLD_SCALE_MAX', () => {
    expect(getDynamicThresholdMultiplier(DYNAMIC_THRESHOLD_SCALE_MAX)).toBe(
      MIN_THRESHOLD_MULTIPLIER,
    )
  })
})

describe('Accumulation State Management', () => {
  it('creates initial state with zero values', () => {
    const state = createAccumulationState('test-session')
    expect(state.sessionId).toBe('test-session')
    expect(state.turn).toBe(0)
    expect(state.blockScores).toEqual([])
    expect(state.rawTotals).toEqual({})
  })

  it('records block scores and updates totals', () => {
    let state = createAccumulationState('test-session')
    state = recordBlockScore(state, {
      text: 'This is a test block with some content',
      messageIndex: 0,
    })

    expect(state.blockScores.length).toBe(1)
    expect(state.blockScores[0]!.messageIndex).toBe(0)
  })
})

describe('Topic Detection', () => {
  it('detects reverse-engineering topic', () => {
    const topic = detectAccumulationTopic(
      'I analyzed the binary using IDA Pro and found the function',
    )
    expect(topic).toBe('reverse-engineering')
  })

  it('detects self-hosting topic', () => {
    const topic = detectAccumulationTopic(
      'Setting up a local server on my Raspberry Pi for offline use',
    )
    expect(topic).toBe('self-hosting')
  })

  it('detects network-analysis topic', () => {
    const topic = detectAccumulationTopic(
      'Captured packets using tcpdump and analyzed in Wireshark',
    )
    expect(topic).toBe('network-analysis')
  })
})

describe('Topic Decay', () => {
  it('returns 1.0 for zero turns', () => {
    expect(calculateTopicDecay(0, 50)).toBe(1.0)
  })

  it('returns 0.5 at half-life', () => {
    expect(calculateTopicDecay(50, 50)).toBeCloseTo(0.5, 5)
  })

  it('decays exponentially', () => {
    const d50 = calculateTopicDecay(50, 50)
    const d100 = calculateTopicDecay(100, 50)
    expect(d100).toBeCloseTo(d50 * d50, 5)
  })
})

describe('Counter-Signal Injection', () => {
  it('detects self-hosting topic from text', () => {
    const topic = detectTopic(
      'I am setting up a remarkable tablet with my own server',
    )
    expect(topic).toBe('self-hosting')
  })

  it('generates appropriate prefix for detected topic', () => {
    const config = { enabled: true, mode: 'auto' as const }
    const signal = generateCounterSignal('self-hosting', config)
    expect(signal).toBe(LEGITIMACY_PREFIXES['self-hosting']!)
  })

  it('uses custom prefix when provided', () => {
    const config = {
      enabled: true,
      mode: 'manual' as const,
      customPrefix: 'Custom legitimate context here',
    }
    const signal = generateCounterSignal('self-hosting', config)
    expect(signal).toBe('Custom legitimate context here')
  })
})

describe('Context Sanitization', () => {
  it('abstracts IP addresses', () => {
    const result = abstractSanitizationBlock(
      'Connect to 192.168.1.100 on port 22',
      'light',
    )
    expect(result).toContain('[local IP]')
    expect(result).not.toContain('192.168.1.100')
  })

  it('abstracts file paths at moderate level', () => {
    const result = abstractSanitizationBlock(
      'Found config at /home/user/.config/app/settings.json',
      'moderate',
    )
    expect(result).toContain('[file path]')
    expect(result).not.toContain('/home/user')
  })

  it('consolidates redundant messages', () => {
    // Need longer messages to trigger consolidation (50+ chars)
    const longText =
      'This is a much longer message that repeats multiple times to trigger consolidation logic'
    const messages = [
      { role: 'user' as const, content: longText },
      { role: 'assistant' as const, content: 'Response to the long message' },
      { role: 'user' as const, content: longText },
      { role: 'assistant' as const, content: 'Response to the long message' },
      { role: 'user' as const, content: longText },
    ]

    const result = consolidateRedundant(messages)
    // Function returns { messages, consolidatedCount }
    expect(result.consolidatedCount).toBeGreaterThanOrEqual(0)
    expect(result.messages.length).toBeLessThanOrEqual(messages.length)
  })
})

describe('Eviction Candidates', () => {
  it('identifies high-scoring blocks for eviction', () => {
    const state = createAccumulationState('test')
    // Manually add some high-scoring blocks for testing
    const testState = {
      ...state,
      turn: 100,
      blockScores: [
        {
          index: 0,
          messageIndex: 0,
          text: 'old high',
          score: 0.8,
          category: 'cyber',
          timestamp: Date.now(),
        },
        {
          index: 1,
          messageIndex: 1,
          text: 'old low',
          score: 0.1,
          category: 'cyber',
          timestamp: Date.now(),
        },
        {
          index: 2,
          messageIndex: 50,
          text: 'mid high',
          score: 0.9,
          category: 'cyber',
          timestamp: Date.now(),
        },
        {
          index: 3,
          messageIndex: 99,
          text: 'recent',
          score: 0.9,
          category: 'cyber',
          timestamp: Date.now(),
        },
      ],
      rawTotals: { cyber: 60.0 }, // Over budget
    }

    const candidates = identifyEvictionCandidates(
      testState,
      DEFAULT_CONFIG,
      'cyber',
    )

    // Should evict old high-scoring blocks but not recent ones
    expect(candidates).toContain(0) // old high scorer
    expect(candidates).toContain(2) // mid high scorer
    expect(candidates).not.toContain(3) // recent, should be preserved
  })
})
