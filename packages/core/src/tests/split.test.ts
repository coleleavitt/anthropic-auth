import { describe, expect, it } from 'bun:test'
import {
  buildSplitStatusText,
  CLAUDE_SPLIT_COMMAND_NAME,
  executeSplit,
  executeSplitCommand,
  generateSplitSummary,
  parseSplitCommand,
} from '../split.ts'

describe('parseSplitCommand', () => {
  it('returns execute for empty input', () => {
    expect(parseSplitCommand('')).toEqual({ type: 'execute' })
  })

  it('returns execute for whitespace', () => {
    expect(parseSplitCommand('   ')).toEqual({ type: 'execute' })
  })

  it('returns status for "status" argument', () => {
    expect(parseSplitCommand('status')).toEqual({ type: 'status' })
  })

  it('returns status for "STATUS" (case insensitive)', () => {
    expect(parseSplitCommand('STATUS')).toEqual({ type: 'status' })
  })

  it('returns usage for unknown arguments', () => {
    expect(parseSplitCommand('unknown')).toEqual({ type: 'usage' })
  })

  it('returns usage for multiple arguments', () => {
    expect(parseSplitCommand('status extra')).toEqual({ type: 'usage' })
  })
})

describe('generateSplitSummary', () => {
  it('returns simple message for empty topics', () => {
    const result = generateSplitSummary([])
    expect(result).toBe('Continue from the previous session.')
  })

  it('includes topics in bullet points', () => {
    const result = generateSplitSummary([
      'OAuth implementation',
      'Database design',
    ])
    expect(result).toContain('- OAuth implementation')
    expect(result).toContain('- Database design')
    expect(result).toContain('Continue from the previous session. Context:')
  })

  it('ends with continuation prompt', () => {
    const result = generateSplitSummary(['Topic 1'])
    expect(result).toContain('Pick up where we left off.')
  })
})

describe('buildSplitStatusText', () => {
  it('shows session info', () => {
    const result = buildSplitStatusText({
      sessionId: 'ses_abc123def456',
      turn: 50,
      heat: 0.05,
      refusalCount: 0,
    })
    expect(result).toContain('ses_abc1')
    expect(result).toContain('Turn: 50')
    expect(result).toContain('safe')
  })

  it('shows heat percentage', () => {
    const result = buildSplitStatusText({
      sessionId: 'test',
      turn: 100,
      heat: 0.35,
      refusalCount: 2,
    })
    expect(result).toContain('35.0%')
    expect(result).toContain('hot')
    expect(result).toContain('Refusals: 2')
  })

  it('shows warning for hot sessions', () => {
    const result = buildSplitStatusText({
      sessionId: 'test',
      turn: 100,
      heat: 0.4,
      refusalCount: 3,
    })
    expect(result).toContain('Warning')
    expect(result).toContain('/claude-split')
  })

  it('shows notice for warm sessions', () => {
    const result = buildSplitStatusText({
      sessionId: 'test',
      turn: 65,
      heat: 0.15,
      refusalCount: 0,
    })
    expect(result).toContain('warming up')
  })
})

describe('executeSplit', () => {
  it('returns success with context', () => {
    const result = executeSplit({
      sessionId: 'ses_test123',
      turn: 80,
      heat: 0.25,
      refusalCount: 1,
      recentTopics: ['Topic A', 'Topic B'],
    })
    expect(result.success).toBe(true)
    expect(result.context.turn).toBe(80)
    expect(result.context.heatLevel).toBe('warm')
  })

  it('includes clipboard text', () => {
    const result = executeSplit({
      sessionId: 'test',
      turn: 50,
      heat: 0.05,
      refusalCount: 0,
      recentTopics: ['My topic'],
    })
    expect(result.clipboardText).toContain('My topic')
    expect(result.clipboardText).toContain('Context from previous session')
  })

  it('includes instructions', () => {
    const result = executeSplit({
      sessionId: 'test',
      turn: 50,
      heat: 0.05,
      refusalCount: 0,
    })
    expect(result.instructions).toContain('Start New Session')
    expect(result.instructions).toContain('Copy the context')
  })
})

describe('executeSplitCommand', () => {
  const defaultContext = {
    sessionId: 'ses_test',
    turn: 100,
    heat: 0.35,
    refusalCount: 2,
    recentTopics: ['Topic'],
  }

  it('handles status action', () => {
    const result = executeSplitCommand({
      argumentsText: 'status',
      sessionContext: defaultContext,
    })
    expect(result.action.type).toBe('status')
    expect(result.text).toContain('Turn: 100')
  })

  it('handles execute action', () => {
    const result = executeSplitCommand({
      argumentsText: '',
      sessionContext: defaultContext,
    })
    expect(result.action.type).toBe('execute')
    expect(result.text).toContain('Start New Session')
    expect(result.clipboardText).toBeDefined()
  })

  it('handles usage action', () => {
    const result = executeSplitCommand({
      argumentsText: 'invalid args',
      sessionContext: defaultContext,
    })
    expect(result.action.type).toBe('usage')
    expect(result.text).toContain('Usage')
  })

  it('uses default context when none provided', () => {
    const result = executeSplitCommand({
      argumentsText: 'status',
    })
    expect(result.text).toContain('unknown')
  })
})

describe('CLAUDE_SPLIT_COMMAND_NAME', () => {
  it('is claude-split', () => {
    expect(CLAUDE_SPLIT_COMMAND_NAME).toBe('claude-split')
  })
})
