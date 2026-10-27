import { describe, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl } from './test-fetch'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)

test('extractUrl uses canonical fetch URLs and preserves raw invalid strings', () => {
  expect(extractUrl('https://example.com/a/../b')).toBe('https://example.com/b')
  expect(extractUrl('/relative')).toBe('/relative')
  expect(extractUrl('not a URL')).toBe('not a URL')
})

describe('package metadata', () => {
  test('exports a runtime-loadable TUI entrypoint', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>
      files?: string[]
      'oc-plugin'?: string[]
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
    }

    expect(packageJson.exports?.['./tui']).toEqual({
      types: './dist/tui.d.ts',
      import: './src/tui/entry.mjs',
    })
    expect(packageJson.files).toContain('src/tui.tsx')
    expect(packageJson.files).toContain('src/tui')
    expect(packageJson.files).toContain('src/tui-compiled')
    expect(packageJson.files).toContain('src/sidebar-state.ts')
    expect(packageJson['oc-plugin']).toEqual(['server', 'tui'])
    expect(packageJson.scripts?.build).toContain('bun run build:tui')
    for (const dependency of ['@opentui/core', '@opentui/solid', 'solid-js']) {
      expect(packageJson.dependencies?.[dependency]).toMatch(/^\d/)
    }
  })

  test('raw TUI fallback is loadable for development hosts', async () => {
    const mod = await import('../tui.tsx')
    expect(mod.default?.id).toBe('cortexkit.anthropic-auth')
    expect(mod.default?.tui).toBeFunction()
  })
})
