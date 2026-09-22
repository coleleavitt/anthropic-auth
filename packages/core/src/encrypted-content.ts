/**
 * Recovery for credential-bound encrypted server-tool content.
 *
 * Anthropic's server tools (web search, code execution) return blocks whose
 * payload is encrypted against the credential that issued them:
 * `search_result.encrypted_content`, `text.encrypted_index`, and
 * `encrypted_code_execution_result.encrypted_stdout`. Replaying a conversation
 * that carries them against a DIFFERENT OAuth account or API key fails with
 * HTTP 400 and one of the messages below — which is exactly what a
 * fallback-account router does when it migrates a live session.
 *
 * Claude Code 2.1.280 added labels for these (`web_search_content_rejected`,
 * `code_execution_output_rejected`, `cNn`/`dNn` in `chunk-1xqpf2j8.js`) but no
 * strip-and-retry rung: the turn just fails. Here the turn has already been
 * rejected when these run, so replacing the unusable blocks with a plain-text
 * placeholder and retrying once can only improve the outcome.
 */

/** 400 messages Anthropic returns for a web-search payload it cannot decrypt. */
const WEB_SEARCH_CONTENT_REJECTED_MESSAGES = [
  'invalid encrypted_content in search_result block',
  'invalid encrypted_index in text block',
  'failed to decrypt web search result content',
] as const

/** 400 message Anthropic returns for a code-execution payload it cannot decrypt. */
const CODE_EXECUTION_OUTPUT_REJECTED_MESSAGE =
  'invalid encrypted_stdout in encrypted_code_execution_result block'

/** Claude Code's `Sat`: compare case- and backtick-insensitively. */
function normalizeErrorText(body: string): string {
  return body.toLowerCase().replaceAll('`', '')
}

export function isWebSearchContentRejectedError(
  status: number,
  body = '',
): boolean {
  if (status !== 400) return false
  const normalized = normalizeErrorText(body)
  return WEB_SEARCH_CONTENT_REJECTED_MESSAGES.some((message) =>
    normalized.includes(message),
  )
}

export function isCodeExecutionOutputRejectedError(
  status: number,
  body = '',
): boolean {
  if (status !== 400) return false
  return normalizeErrorText(body).includes(
    CODE_EXECUTION_OUTPUT_REJECTED_MESSAGE,
  )
}

/**
 * True when a 400 names encrypted server-tool content this credential cannot
 * decrypt — the signature of a session replayed on a different account.
 */
export function isEncryptedServerToolContentError(
  status: number,
  body = '',
): boolean {
  return (
    isWebSearchContentRejectedError(status, body) ||
    isCodeExecutionOutputRejectedError(status, body)
  )
}

export const ENCRYPTED_SEARCH_RESULT_PLACEHOLDER =
  '[web search result omitted: its encrypted payload was issued to a different account]'
export const ENCRYPTED_CODE_EXECUTION_PLACEHOLDER =
  '[code execution output omitted: its encrypted payload was issued to a different account]'

type Block = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Replace credential-bound encrypted server-tool blocks with plain text.
 *
 * `search_result` and `encrypted_code_execution_result` blocks become a text
 * placeholder (dropping them outright can leave an empty `content` array, which
 * is itself a 400), and `encrypted_index` is removed from text blocks while the
 * visible text is kept. Returns the original text unchanged — and
 * `stripped: false` — when there is nothing to do or the body is not JSON, so a
 * caller can skip a pointless retry.
 */
export function stripEncryptedServerToolContent(bodyText: string): {
  bodyText: string
  stripped: boolean
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { bodyText, stripped: false }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    return { bodyText, stripped: false }
  }

  let stripped = false
  for (const message of parsed.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    message.content = message.content.map((entry: unknown) => {
      if (!isRecord(entry)) return entry
      const block = entry as Block
      if (block.type === 'search_result') {
        stripped = true
        return { type: 'text', text: ENCRYPTED_SEARCH_RESULT_PLACEHOLDER }
      }
      if (block.type === 'encrypted_code_execution_result') {
        stripped = true
        return { type: 'text', text: ENCRYPTED_CODE_EXECUTION_PLACEHOLDER }
      }
      if (block.type === 'text' && 'encrypted_index' in block) {
        stripped = true
        const { encrypted_index: _dropped, ...rest } = block
        return rest
      }
      // Server-tool results nest their blocks one level down.
      if (Array.isArray(block.content)) {
        const nested = stripEncryptedServerToolContent(
          JSON.stringify({ messages: [{ content: block.content }] }),
        )
        if (nested.stripped) {
          stripped = true
          const reparsed = JSON.parse(nested.bodyText) as {
            messages: Array<{ content: unknown }>
          }
          return { ...block, content: reparsed.messages[0]?.content ?? [] }
        }
      }
      return block
    })
  }

  if (!stripped) return { bodyText, stripped: false }
  return { bodyText: JSON.stringify(parsed), stripped: true }
}
