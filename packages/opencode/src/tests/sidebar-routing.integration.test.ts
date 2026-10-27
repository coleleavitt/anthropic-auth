import { describe, expect } from 'bun:test'
import { getPluginTestHandles } from './plugin-test-handles'
import { getPlugin } from './support/opencode1-pool-fixture.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)

function getPluginForTest(
  client?: Parameters<typeof getPlugin>[1],
  directory?: string,
) {
  return client === undefined && directory === undefined
    ? getPlugin(ctx)
    : getPlugin(ctx, client, directory)
}

describe('desktop notice identity (#230)', () => {
  test('orders repeated notices before the same assistant with bounded IDs', async () => {
    const plugin = await getPluginForTest()
    const mint =
      getPluginTestHandles(plugin).notificationMessageIdBeforeAssistant
    const assistant = 'msg_0000000f0000BBBBBBBBBBBBBB'
    let previous = 'msg_0000000efffeAAAAAAAAAAAAAA'
    for (let index = 0; index < 20; index++) {
      const next = mint(assistant, previous)
      if (next === undefined) throw new Error('Expected an ordered notice ID')
      expect(typeof next).toBe('string')
      expect(next > previous).toBe(true)
      expect(next < assistant).toBe(true)
      previous = next
    }
    expect(mint(assistant, assistant)).toBeUndefined()
    expect(mint(assistant, 'msg_ffffffffffffAAAAAAAAAAAAAA')).toBeUndefined()
    expect(mint('invalid', previous)).toBeUndefined()
    expect(mint('msg_000000000000AAAAAAAAAAAAAA')).toBeUndefined()
    expect(
      mint(assistant, `msg_0000000effff${'z'.repeat(112)}`),
    ).toBeUndefined()
  })

  test('bounds notice identities by session and message, retaining recently used sessions', async () => {
    const plugin = await getPluginForTest()
    const track = getPluginTestHandles(plugin).trackDesktopNoticeMessageId
    const has = getPluginTestHandles(plugin).isDesktopNoticeMessage
    for (let index = 0; index < 128; index++) track(`ses_${index}`, 'msg_first')
    track('ses_0', 'msg_recent')
    track('ses_128', 'msg_first')
    expect(has('ses_0', 'msg_recent')).toBe(true)
    expect(has('ses_1', 'msg_first')).toBe(false)
    expect(has('ses_128', 'msg_first')).toBe(true)
    for (let index = 0; index < 5; index++) track('ses_128', `msg_${index}`)
    expect(has('ses_128', 'msg_0')).toBe(false)
    expect(has('ses_128', 'msg_1')).toBe(true)
    expect(has('ses_128', 'msg_4')).toBe(true)
    await plugin.event?.({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'ses_128' } },
      },
    })
    expect(has('ses_128', 'msg_4')).toBe(false)
  })
})
