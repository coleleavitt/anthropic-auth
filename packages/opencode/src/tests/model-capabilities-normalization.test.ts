import { expect, test } from 'bun:test'
import { CLAUDE_MODEL_CAPABILITIES } from '@cortexkit/anthropic-auth-core'
import { rewriteRequestBody } from '../transform'

// OpenCode still normalizes thinking and tool_choice with per-family code.
// These checks keep that code and the capability table's recorded facts in
// agreement for every row, so a new row with different facts fails here until
// the normalizer handles it.

async function rewrite(model: string, extra: Record<string, unknown>) {
  return JSON.parse(
    await rewriteRequestBody(
      JSON.stringify({
        model,
        max_tokens: 32_000,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [
          {
            name: 'board',
            description: 'Board',
            input_schema: { type: 'object' },
          },
        ],
        ...extra,
      }),
    ),
  ) as Record<string, unknown>
}

for (const row of CLAUDE_MODEL_CAPABILITIES) {
  test(`${row.id}: OpenCode thinking normalization matches thinkingModes`, async () => {
    for (const mode of ['disabled', 'between_tools'] as const) {
      const rewritten = await rewrite(row.id, { thinking: { type: mode } })
      const type = (rewritten.thinking as { type?: string } | undefined)?.type
      expect(type === mode).toBe(row.thinkingModes.includes(mode))
    }
    const adaptive = await rewrite(row.id, {
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    expect(adaptive.thinking).toMatchObject({ type: 'adaptive' })
    expect(row.thinkingModes).toContain('adaptive')
  })

  test(`${row.id}: OpenCode forced tool_choice handling matches rejectsForcedToolChoice`, async () => {
    const rewritten = await rewrite(row.id, { tool_choice: { type: 'any' } })
    expect(Object.hasOwn(rewritten, 'tool_choice')).toBe(
      !row.rejectsForcedToolChoice,
    )
  })
}
