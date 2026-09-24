/**
 * Tests for wire-level eviction — SIZE-BASED, SCORE-BLIND, escalating with the
 * old-region size. Eviction must modify the ACTUAL request body.
 */

import { describe, expect, it } from 'bun:test'
import {
  EVICT_AGGRESSIVE_TRIGGER_CHARS,
  EVICT_COMPACT_TRIGGER_CHARS,
  EVICT_FLOOR_COMPACT,
  EVICT_FLOOR_DEFAULT,
  evictionPlaceholder,
  filterRequestBody,
  PRESERVE_RECENT_MESSAGES,
} from '../content-filter'

const filler = 'the quick brown fox jumps over the lazy dog. '
const big = (n: number) =>
  filler.repeat(Math.ceil(n / filler.length)).slice(0, n)

function userText(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}
function asstText(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}
// Pad an old region to a target char size using benign filler messages.
function padOldRegion(targetChars: number, blockSize = 5000) {
  const msgs: Array<Record<string, unknown>> = []
  let acc = 0
  while (acc < targetChars) {
    msgs.push(asstText(big(blockSize)))
    msgs.push(userText('continue'))
    acc += blockSize
  }
  return msgs
}
function recentTail() {
  const t: Array<Record<string, unknown>> = []
  for (let i = 0; i < PRESERVE_RECENT_MESSAGES; i++)
    t.push(userText('recent turn ping'))
  return t
}

describe('wire-level eviction (size-based, escalating)', () => {
  it('placeholder is short and category-aware', () => {
    const p = evictionPlaceholder('cyber')
    expect(p.length).toBeLessThan(120)
    expect(p).toContain('omitted')
  })

  it('does nothing for a tiny session (<= recent window)', () => {
    const messages = [userText(big(4000)), asstText('ok')]
    const { summary } = filterRequestBody({ messages })
    expect(summary.blocksEvicted).toBe(0)
  })

  it('default tier: evicts an old block >= default floor', () => {
    // Small old region (< compact trigger) but an old block over the 1500 floor.
    const messages = [userText(big(EVICT_FLOOR_DEFAULT + 500)), ...recentTail()]
    const { body, summary } = filterRequestBody({ messages })
    const first = (
      (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<
        Record<string, unknown>
      >
    )[0]!
    expect(summary.blocksEvicted).toBeGreaterThanOrEqual(1)
    expect(first.text as string).toContain('omitted')
  })

  it('default tier does NOT evict an old block below the default floor', () => {
    const small = big(900) // < 1500 default floor
    const messages = [userText(small), ...recentTail()]
    const { summary } = filterRequestBody({ messages })
    expect(summary.blocksEvicted).toBe(0)
  })

  it('compact tier: lowers the floor so ~900-char old blocks are evicted', () => {
    // Push old-region size over the compact trigger with a leading 900-char block.
    const lead = userText(big(900))
    const messages = [
      lead,
      ...padOldRegion(EVICT_COMPACT_TRIGGER_CHARS + 10_000),
      ...recentTail(),
    ]
    const { body, summary } = filterRequestBody({ messages })
    const first = (
      (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<
        Record<string, unknown>
      >
    )[0]!
    // 900 < default 1500 but >= compact 800 -> evicted only because we compacted.
    expect(EVICT_FLOOR_COMPACT).toBeLessThanOrEqual(900)
    expect(first.text as string).toContain('omitted')
    expect(summary.blocksEvicted).toBeGreaterThan(1)
  })

  it('aggressive tier: evicts old tool_use inputs too', () => {
    const toolUseMsg = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: big(1200) } },
      ],
    }
    const toolResultMsg = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }],
    }
    const messages = [
      toolUseMsg,
      toolResultMsg,
      ...padOldRegion(EVICT_AGGRESSIVE_TRIGGER_CHARS + 20_000),
      ...recentTail(),
    ]
    const { body, summary } = filterRequestBody({ messages })
    const tu = (
      (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<
        Record<string, unknown>
      >
    )[0]!
    // tool_use block survives (id intact) but its input is evicted to a marker.
    expect(tu.type).toBe('tool_use')
    expect(tu.id).toBe('t1')
    expect((tu.input as Record<string, unknown>)._evicted).toBeDefined()
    expect(summary.blocksEvicted).toBeGreaterThan(1)
  })

  it('never evicts the recent window', () => {
    const messages = [
      ...padOldRegion(EVICT_AGGRESSIVE_TRIGGER_CHARS + 20_000),
      userText(big(9000)), // most recent big block -> must survive
    ]
    const { body } = filterRequestBody({ messages })
    const outMsgs = body.messages as Array<Record<string, unknown>>
    const last = (
      outMsgs[outMsgs.length - 1]!.content as Array<Record<string, unknown>>
    )[0]!
    expect(last.text as string).not.toContain('omitted to manage context')
  })

  it('never evicts a signature-bearing block', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: big(9000), signature: 'abc123' }],
      },
      ...padOldRegion(EVICT_AGGRESSIVE_TRIGGER_CHARS + 20_000),
      ...recentTail(),
    ]
    const { body, summary } = filterRequestBody({ messages })
    const block = (
      (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<
        Record<string, unknown>
      >
    )[0]!
    expect(block.signature).toBe('abc123')
    expect(block.text as string).not.toContain('omitted to manage context')
    // (other blocks in the padded region are still evicted)
    expect(summary.blocksEvicted).toBeGreaterThan(0)
  })

  it('preserves tool_use/tool_result pairing when evicting result content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't9', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't9', content: big(9000) },
        ],
      },
      ...padOldRegion(EVICT_COMPACT_TRIGGER_CHARS + 10_000),
      ...recentTail(),
    ]
    const { body } = filterRequestBody({ messages })
    const outMsgs = body.messages as Array<Record<string, unknown>>
    const tu = (outMsgs[0]!.content as Array<Record<string, unknown>>)[0]!
    const tr = (outMsgs[1]!.content as Array<Record<string, unknown>>)[0]!
    expect(tu.id).toBe('t9')
    expect(tr.tool_use_id).toBe('t9')
    expect(tr.content as string).toContain('omitted')
  })
  it('evicts old thinking text but KEEPS the signature key', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: big(9000), signature: 'sig-old-1' },
        ],
      },
      ...padOldRegion(EVICT_COMPACT_TRIGGER_CHARS + 10_000),
      ...recentTail(),
    ]
    const { body, summary } = filterRequestBody({ messages })
    const think = (
      (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<
        Record<string, unknown>
      >
    )[0]!
    expect(think.type).toBe('thinking')
    expect(think.signature).toBe('sig-old-1') // signature preserved
    expect(think.thinking as string).toContain('omitted') // text evicted
    expect((think.thinking as string).length).toBeLessThan(200)
    expect(summary.blocksEvicted).toBeGreaterThan(0)
  })

  it('never evicts thinking in the recent window (latest verified turn safe)', () => {
    const messages = [
      ...padOldRegion(EVICT_AGGRESSIVE_TRIGGER_CHARS + 20_000),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: big(9000), signature: 'sig-recent' },
        ],
      },
    ]
    const { body } = filterRequestBody({ messages })
    const outMsgs = body.messages as Array<Record<string, unknown>>
    const think = (
      outMsgs[outMsgs.length - 1]!.content as Array<Record<string, unknown>>
    )[0]!
    expect(think.signature).toBe('sig-recent')
    expect(think.thinking as string).not.toContain('omitted to manage context')
    expect((think.thinking as string).length).toBeGreaterThan(1000)
  })
})
