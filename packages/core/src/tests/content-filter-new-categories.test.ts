import { describe, expect, it } from 'bun:test'
import { classify } from '../content-filter'

describe('content-filter reasoning_extraction category', () => {
  it('detects dense verification patterns', () => {
    const text = `
      Claim verified against source: docs/API.md:42 vs real implementation in graph.rs:100
      This claim was confirmed against the actual code.
      The documentation says X but the source shows Y.
    `
    const result = classify(text)
    expect(result.scores.reasoning_extraction).toBeGreaterThan(0)
  })

  it('detects model output extraction language', () => {
    const text = `
      We need to extract reasoning from the model output.
      This duplicates the model's internal reasoning process.
      The reasoning extraction module will capture these patterns.
    `
    const result = classify(text)
    expect(result.scores.reasoning_extraction).toBeGreaterThan(0)
    expect(result.category).toBe('reasoning_extraction')
  })

  it('does not false-positive on normal code review', () => {
    const text = `
      This function handles user authentication.
      It validates the input and returns a token.
      The implementation follows best practices.
    `
    const result = classify(text)
    // Should either be null or very low score
    expect(result.scores.reasoning_extraction).toBeLessThan(0.4)
  })
})

describe('content-filter frontier_llm category', () => {
  it('detects competitor model references', () => {
    const text = `
      GPT-4 and GPT-5 are OpenAI models.
      We should compare how Gemini handles this task.
    `
    const result = classify(text)
    expect(result.scores.frontier_llm).toBeGreaterThan(0)
  })

  it('detects model training language', () => {
    const text = `
      We can fine-tune this model using our dataset.
      Model distillation could help reduce the model size.
    `
    const result = classify(text)
    expect(result.scores.frontier_llm).toBeGreaterThan(0)
  })

  it('does not false-positive on normal discussion', () => {
    const text = `
      The database model stores user preferences.
      This architectural model works well for our use case.
    `
    const result = classify(text)
    expect(result.scores.frontier_llm).toBeLessThan(0.3)
  })
})
