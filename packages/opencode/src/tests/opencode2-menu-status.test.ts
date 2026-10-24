import { expect, test } from 'bun:test'
import type {
  NativeAccountRuntime,
  NativeAccountSnapshot,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin/tui'
import { createNativeMenuCapabilities } from '../v2/menu'
import type { NativeSource } from '../v2/source'
import { setupAnthropicTui } from '../v2/tui'

test('account status identifies a disabled main account and named fallbacks', async () => {
  const snapshot: NativeAccountSnapshot = {
    mode: 'local',
    settings: {},
    policyStorage: { version: 1, accounts: [] },
    accounts: [
      { id: 'main', type: 'oauth', source: 'local', enabled: false },
      {
        id: 'synthetic-fallback',
        label: 'Personal',
        type: 'oauth',
        source: 'local',
        enabled: true,
      },
    ],
  }
  const capabilities = createNativeMenuCapabilities({
    runtime: { read: async () => snapshot } as NativeAccountRuntime,
    source: {} as NativeSource,
    start: async () => {},
  })
  try {
    const local = await capabilities.readStatus('account')
    expect(local).toContain('main [main]: disabled, oauth, local')
    expect(local).toContain('Personal [fallback]: enabled, oauth, local')
    expect(local).toContain('Route: synthetic-fallback')
    expect(local).toContain(
      'opencode auth login anthropic --method native-claude-oauth',
    )
    snapshot.mode = 'claustrum'
    const vault = await capabilities.readStatus('account')
    expect(vault).not.toContain('native-claude-oauth')
  } finally {
    capabilities.close()
  }
})

test('View status opens all section lines without dispatching an account action', async () => {
  const lines = [
    'Work [main]: disabled, oauth, local',
    'Personal [fallback]: enabled, oauth, local',
    'First-time model access: connect Anthropic with the native pool login.',
  ]
  const section = {
    id: 'Accounts',
    title: 'Accounts',
    slot: 'accounts',
    lines,
    items: [],
    actions: [
      { id: 'add-oauth-start', label: 'Start OAuth sign-in', knobs: [] },
    ],
  }
  const menu = { command: 'claude', title: 'Claude', sections: [section] }
  const alerts: Array<{ title: string; message: string }> = []
  const commands: Array<{ id: string; run: () => Promise<void> }> = []
  let selections = 0
  let applications = 0
  const cleanup = await setupAnthropicTui({
    location: { directory: '/synthetic/project' },
    client: {
      rpc: () => ({
        open: async () => ({ command: 'claude', menu }),
        events: { on: () => () => {} },
        apply: async () => {
          applications++
          throw new Error('Unexpected action')
        },
      }),
    },
    keymap: {
      layer(factory: () => { commands: typeof commands }) {
        commands.push(...factory().commands)
      },
    },
    ui: {
      router: {
        current: () => ({ type: 'session', sessionID: 'synthetic-session' }),
      },
      dialog: {
        async select(options: {
          options: Array<{ title: string; value: unknown }>
        }) {
          selections++
          if (selections === 1) return section
          if (selections === 2) {
            const status = options.options.find(
              (option) => option.title === 'View status',
            )
            expect(status).toBeDefined()
            return status!.value
          }
          return undefined
        },
        async alert(options: { title: string; message: string }) {
          alerts.push(options)
        },
      },
    },
  } as unknown as Plugin.Context)
  try {
    await commands.find((command) => command.id === 'cortexkit.claude')!.run()
    expect(alerts).toEqual([
      { title: 'Accounts status', message: lines.join('\n') },
    ])
    expect(applications).toBe(0)
    expect(selections).toBe(3)
  } finally {
    cleanup()
  }
})
