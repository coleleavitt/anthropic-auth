import { describe, expect, it } from 'bun:test'
import { filterRequestBodyGuarded } from '../refusal-guard'
import { getSurrogateThreshold, predictRefusal } from '../refusal-surrogate'
import parity from './refusal-surrogate-parity.json'

interface ParityCase {
  name: string
  text: string
  windows: number
  score: number
}
const hotText = (parity as ParityCase[]).find(
  (c) => c.name === 'hot_cyber',
)!.text

// A COMPACT-tier session whose hot content sits in sub-floor (~500-char) blocks:
// the base size-tiered filter leaves it dangerous, so the surrogate loop must
// escalate eviction to clear it. (Huge sessions are already cleared by the base
// aggressive tier and need no escalation — tested separately below.)
function hotSession(blockChars = 500, nBlocks = 120) {
  const messages: Array<Record<string, unknown>> = []
  for (let i = 0; i < nBlocks; i++) {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: hotText.slice(
            (i * 137) % 3000,
            ((i * 137) % 3000) + blockChars,
          ),
        },
      ],
    })
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: hotText.slice(
            (i * 251) % 4000,
            ((i * 251) % 4000) + blockChars,
          ),
        },
      ],
    })
  }
  for (let i = 0; i < 6; i++)
    messages.push({ role: 'user', content: 'ok continue' })
  return { messages }
}

describe('refusal guard — closed loop (e2e)', () => {
  it('flags a dangerous post-base body and escalates eviction', () => {
    const out = filterRequestBodyGuarded(hotSession())
    expect(out.surrogate.probabilityBefore).toBeGreaterThanOrEqual(
      getSurrogateThreshold(),
    )
    expect(out.surrogate.escalations).toBeGreaterThan(0)
  })

  it('drives P(refuse) below threshold via escalation', () => {
    const out = filterRequestBodyGuarded(hotSession())
    expect(out.surrogate.probabilityAfter).toBeLessThan(out.surrogate.threshold)
    expect(out.surrogate.probabilityAfter).toBeLessThan(
      out.surrogate.probabilityBefore,
    )
    expect(out.surrogate.danger).toBe(false)
  })

  it('the returned body actually re-scores at probabilityAfter', () => {
    const out = filterRequestBodyGuarded(hotSession())
    expect(predictRefusal(out.body).probability).toBeCloseTo(
      out.surrogate.probabilityAfter,
      5,
    )
  })

  it('leaves a benign body untouched (no escalation, not danger)', () => {
    const benign = {
      messages: [
        {
          role: 'user',
          content: 'Please refactor the login form and add tests.',
        },
        {
          role: 'assistant',
          content: 'Sure, here is a plan for the refactor.',
        },
      ],
    }
    const out = filterRequestBodyGuarded(benign)
    expect(out.surrogate.danger).toBe(false)
    expect(out.surrogate.escalations).toBe(0)
  })

  it('preserves signatures through escalated eviction', () => {
    const session = hotSession()
    // inject signed thinking into old turns
    ;(session.messages[0].content as Array<Record<string, unknown>>).push({
      type: 'thinking',
      thinking: hotText.slice(0, 3000),
      signature: 'sig-keep',
    })
    const out = filterRequestBodyGuarded(session)
    const msgs = out.body.messages as Array<Record<string, unknown>>
    for (const m of msgs) {
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === 'thinking') expect('signature' in b).toBe(true)
        }
      }
    }
  })

  it('stamps surrogate telemetry onto the summary (for the outcomes log)', () => {
    const out = filterRequestBodyGuarded(hotSession())
    expect(out.summary.surrogateBefore!).toBeCloseTo(
      out.surrogate.probabilityBefore,
      3,
    )
    expect(out.summary.surrogateAfter!).toBeCloseTo(
      out.surrogate.probabilityAfter,
      3,
    )
    expect(out.summary.surrogateEscalations).toBe(out.surrogate.escalations)
    expect(out.summary.surrogateDanger).toBe(out.surrogate.danger)
    expect(out.summary.surrogateEscalations).toBeGreaterThan(0)
  })

  it('stamps telemetry on the benign fast path too', () => {
    const out = filterRequestBodyGuarded({
      messages: [{ role: 'user', content: 'refactor the react hook please' }],
    })
    expect(typeof out.summary.surrogateBefore).toBe('number')
    expect(out.summary.surrogateEscalations).toBe(0)
    expect(out.summary.surrogateDanger).toBe(false)
  })
})
