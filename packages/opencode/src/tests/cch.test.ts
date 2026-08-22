import { describe, expect, test } from 'bun:test'
import {
  buildBillingHeaderValue,
  buildCCHPreimage,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'

describe('billing header helpers', () => {
  test('extracts text from the first user message', () => {
    expect(
      extractFirstUserMessageText([
        { role: 'assistant', content: 'ignore me' },
        {
          role: 'user',
          content: [
            { type: 'image', text: 'ignored' },
            { type: 'text', text: 'hello world test message' },
          ],
        },
      ]),
    ).toBe('hello world test message')
  })

  test('skips meta user messages when deriving the billing suffix', () => {
    const messages = [
      { role: 'user', isMeta: true, content: 'meta message' },
      { role: 'user', content: 'audit header capture' },
    ]
    expect(extractFirstUserMessageText(messages)).toBe('audit header capture')
    expect(buildBillingHeaderValue(messages, '2.1.233', 'sdk-cli')).toContain(
      'cc_version=2.1.233.141;',
    )
  })

  test('emits only cch when no attribution is supplied', () => {
    const messages = [{ role: 'user', content: 'audit header capture' }]
    expect(buildBillingHeaderValue(messages, '2.1.233', 'cli')).toBe(
      'x-anthropic-billing-header: cc_version=2.1.233.141; cc_entrypoint=cli; cch=00000;',
    )
  })

  test('matches the Claude Code 2.1.233 segment order and spacing', () => {
    const messages = [{ role: 'user', content: 'audit header capture' }]
    expect(
      buildBillingHeaderValue(messages, '2.1.233', 'cli', undefined, {
        workload: 'cron',
        isSubagent: true,
        previousRequestId: 'req_abc123',
        promptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      }),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.233.141; cc_entrypoint=cli;' +
        ' cch=00000; cc_workload=cron; cc_is_subagent=true;' +
        ' cc_prev_req=req_abc123;' +
        ' cc_prompt_id=6ba7b810-9dad-11d1-80b4-00c04fd430c8;',
    )
  })

  test('omits cc_is_subagent when the request is not a subagent', () => {
    const messages = [{ role: 'user', content: 'audit header capture' }]
    expect(
      buildBillingHeaderValue(messages, '2.1.233', 'cli', undefined, {
        isSubagent: false,
      }),
    ).not.toContain('cc_is_subagent')
  })

  test('rejects malformed request and prompt ids', () => {
    const messages = [{ role: 'user', content: 'audit header capture' }]
    const header = buildBillingHeaderValue(
      messages,
      '2.1.233',
      'cli',
      undefined,
      { previousRequestId: 'not-a-req-id', promptId: 'not-a-uuid' },
    )
    expect(header).not.toContain('cc_prev_req')
    expect(header).not.toContain('cc_prompt_id')
  })

  test('keeps the cch slot at a stable offset for signing', () => {
    const messages = [{ role: 'user', content: 'audit header capture' }]
    const bare = buildBillingHeaderValue(messages, '2.1.233', 'cli')
    const decorated = buildBillingHeaderValue(
      messages,
      '2.1.233',
      'cli',
      undefined,
      { isSubagent: true, workload: 'cron' },
    )
    expect(decorated.indexOf('cch=00000;')).toBe(bare.indexOf('cch=00000;'))
  })

  test('computes the 5-character body cch hash', async () => {
    expect(
      await computeCCH(new TextEncoder().encode('hello world test message')),
    ).toBe('cc124')
  })

  test('matches live Claude Code 2.1.233 billing suffix captures', () => {
    expect(computeVersionSuffix('2.1.233', 'audit header capture')).toBe('141')
    expect(computeVersionSuffix('2.1.233', 'audit oauth header capture')).toBe(
      '8a4',
    )
  })

  test('uses the documented empty-text fallback characters', () => {
    expect(computeVersionSuffix('2.1.233')).toBe('015')
  })

  test('signs serialized request body cch placeholder', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    expect(await signRequestBody(body)).toContain('cch=12a77;')
  })

  test('matches the native 2.1.233 model/max_tokens preimage oracle', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'probe-0' }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.233.000; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
      max_tokens: 1,
      stream: true,
    })
    const preimage = buildCCHPreimage(body)
    expect(preimage).toContain('"model":""')
    expect(preimage).not.toContain('"max_tokens"')
    const signed = await signRequestBody(body)
    expect(signed).toContain('cch=833f0;')
    expect(signed).toContain('"model":"claude-sonnet-4-6"')
    expect(signed).toContain('"max_tokens":1')
  })

  test('globally strips nested model and max_tokens fields like native fetch', async () => {
    expect(buildCCHPreimage('{"input":{"max_tokens":7}}')).toBe('{"input":{}}')
    const header =
      'x-anthropic-billing-header: cc_version=2.1.233.000; cc_entrypoint=sdk-cli; cch=00000;'
    const nestedMax = JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'nested-probe', max_tokens: 7 }],
      system: [{ type: 'text', text: header }],
      max_tokens: 1,
      stream: true,
    })
    expect(await signRequestBody(nestedMax)).toContain('cch=3632a;')

    const nestedModel = JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'nested-model-probe', model: 'nested' },
      ],
      system: [{ type: 'text', text: header }],
      max_tokens: 1,
      stream: true,
    })
    expect(await signRequestBody(nestedModel)).toContain('cch=4db54;')
  })

  test('signs only the billing header cch and leaves message history unchanged', async () => {
    const historyText = 'historical debug content: cch=abcde; cch=00000;'
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: historyText }],
        },
      ],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    const signed = await signRequestBody(body)
    const parsed = JSON.parse(signed)

    expect(parsed.messages[0].content[0].text).toBe(historyText)
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};$/)
    expect(parsed.system[0].text).not.toContain('cch=00000;')
  })

  test('builds the full billing header value', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.87',
        'sdk-cli',
        new Date('2026-04-29'),
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=00000;',
    )
  })
})
