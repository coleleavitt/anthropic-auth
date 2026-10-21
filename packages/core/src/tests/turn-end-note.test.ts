import { describe, expect, test } from 'bun:test'
import { selectClaudeCodeBetas } from '../claude-code.ts'
import { nativeAccountSettings } from '../native-account-view.ts'
import {
  projectNativeMigrationSource,
  validateNativeMigrationSettings,
} from '../native-migration-source.ts'
import { applyTurnEndNotes, supportsTurnEndNote } from '../turn-end-note.ts'

const note = {
  role: 'system',
  clear_at: 'next_user_message',
  content:
    'Your reply above has already reached the user. The tool call after it was housekeeping and changed nothing they need to know. Do not repeat, summarize or rewrite that reply. If no new work remains, end the turn without restating anything.',
}
function pair(id: string, names = ['board'], text = 'A'.repeat(350)) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...names.map((name, i) => ({
          type: 'tool_use',
          id: `${id}_${i}`,
          name,
          input: {},
        })),
      ],
    },
    {
      role: 'user',
      content: names.map((_, i) => ({
        type: 'tool_result',
        tool_use_id: `${id}_${i}`,
        content: 'Done',
      })),
    },
  ]
}
const request = (messages: unknown[]) => ({
  model: 'claude-opus-5-5',
  messages,
})

describe('turn-end note history', () => {
  test('replays every earlier note with an identical serialized prefix', () => {
    const history = [{ role: 'user', content: 'Question' }, ...pair('a')]
    const first = request(structuredClone(history))
    expect(applyTurnEndNotes(first)).toBe(1)
    history.push(
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      { role: 'user', content: 'Next' },
      ...pair('b', ['ctx_reduce']),
    )
    const second = request(structuredClone(history))
    expect(applyTurnEndNotes(second)).toBe(2)
    expect(
      JSON.stringify(second.messages.slice(0, first.messages.length)),
    ).toBe(JSON.stringify(first.messages))
    expect(second.messages.at(-1)).toEqual(note)
  })

  test('requires at least 350 exact outgoing visible characters', () => {
    expect(
      applyTurnEndNotes(request(pair('a', ['board'], 'a'.repeat(349)))),
    ).toBe(0)
    const body = request(pair('a', ['board'], 'a'.repeat(350)))
    expect(applyTurnEndNotes(body)).toBe(1)
    expect(body.messages.at(-1)).toEqual(note)
    const split = pair('b')
    split[0]!.content = [
      { type: 'text', text: 'x'.repeat(175) },
      { type: 'text', text: '  \n' },
      { type: 'text', text: 'y'.repeat(174) },
      { type: 'tool_use', id: 'b_0', name: 'board', input: {} },
    ] as any
    expect(applyTurnEndNotes(request(split))).toBe(0)
    ;(split[0]!.content[2] as any).text += 'y'
    expect(applyTurnEndNotes(request(split))).toBe(1)
  })

  test('requires all tool calls to be housekeeping', () => {
    const body = request(pair('a', ['board', 'bash']))
    expect(applyTurnEndNotes(body)).toBe(0)
    expect(body.messages).not.toContainEqual(note)
  })

  test('requires actual visible text and matching results, not just thinking or calls', () => {
    for (const text of ['', ' \t\n'])
      expect(applyTurnEndNotes(request(pair('a', ['board'], text)))).toBe(0)
    const thinking = pair('a')
    thinking[0]!.content = [
      { type: 'thinking', thinking: 'private' },
      { type: 'tool_use', id: 'a_0', name: 'board', input: {} },
    ] as any
    expect(applyTurnEndNotes(request(thinking))).toBe(0)
    expect(applyTurnEndNotes(request([pair('a')[0], pair('b')[1]]))).toBe(0)
    expect(
      applyTurnEndNotes(
        request([
          { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
          { role: 'user', content: 'Next' },
        ]),
      ),
    ).toBe(0)
  })

  test('supports only verified families and each injected note has its main beta', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5-20261001[1m]',
      'claude-fable-5-1',
      'claude-haiku-5-5',
    ]) {
      const body = { ...request(pair('a')), model }
      expect(supportsTurnEndNote(model)).toBe(true)
      expect(applyTurnEndNotes(body)).toBe(1)
      expect(selectClaudeCodeBetas(body).split(',')).toContain(
        'mid-conversation-system-clear-at-2026-08-21',
      )
    }
    for (const model of [
      'claude-opus-5',
      'claude-sonnet-4-5',
      'claude-mythos-5-1',
      'unknown',
      undefined,
    ]) {
      expect(supportsTurnEndNote(model)).toBe(false)
      expect(applyTurnEndNotes({ ...request(pair('a')), model })).toBe(0)
    }
  })

  test('keeps the note byte shape free of cache and effort fields', () => {
    const body = request(pair('a'))
    applyTurnEndNotes(body)
    expect(body.messages.at(-1)).toEqual(note)
    expect(
      selectClaudeCodeBetas(
        { ...body, max_tokens: 1, stream: false },
        [],
        'auxiliary',
      ).split(','),
    ).toContain('mid-conversation-system-clear-at-2026-08-21')
  })

  test('empty configuration disables; stateless host-name mapping allows custom tools', () => {
    expect(applyTurnEndNotes(request(pair('a')), { tools: [] })).toBe(0)
    const body = request(pair('a', ['Cleanup']))
    expect(
      applyTurnEndNotes(body, {
        tools: ['cleanup'],
        mapToolName: (name) => name[0]!.toUpperCase() + name.slice(1),
      }),
    ).toBe(1)
    expect(body.messages.at(-1)).toEqual(note)
  })

  test('the next-user exception removes only the offending note', () => {
    const history = [{ role: 'user', content: 'Question' }, ...pair('a')]
    const first = request(structuredClone(history))
    applyTurnEndNotes(first)
    const second = request([
      ...history,
      { role: 'user', content: 'Next' },
      ...pair('b'),
    ])
    applyTurnEndNotes(second)
    expect(second.messages.slice(0, 3)).toEqual(first.messages.slice(0, 3))
    expect(second.messages[3]).toEqual({ role: 'user', content: 'Next' })
    expect(second.messages.at(-1)).toEqual(note)
    expect(
      second.messages.filter((message: any) => message.clear_at),
    ).toHaveLength(1)
  })

  test('recognizes the assistant across empty effort controls without altering them', () => {
    const [assistant, results] = pair('a')
    const effort = {
      role: 'system',
      content: [],
      output_config: { effort: 'low' },
    }
    const body = request([assistant, effort, results])
    expect(applyTurnEndNotes(body)).toBe(1)
    expect(body.messages).toEqual([assistant, effort, results, note])
  })
})

test('turnEndNote settings survive secret-free native projection and migration, including empty arrays', () => {
  for (const tools of [[], ['board', 'custom']]) {
    const settings = { turnEndNote: { tools, secret: 'not-public' } }
    expect(nativeAccountSettings(settings)).toEqual({ turnEndNote: { tools } })
    expect(() => validateNativeMigrationSettings(settings)).not.toThrow()
    const migrated = projectNativeMigrationSource({
      host: 'opencode',
      storageId: 'a'.repeat(64),
      configDigest: null,
      config: settings,
      state: {},
      hostAuth: {},
    })
    expect(migrated.settings.turnEndNote).toEqual({ tools })
  }
  for (const tools of ['board', [1], null])
    expect(() =>
      validateNativeMigrationSettings({ turnEndNote: { tools } }),
    ).toThrow()
})
