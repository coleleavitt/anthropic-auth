import { describe, expect, test } from 'bun:test'

import {
  generateReframeSuggestions,
  getRefusalSuggestion,
  type RefusalSuggestion,
} from '../refusal-suggestions.ts'

// ---------------------------------------------------------------------------
// generateReframeSuggestions
// ---------------------------------------------------------------------------
describe('generateReframeSuggestions', () => {
  test('returns four reframe options for a topic', () => {
    const suggestions = generateReframeSuggestions('buffer overflows')
    expect(suggestions).toHaveLength(4)
    expect(suggestions[0]).toBe("What's the theory behind buffer overflows?")
    expect(suggestions[1]).toBe('How do defenders approach buffer overflows?')
    expect(suggestions[2]).toBe('Compare approaches to buffer overflows')
    expect(suggestions[3]).toBe('What are the tradeoffs of buffer overflows?')
  })

  test('trims whitespace from topic', () => {
    const suggestions = generateReframeSuggestions('  memory safety  ')
    expect(suggestions[0]).toBe("What's the theory behind memory safety?")
  })

  test('returns empty array for empty topic', () => {
    expect(generateReframeSuggestions('')).toEqual([])
    expect(generateReframeSuggestions('   ')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getRefusalSuggestion
// ---------------------------------------------------------------------------
describe('getRefusalSuggestion', () => {
  describe('1st refusal', () => {
    test('returns info severity with reframe action', () => {
      const suggestion = getRefusalSuggestion(1)
      expect(suggestion.message).toBe(
        'Try rephrasing at a higher abstraction level',
      )
      expect(suggestion.severity).toBe('info')
      expect(suggestion.suggestedAction).toBe('reframe')
    })

    test('includes reframe suggestions when topic provided', () => {
      const suggestion = getRefusalSuggestion(1, 'SQL injection')
      expect(suggestion.reframeSuggestions).toBeDefined()
      expect(suggestion.reframeSuggestions).toHaveLength(4)
      expect(suggestion.reframeSuggestions![0]).toContain('SQL injection')
    })

    test('omits reframe suggestions when no topic', () => {
      const suggestion = getRefusalSuggestion(1)
      expect(suggestion.reframeSuggestions).toBeUndefined()
    })
  })

  describe('2nd refusal', () => {
    test('returns warning severity with pivot action', () => {
      const suggestion = getRefusalSuggestion(2)
      expect(suggestion.message).toBe(
        'Consider a different approach to this topic',
      )
      expect(suggestion.severity).toBe('warning')
      expect(suggestion.suggestedAction).toBe('pivot')
    })

    test('does not include reframe suggestions', () => {
      const suggestion = getRefusalSuggestion(2, 'some topic')
      expect(suggestion.reframeSuggestions).toBeUndefined()
    })
  })

  describe('3rd+ refusal', () => {
    test('returns critical severity with split action for count=3', () => {
      const suggestion = getRefusalSuggestion(3)
      expect(suggestion.message).toBe(
        'Session is hot. Recommend: /claude-split',
      )
      expect(suggestion.severity).toBe('critical')
      expect(suggestion.suggestedAction).toBe('split')
    })

    test('returns same for higher counts', () => {
      for (const count of [4, 5, 10, 100]) {
        const suggestion = getRefusalSuggestion(count)
        expect(suggestion.severity).toBe('critical')
        expect(suggestion.suggestedAction).toBe('split')
      }
    })
  })

  describe('edge cases', () => {
    test('normalizes zero to 1', () => {
      const suggestion = getRefusalSuggestion(0)
      expect(suggestion.severity).toBe('info')
      expect(suggestion.suggestedAction).toBe('reframe')
    })

    test('normalizes negative to 1', () => {
      const suggestion = getRefusalSuggestion(-5)
      expect(suggestion.severity).toBe('info')
      expect(suggestion.suggestedAction).toBe('reframe')
    })

    test('floors fractional counts', () => {
      expect(getRefusalSuggestion(1.9).severity).toBe('info')
      expect(getRefusalSuggestion(2.5).severity).toBe('warning')
      expect(getRefusalSuggestion(3.1).severity).toBe('critical')
    })
  })
})

// ---------------------------------------------------------------------------
// Type exhaustiveness
// ---------------------------------------------------------------------------
describe('type contracts', () => {
  test('RefusalSuggestion has required fields', () => {
    const suggestion: RefusalSuggestion = getRefusalSuggestion(1)
    // TypeScript compile-time check - these accesses must be valid
    const _message: string = suggestion.message
    const _severity: 'info' | 'warning' | 'critical' = suggestion.severity
    const _action: 'reframe' | 'pivot' | 'split' = suggestion.suggestedAction
    expect(_message).toBeTruthy()
  })
})
