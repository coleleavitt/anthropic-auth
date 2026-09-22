import { describe, expect, test } from 'bun:test'

import {
  ENCRYPTED_CODE_EXECUTION_PLACEHOLDER,
  ENCRYPTED_SEARCH_RESULT_PLACEHOLDER,
  isCodeExecutionOutputRejectedError,
  isEncryptedServerToolContentError,
  isWebSearchContentRejectedError,
  stripEncryptedServerToolContent,
} from '../encrypted-content.ts'

describe('encrypted server-tool 400 classification', () => {
  test('detects each web-search rejection message', () => {
    for (const message of [
      'invalid encrypted_content in search_result block',
      'invalid encrypted_index in text block',
      'failed to decrypt web search result content',
    ]) {
      expect(isWebSearchContentRejectedError(400, message)).toBe(true)
      expect(isEncryptedServerToolContentError(400, message)).toBe(true)
    }
  })

  test('ignores case and backticks, matching Claude Code`s normalizer', () => {
    expect(
      isWebSearchContentRejectedError(
        400,
        'Invalid `encrypted_content` in `search_result` block',
      ),
    ).toBe(true)
  })

  test('detects the code-execution rejection message', () => {
    const body =
      '{"error":{"message":"invalid encrypted_stdout in encrypted_code_execution_result block"}}'
    expect(isCodeExecutionOutputRejectedError(400, body)).toBe(true)
    expect(isWebSearchContentRejectedError(400, body)).toBe(false)
  })

  test('is scoped to 400', () => {
    const body = 'invalid encrypted_content in search_result block'
    expect(isEncryptedServerToolContentError(429, body)).toBe(false)
    expect(isEncryptedServerToolContentError(200, body)).toBe(false)
  })

  test('ignores unrelated 400s', () => {
    expect(
      isEncryptedServerToolContentError(400, 'messages.0: invalid role'),
    ).toBe(false)
  })
})

describe('stripEncryptedServerToolContent', () => {
  test('replaces a search_result block with a text placeholder', () => {
    const result = stripEncryptedServerToolContent(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what changed?' },
              {
                type: 'search_result',
                source: 'https://example.test',
                encrypted_content: 'AAAA',
              },
            ],
          },
        ],
      }),
    )

    expect(result.stripped).toBe(true)
    const parsed = JSON.parse(result.bodyText)
    expect(parsed.messages[0].content[1]).toEqual({
      type: 'text',
      text: ENCRYPTED_SEARCH_RESULT_PLACEHOLDER,
    })
    // Never leaves an empty content array behind.
    expect(parsed.messages[0].content).toHaveLength(2)
  })

  test('replaces an encrypted code-execution result', () => {
    const result = stripEncryptedServerToolContent(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'encrypted_code_execution_result',
                encrypted_stdout: 'BBBB',
              },
            ],
          },
        ],
      }),
    )

    expect(result.stripped).toBe(true)
    expect(JSON.parse(result.bodyText).messages[0].content[0]).toEqual({
      type: 'text',
      text: ENCRYPTED_CODE_EXECUTION_PLACEHOLDER,
    })
  })

  test('drops encrypted_index but keeps the visible text', () => {
    const result = stripEncryptedServerToolContent(
      JSON.stringify({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'per the docs', encrypted_index: 'CCCC' },
            ],
          },
        ],
      }),
    )

    expect(result.stripped).toBe(true)
    expect(JSON.parse(result.bodyText).messages[0].content[0]).toEqual({
      type: 'text',
      text: 'per the docs',
    })
  })

  test('reaches blocks nested inside a tool result', () => {
    const result = stripEncryptedServerToolContent(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'search_result', encrypted_content: 'DDDD' },
                  { type: 'text', text: 'ok' },
                ],
              },
            ],
          },
        ],
      }),
    )

    expect(result.stripped).toBe(true)
    const block = JSON.parse(result.bodyText).messages[0].content[0]
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('toolu_1')
    expect(block.content[0]).toEqual({
      type: 'text',
      text: ENCRYPTED_SEARCH_RESULT_PLACEHOLDER,
    })
    expect(block.content[1]).toEqual({ type: 'text', text: 'ok' })
  })

  test('reports nothing stripped when the body is clean', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    const result = stripEncryptedServerToolContent(body)
    expect(result.stripped).toBe(false)
    expect(result.bodyText).toBe(body)
  })

  test('returns invalid JSON unchanged rather than throwing', () => {
    const result = stripEncryptedServerToolContent('not json')
    expect(result).toEqual({ bodyText: 'not json', stripped: false })
  })

  test('tolerates a body without messages', () => {
    const result = stripEncryptedServerToolContent('{"model":"claude-opus-5"}')
    expect(result.stripped).toBe(false)
  })
})
