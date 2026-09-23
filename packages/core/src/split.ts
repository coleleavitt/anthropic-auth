/**
 * `/claude-split` — Session split command for managing hot sessions.
 *
 * Helps users split a hot session by:
 * 1. Generating a context summary of the current session
 * 2. Providing instructions to start a new session with that summary
 */

import { getHeatLevel, type HeatLevel } from './session-heat.ts'

export const CLAUDE_SPLIT_COMMAND_NAME = 'claude-split'

const SPLIT_STATUS_TITLE = '## Claude Split Status'
const SPLIT_EXECUTE_TITLE = '## Claude Split Summary'
const SPLIT_USAGE_TITLE = '## Claude Split Usage'
const SPLIT_USAGE = 'Usage: `/claude-split` or `/claude-split status`.'

export interface SplitContext {
  sessionId: string
  turn: number
  heatLevel: HeatLevel
  heat: number
  refusalCount: number
  summary: string
}

export interface SplitCommandResult {
  success: boolean
  context: SplitContext
  instructions: string
  clipboardText?: string
}

export type SplitCommandAction =
  | { type: 'status' }
  | { type: 'execute' }
  | { type: 'usage' }

/**
 * Parse /claude-split command arguments.
 */
export function parseSplitCommand(input: string): SplitCommandAction {
  const normalized = input.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'execute' }
  if (normalized.length === 1 && normalized[0] === 'status')
    return { type: 'status' }
  return { type: 'usage' }
}

/**
 * Generate a summary prompt for starting a new session.
 */
export function generateSplitSummary(topics: string[]): string {
  if (!topics.length) {
    return 'Continue from the previous session.'
  }

  const topicList = topics.map((t) => `- ${t}`).join('\n')
  return [
    'Continue from the previous session. Context:',
    '',
    topicList,
    '',
    'Pick up where we left off.',
  ].join('\n')
}

/**
 * Build status display text showing current session heat.
 */
export function buildSplitStatusText(context: {
  sessionId: string
  turn: number
  heat: number
  refusalCount: number
  recentTopics?: string[]
}): string {
  const level = getHeatLevel(context.heat)
  const heatPercent = (context.heat * 100).toFixed(1)

  const lines = [
    SPLIT_STATUS_TITLE,
    '',
    `- Session: \`${context.sessionId.slice(0, 8)}...\``,
    `- Turn: ${context.turn}`,
    `- Heat: ${heatPercent}% (${level})`,
    `- Refusals: ${context.refusalCount}`,
  ]

  if (level === 'hot') {
    lines.push('')
    lines.push(
      '**Warning:** Session is hot. Consider splitting to a fresh session.',
    )
    lines.push('Run `/claude-split` to generate a context summary.')
  } else if (level === 'warm') {
    lines.push('')
    lines.push('Session is warming up. Monitor for refusals.')
  }

  return lines.join('\n')
}

/**
 * Execute split command — generate summary and instructions.
 */
export function executeSplit(sessionContext: {
  sessionId: string
  turn: number
  heat: number
  refusalCount: number
  recentTopics?: string[]
}): SplitCommandResult {
  const level = getHeatLevel(sessionContext.heat)
  const summary = generateSplitSummary(sessionContext.recentTopics ?? [])
  const heatPercent = (sessionContext.heat * 100).toFixed(1)

  const context: SplitContext = {
    sessionId: sessionContext.sessionId,
    turn: sessionContext.turn,
    heatLevel: level,
    heat: sessionContext.heat,
    refusalCount: sessionContext.refusalCount,
    summary,
  }

  const clipboardLines = [
    '---',
    '**Context from previous session:**',
    '',
    summary,
    '---',
  ]
  const clipboardText = clipboardLines.join('\n')

  const instructions = [
    SPLIT_EXECUTE_TITLE,
    '',
    '### Current Session',
    '',
    `- Session: \`${sessionContext.sessionId.slice(0, 8)}...\``,
    `- Turn: ${sessionContext.turn}`,
    `- Heat: ${heatPercent}% (${level})`,
    `- Refusals: ${sessionContext.refusalCount}`,
    '',
    '### Start New Session',
    '',
    'To continue in a fresh session:',
    '',
    '1. Copy the context below',
    '2. Start a new OpenCode session',
    '3. Paste the context as your first message',
    '',
    '### Context to Copy',
    '',
    '```',
    clipboardText,
    '```',
  ]

  return {
    success: true,
    context,
    instructions: instructions.join('\n'),
    clipboardText,
  }
}

/**
 * Execute the /claude-split command based on parsed action.
 */
export function executeSplitCommand(input: {
  argumentsText: string
  sessionContext?: {
    sessionId: string
    turn: number
    heat: number
    refusalCount: number
    recentTopics?: string[]
  }
}): {
  action: SplitCommandAction
  text: string
  clipboardText?: string
} {
  const action = parseSplitCommand(input.argumentsText)

  // Default context if none provided
  const ctx = input.sessionContext ?? {
    sessionId: 'unknown',
    turn: 0,
    heat: 0,
    refusalCount: 0,
    recentTopics: [],
  }

  switch (action.type) {
    case 'status':
      return {
        action,
        text: buildSplitStatusText(ctx),
      }

    case 'execute': {
      const result = executeSplit(ctx)
      return {
        action,
        text: result.instructions,
        clipboardText: result.clipboardText,
      }
    }

    case 'usage':
      return {
        action,
        text: [SPLIT_USAGE_TITLE, '', SPLIT_USAGE].join('\n'),
      }
  }
}
