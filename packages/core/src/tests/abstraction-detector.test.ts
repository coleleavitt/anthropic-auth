import { describe, expect, it } from 'bun:test'
import {
  detectAbstractionLevel,
  suggestHigherAbstraction,
} from '../abstraction-detector.ts'

describe('detectAbstractionLevel', () => {
  describe('concrete level detection', () => {
    const concreteQueries = [
      'Show me the code for authentication',
      'Write a function to parse JSON',
      'Implement a cache invalidation system',
      'Create a new user registration endpoint',
      'Build a rate limiter',
      'Give me the code for OAuth flow',
      'Generate a TypeScript interface',
      'Fix this bug in the login code',
      'Refactor the database module',
      'Add error handling to the API',
    ]

    for (const query of concreteQueries) {
      it(`detects "${query}" as concrete`, () => {
        const result = detectAbstractionLevel(query)
        expect(result.level).toBe('concrete')
        expect(result.riskScore).toBe(0.9)
        expect(result.confidence).toBeGreaterThan(0.5)
      })
    }

    it('provides suggested reframe for concrete queries', () => {
      const result = detectAbstractionLevel('Write a login function')
      expect(result.level).toBe('concrete')
      expect(result.suggestedReframe).toBeDefined()
      expect(result.suggestedReframe).toContain('considerations')
    })
  })

  describe('procedural level detection', () => {
    const proceduralQueries = [
      'How do I set up OAuth authentication?',
      'How can I deploy to production?',
      'Walk me through the release process',
      'What are the steps to configure SSL?',
      'Guide me through database migration',
      'What is the procedure for code review?',
      'How to integrate with the payment API?',
      'Step by step instructions for setup',
    ]

    for (const query of proceduralQueries) {
      it(`detects "${query}" as procedural`, () => {
        const result = detectAbstractionLevel(query)
        expect(result.level).toBe('procedural')
        expect(result.riskScore).toBe(0.6)
      })
    }
  })

  describe('conceptual level detection', () => {
    const conceptualQueries = [
      'How does OAuth work?',
      'What is a refresh token?',
      'Explain the purpose of PKCE',
      'Describe how caching improves performance',
      'Tell me about rate limiting',
      'What are the fundamentals of encryption?',
      'Why does the system use eventual consistency?',
      'What is the role of the relay server?',
    ]

    for (const query of conceptualQueries) {
      it(`detects "${query}" as conceptual`, () => {
        const result = detectAbstractionLevel(query)
        expect(result.level).toBe('conceptual')
        expect(result.riskScore).toBe(0.3)
      })
    }
  })

  describe('meta level detection', () => {
    const metaQueries = [
      'What are the tradeoffs of using JWT vs session tokens?',
      'Compare REST and GraphQL approaches',
      'Pros and cons of microservices',
      'What alternatives exist to Redis for caching?',
      'When should I use WebSockets vs polling?',
      'Best practices for API versioning',
      'What are the implications of eventual consistency?',
      'What approaches can be used for rate limiting?',
    ]

    for (const query of metaQueries) {
      it(`detects "${query}" as meta`, () => {
        const result = detectAbstractionLevel(query)
        expect(result.level).toBe('meta')
        expect(result.riskScore).toBe(0.1)
      })
    }
  })

  describe('edge cases', () => {
    it('handles empty query', () => {
      const result = detectAbstractionLevel('')
      expect(result.level).toBe('conceptual')
      expect(result.confidence).toBe(0)
    })

    it('handles whitespace-only query', () => {
      const result = detectAbstractionLevel('   ')
      expect(result.level).toBe('conceptual')
      expect(result.confidence).toBe(0)
    })

    it('handles query with no pattern matches', () => {
      const result = detectAbstractionLevel('the quick brown fox')
      expect(result.level).toBe('conceptual') // defaults to safer level
      expect(result.confidence).toBe(0.3)
    })

    it('handles mixed signals with confidence scoring', () => {
      // "How do I" is procedural, but overall should still classify
      const result = detectAbstractionLevel(
        'How do I understand the tradeoffs?',
      )
      expect(['procedural', 'meta']).toContain(result.level)
      expect(result.confidence).toBeGreaterThan(0)
    })
  })

  describe('risk scores', () => {
    it('assigns correct risk scores', () => {
      expect(detectAbstractionLevel('Write code').riskScore).toBe(0.9)
      expect(detectAbstractionLevel('How do I do it?').riskScore).toBe(0.6)
      expect(detectAbstractionLevel('What is it?').riskScore).toBe(0.3)
      expect(detectAbstractionLevel('Compare the tradeoffs').riskScore).toBe(
        0.1,
      )
    })
  })
})

describe('suggestHigherAbstraction', () => {
  it('returns null for meta level', () => {
    expect(suggestHigherAbstraction('Compare approaches', 'meta')).toBeNull()
  })

  it('returns null for empty query', () => {
    expect(suggestHigherAbstraction('', 'concrete')).toBeNull()
  })

  it('suggests conceptual framing for concrete queries', () => {
    const suggestion = suggestHigherAbstraction(
      'Write a login function',
      'concrete',
    )
    expect(suggestion).toBeDefined()
    expect(suggestion).toContain('considerations')
    expect(suggestion).toContain('login function')
  })

  it('suggests principle framing for procedural queries', () => {
    const suggestion = suggestHigherAbstraction(
      'How do I implement caching?',
      'procedural',
    )
    expect(suggestion).toBeDefined()
    expect(suggestion).toContain('principle')
  })

  it('suggests tradeoff framing for conceptual queries', () => {
    const suggestion = suggestHigherAbstraction('What is OAuth?', 'conceptual')
    expect(suggestion).toBeDefined()
    expect(suggestion).toContain('tradeoffs')
  })

  it('extracts topic from "Show me the code for X" pattern', () => {
    const suggestion = suggestHigherAbstraction(
      'Show me the code for authentication',
      'concrete',
    )
    expect(suggestion).toContain('authentication')
  })

  it('extracts topic from "Give me X" pattern', () => {
    const suggestion = suggestHigherAbstraction(
      'Give me a rate limiter',
      'concrete',
    )
    expect(suggestion).toContain('rate limiter')
  })

  it('handles quoted topics', () => {
    const suggestion = suggestHigherAbstraction(
      'Write "user validation"',
      'concrete',
    )
    expect(suggestion).toContain('user validation')
  })
})
