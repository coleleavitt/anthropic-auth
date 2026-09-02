import { describe, expect, test } from 'bun:test'
import {
  EFFORT_MARKER_PREFIX,
  EFFORT_PLAN_MARKER_PREFIX,
  markOpenCodeEffortTransitions,
} from '../effort-history.ts'

const NONCE = '00000000-0000-4000-8000-000000000000'

const user = (
  id: string,
  sessionID: string,
  modelID: string,
  variant?: string,
  providerID = 'anthropic',
) => ({
  info: {
    id,
    role: 'user',
    sessionID,
    model: { providerID, modelID, variant },
  },
  parts: [{ type: 'text', text: id }],
})

const assistant = (id: string, sessionID: string) => ({
  info: { id, role: 'assistant', sessionID },
  parts: [] as Array<Record<string, unknown>>,
})

function markerTexts(messages: Array<{ parts?: Array<{ text?: unknown }> }>) {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      typeof part.text === 'string' &&
      part.text.startsWith(EFFORT_MARKER_PREFIX)
        ? [part.text]
        : [],
    ),
  )
}

describe('OpenCode Fable 5.1 effort markers', () => {
  test('marks user boundaries independently of OpenCode assistant record counts', () => {
    const messages = [
      user('msg_low', 'ses_effort', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_effort'),
      assistant('msg_step_2', 'ses_effort'),
      user('msg_high', 'ses_effort', 'claude-fable-5-1', 'high'),
      assistant('msg_step_3', 'ses_effort'),
      user('msg_max', 'ses_effort', 'claude-fable-5-1', 'max'),
    ]

    const marked = markOpenCodeEffortTransitions(messages, NONCE)

    expect(marked).toEqual({
      nonce: NONCE,
      baseline: 'low',
      markerCount: 2,
    })
    const markers = markerTexts(messages)
    expect(markers).toHaveLength(2)
    expect(markers[0]).toContain('effort="h"')
    expect(markers[1]).toContain('effort="z"')
    expect(
      markers.every((marker) => / sig="[0-9a-f]{32}"\/>$/.test(marker)),
    ).toBe(true)
  })

  test('replaces its own markers when the host invokes the transform twice', () => {
    const messages = [
      user('msg_low', 'ses_repeat', 'claude-fable-5-1', 'low'),
      assistant('msg_step', 'ses_repeat'),
      user('msg_high', 'ses_repeat', 'claude-fable-5-1', 'high'),
    ]

    markOpenCodeEffortTransitions(messages, NONCE)
    const secondNonce = '11111111-1111-4111-8111-111111111111'
    expect(markOpenCodeEffortTransitions(messages, secondNonce)).toEqual({
      nonce: secondNonce,
      baseline: 'low',
      markerCount: 1,
    })
    expect(markerTexts(messages)).toHaveLength(1)
    expect(
      messages.flatMap((message) =>
        message.parts.filter(
          (part) =>
            typeof part.text === 'string' &&
            part.text.startsWith(EFFORT_PLAN_MARKER_PREFIX),
        ),
      ),
    ).toHaveLength(1)
  })

  test('defers a change past user records that OpenCode will not lower', () => {
    const dropped = user(
      'msg_dropped_high',
      'ses_deferred',
      'claude-fable-5-1',
      'high',
    )
    dropped.parts = []
    const current = user(
      'msg_current_high',
      'ses_deferred',
      'claude-fable-5-1',
      'high',
    )
    const messages = [
      user('msg_low', 'ses_deferred', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_deferred'),
      dropped,
      assistant('msg_step_2', 'ses_deferred'),
      current,
    ]

    expect(markOpenCodeEffortTransitions(messages, NONCE)).toEqual({
      nonce: NONCE,
      baseline: 'low',
      markerCount: 1,
    })
    expect(dropped.parts).toEqual([])
    expect(markerTexts([current])).toHaveLength(1)

    const droppedBaseline = user(
      'msg_dropped_low',
      'ses_dropped_baseline',
      'claude-fable-5-1',
      'low',
    )
    droppedBaseline.parts = []
    const firstLowered = user(
      'msg_first_lowered',
      'ses_dropped_baseline',
      'claude-fable-5-1',
      'high',
    )
    expect(
      markOpenCodeEffortTransitions([droppedBaseline, firstLowered], NONCE),
    ).toEqual({ nonce: NONCE, baseline: 'high', markerCount: 0 })
    expect(markerTexts([firstLowered])).toHaveLength(0)
  })

  test('folds the compaction effort and ignores reordered retained variants', () => {
    const compaction = user(
      'msg_300',
      'ses_compact',
      'claude-fable-5-1',
      'high',
    )
    compaction.parts.unshift({ type: 'compaction', text: '' })
    const retained = user('msg_100', 'ses_compact', 'claude-fable-5-1', 'low')
    const current = user('msg_400', 'ses_compact', 'claude-fable-5-1', 'xhigh')
    const messages = [
      compaction,
      assistant('msg_301', 'ses_compact'),
      retained,
      assistant('msg_101', 'ses_compact'),
      current,
    ]

    expect(markOpenCodeEffortTransitions(messages, NONCE)).toEqual({
      nonce: NONCE,
      baseline: 'high',
      markerCount: 1,
    })
    expect(markerTexts([retained])).toEqual([])
    expect(markerTexts([current])).toHaveLength(1)
    expect(markerTexts([current])[0]).toContain('effort="x"')
  })

  test('defaults absent variants to high and does not mark non-Fable requests', () => {
    const defaulted = [user('msg_default', 'ses_default', 'claude-fable-5-1')]
    expect(markOpenCodeEffortTransitions(defaulted, NONCE)).toEqual({
      nonce: NONCE,
      baseline: 'high',
      markerCount: 0,
    })
    expect(
      defaulted[0]?.parts.filter(
        (part) =>
          typeof part.text === 'string' &&
          part.text.startsWith(EFFORT_PLAN_MARKER_PREFIX),
      ),
    ).toHaveLength(1)

    const otherModel = [
      user('msg_other', 'ses_other', 'claude-mythos-5-1', 'max'),
    ]
    expect(markOpenCodeEffortTransitions(otherModel, NONCE)).toBeNull()
    expect(markerTexts(otherModel)).toEqual([])
  })
})
