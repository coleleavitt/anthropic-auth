import { describe, expect, test } from 'bun:test'
import { createStrippedStream, rewriteRequestBody } from '../transform'

describe('content-filter outcome hooks', () => {
  test('onFinish reports a refusal with its category', async () => {
    const payload =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}}}\n\n'
    const seen: Array<[string, string | undefined]> = []
    const response = createStrippedStream(new Response(payload), {
      onFinish: (stopReason, category) => seen.push([stopReason, category]),
    })
    await response.text()
    expect(seen).toEqual([['refusal', 'cyber']])
  })

  test('onFinish reports an ordinary stop once', async () => {
    const payload =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const seen: Array<[string, string | undefined]> = []
    const response = createStrippedStream(new Response(payload), {
      onFinish: (stopReason, category) => seen.push([stopReason, category]),
    })
    await response.text()
    expect(seen).toEqual([['end_turn', undefined]])
  })

  test('a throwing onFinish does not break the stream', async () => {
    const payload =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const response = createStrippedStream(new Response(payload), {
      onFinish: () => {
        throw new Error('telemetry failure')
      },
    })
    await expect(response.text()).resolves.toContain('end_turn')
  })

  test('rewriteRequestBody hands the filter summary to the caller', async () => {
    const summaries: unknown[] = []
    await rewriteRequestBody(
      JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      { onContentFilterSummary: (summary) => summaries.push(summary) },
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ blocksScanned: 1, blocksRewritten: 0 })
  })
})
