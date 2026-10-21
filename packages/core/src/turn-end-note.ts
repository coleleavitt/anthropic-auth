import {
  isClaudeFable51Model,
  isClaudeHaiku55Model,
  isClaudeOpus55Model,
  isClaudeSonnet55Model,
} from './models.ts'

export const TURN_END_NOTE_BETA = 'mid-conversation-system-clear-at-2026-08-21'
export const TURN_END_NOTE_MIN_VISIBLE_CHARACTERS = 350
export const TURN_END_NOTE_CONTENT =
  'Your reply above has already reached the user. The tool call after it was housekeeping and changed nothing they need to know. Do not repeat, summarize or rewrite that reply. If no new work remains, end the turn without restating anything.'

const DEFAULT_TOOLS = ['board', 'ctx_reduce'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Model families that get turn-end notes. The note is a turn-scoped system
 * message (`clear_at: "next_user_message"`), which needs the
 * mid-conversation-system-clear-at beta that Claude Code sends for these models.
 */
export function supportsTurnEndNote(model: unknown): boolean {
  return (
    isClaudeFable51Model(model) ||
    isClaudeHaiku55Model(model) ||
    isClaudeOpus55Model(model) ||
    isClaudeSonnet55Model(model)
  )
}

/**
 * Call only on OAuth histories, after effort-marker validation and stripping.
 * Map configured host names with the same stateless mapping used for history,
 * never with the currently declared tool set: declarations can change later.
 */
export function applyTurnEndNotes(
  body: Record<string, unknown>,
  options: {
    tools?: readonly string[]
    mapToolName?: (name: string) => string
    visibleText?: (message: Record<string, unknown>) => string
  } = {},
): number {
  if (!supportsTurnEndNote(body.model) || !Array.isArray(body.messages))
    return 0
  const allowed = new Set(
    (options.tools ?? DEFAULT_TOOLS).map(
      (name) => options.mapToolName?.(name) ?? name,
    ),
  )
  if (!allowed.size) return 0

  const messages: unknown[] = body.messages
  const rewritten: unknown[] = []
  let inserted = 0
  for (let index = 0; index < messages.length; index++) {
    const results = messages[index]
    rewritten.push(results)
    let preceding = index - 1
    // Effort controls may sit between a tool call and its results. They have no
    // visible content and must not hide the assistant/result pair.
    while (preceding >= 0) {
      const control = messages[preceding]
      if (
        !isRecord(control) ||
        control.role !== 'system' ||
        !Array.isArray(control.content) ||
        control.content.length !== 0 ||
        !isRecord(control.output_config)
      )
        break
      preceding--
    }
    const assistant = messages[preceding]
    if (
      !isRecord(assistant) ||
      assistant.role !== 'assistant' ||
      !Array.isArray(assistant.content) ||
      !isRecord(results) ||
      results.role !== 'user' ||
      !Array.isArray(results.content)
    )
      continue

    const visible = options.visibleText
      ? options.visibleText(assistant)
      : assistant.content
          .filter(
            (block: unknown) =>
              isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.trim().length > 0,
          )
          .map((block) => block.text)
          .join('')
    if (visible.length < TURN_END_NOTE_MIN_VISIBLE_CHARACTERS) continue
    const calls = assistant.content.filter(
      (block: unknown) => isRecord(block) && block.type === 'tool_use',
    )
    if (!calls.length || !calls.every((call) => allowed.has(call.name)))
      continue
    const resultIds = new Set(
      results.content
        .filter(
          (block: unknown) => isRecord(block) && block.type === 'tool_result',
        )
        .map((block) => block.tool_use_id),
    )
    if (
      !calls.every(
        (call) => typeof call.id === 'string' && resultIds.has(call.id),
      )
    )
      continue

    // Anthropic rejects a turn-scoped note directly before a user message. This
    // is the only suffix-dependent exception: omit just this note, leaving every
    // other history position unchanged. Never move or rewrite an earlier note.
    const next = messages[index + 1]
    if (isRecord(next) && next.role === 'user') continue
    rewritten.push({
      role: 'system',
      clear_at: 'next_user_message',
      content: TURN_END_NOTE_CONTENT,
    })
    inserted++
  }
  if (inserted) body.messages = rewritten
  return inserted
}
