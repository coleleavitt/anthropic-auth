import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeAccountRuntime } from '@cortexkit/anthropic-auth-core'
import { createNativeMenuCapabilities } from '../v2/menu'
import type { NativeSource } from '../v2/source'

let dir: string | undefined

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

test('OpenCode 2 enrollment reset keeps a pending request and tells the user to rerun setup', async () => {
  dir = await mkdtemp(join(tmpdir(), 'opencode2-enrollment-reset-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    dir,
    'opencode-enrollment.json',
  )
  // Setup saves the request secret before it proposes, so a pending state
  // without a request id may still match a request the vault stored. The
  // menu must leave it for setup to resume.
  const statePath = join(dir, 'opencode-enrollment-state.json')
  const pending = JSON.stringify({
    version: 1,
    phase: 'pending',
    proposedName: 'anthropic-auth-opencode',
    requestSecret: 'ef'.repeat(32),
    createdAt: 1,
    updatedAt: 1,
  })
  await writeFile(statePath, pending, { mode: 0o600 })
  // Enrollment reset reads only the enrollment files, never the runtime or
  // the native source.
  const capabilities = createNativeMenuCapabilities({
    runtime: {} as NativeAccountRuntime,
    source: {} as NativeSource,
    start: async () => {},
  })
  try {
    const outcome = await capabilities.dispatch(
      { action: 'enrollment-reset', values: {} },
      {},
    )
    expect(outcome).toEqual({
      ok: false,
      text: 'An enrollment request may still be in progress. Quit OpenCode and run setup again; it picks up the same request.',
    })
    expect(await readFile(statePath, 'utf8')).toBe(pending)
  } finally {
    capabilities.close()
  }
})
