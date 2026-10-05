import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getPiAccountStoragePath } from '../paths.ts'

const KEYS = [
  'PI_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'PI_AGENT_DIR',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
] as const

describe('getPiAccountStoragePath', () => {
  let dir: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    for (const key of KEYS) delete process.env[key]
    dir = mkdtempSync(join(tmpdir(), 'pi-paths-'))
    process.env.PI_AGENT_DIR = join(dir, 'pi')
    process.env.OPENCODE_CONFIG_DIR = join(dir, 'opencode')
  })

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('shares opencode’s file when pi has no copy of its own', () => {
    expect(getPiAccountStoragePath()).toBe(
      join(dir, 'opencode', 'anthropic-auth.json'),
    )
  })

  it('keeps an existing pi copy', () => {
    mkdirSync(join(dir, 'pi'), { recursive: true })
    writeFileSync(join(dir, 'pi', 'anthropic-auth.json'), '{}')
    expect(getPiAccountStoragePath()).toBe(
      join(dir, 'pi', 'anthropic-auth.json'),
    )
  })

  it('honours explicit file overrides, pi’s first', () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(dir, 'oc.json')
    expect(getPiAccountStoragePath()).toBe(join(dir, 'oc.json'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(dir, 'pi.json')
    expect(getPiAccountStoragePath()).toBe(join(dir, 'pi.json'))
  })
})
