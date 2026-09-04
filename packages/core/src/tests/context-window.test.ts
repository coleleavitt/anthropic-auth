import { describe, expect, test } from 'bun:test'

import { selectClaudeCodeBetas } from '../claude-code.ts'
import { CONTEXT_1M_BETA, modelSupportsContext1m } from '../constants.ts'

describe('modelSupportsContext1m', () => {
  test('matches the 1M families and dated release ids', () => {
    for (const id of [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8-20260528',
      'claude-sonnet-4-5',
    ]) {
      expect(modelSupportsContext1m(id)).toBe(true)
    }
  })

  test('does not match genuinely 200k models', () => {
    // These two are the only families the live catalog reports at 200000.
    for (const id of ['claude-opus-4-5', 'claude-haiku-4-5']) {
      expect(modelSupportsContext1m(id)).toBe(false)
    }
  })

  test('honours an explicit [1m] marker', () => {
    expect(modelSupportsContext1m('claude-opus-5[1m]')).toBe(true)
  })

  test('ignores empty and non-string ids', () => {
    for (const id of ['', '   ', undefined, null, 42]) {
      expect(modelSupportsContext1m(id)).toBe(false)
    }
  })
})

describe('selectClaudeCodeBetas — 1M context', () => {
  test('adds the beta for a 1M-capable model', () => {
    // Without this a >200k request is refused outright: HTTP 200,
    // `stop_reason: "refusal"`, no content, and the input billed in full.
    // Verified live: 510k input answers normally once the beta is present.
    expect(selectClaudeCodeBetas({ model: 'claude-opus-4-8' })).toContain(
      CONTEXT_1M_BETA,
    )
  })

  test('omits it for a 200k model', () => {
    expect(selectClaudeCodeBetas({ model: 'claude-opus-4-5' })).not.toContain(
      CONTEXT_1M_BETA,
    )
  })

  test('omits it when no model is named', () => {
    expect(selectClaudeCodeBetas()).not.toContain(CONTEXT_1M_BETA)
  })

  test('suppressContext1m drops the beta for a 1M-capable model', () => {
    // The native account-local credits latch switches later requests back to
    // the standard context path after Anthropic's specific long-context 429.
    expect(
      selectClaudeCodeBetas({ model: 'claude-sonnet-5' }, [], {
        suppressContext1m: true,
      }),
    ).not.toContain(CONTEXT_1M_BETA)
  })

  test('suppressContext1m leaves the other betas intact', () => {
    const betas = selectClaudeCodeBetas({ model: 'claude-sonnet-5' }, [], {
      suppressContext1m: true,
    })
    expect(betas).toContain('claude-code-20250219')
    expect(betas).toContain('oauth-2025-04-20')
  })
})
