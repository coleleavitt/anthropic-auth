import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HOLDER_FILE_NAME,
  LEGACY_STATE_LAYOUT,
  resetNativeHolderRegistryForTests,
  resetProcessStateLayoutsForTests,
  resetStateLayoutDecisionsForTests,
  resolveNativePoolPaths,
  setRelocationMoveEnabledForTests,
} from '@cortexkit/anthropic-auth-core'
import { PiNativeRuntime } from '../native.ts'

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setRelocationMoveEnabledForTests(undefined)
  resetStateLayoutDecisionsForTests()
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
})

for (const moveEnabled of [false, true]) {
  test(`Pi keeps its files in place and records itself beside them with moving ${moveEnabled ? 'on' : 'off'}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-layout-')))
    const savedState = process.env.XDG_STATE_HOME
    cleanups.push(async () => {
      if (savedState === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = savedState
      await rm(root, { recursive: true, force: true })
    })
    process.env.XDG_STATE_HOME = join(root, 'state')
    resetNativeHolderRegistryForTests()
    setRelocationMoveEnabledForTests(moveEnabled)
    const agent = join(root, 'agent')
    const runtime = new PiNativeRuntime(join(agent, 'anthropic-auth.json'), {
      vaultPoll: { intervalMs: 0 },
    })
    // Closing waits for initialization, which registers first.
    await runtime.close()
    // Pi's own files, wherever its environment puts them.
    const paths = await resolveNativePoolPaths(
      join(agent, 'anthropic-auth.json'),
      undefined,
      LEGACY_STATE_LAYOUT,
    )
    const holders = JSON.parse(
      await readFile(join(dirname(paths.runtime), HOLDER_FILE_NAME), 'utf8'),
    ) as { entries: Array<Record<string, unknown>> }
    expect(holders.entries).toContainEqual(
      expect.objectContaining({ pid: process.pid, role: 'pi', kind: 'pi' }),
    )
    // Pi never moves: nothing appears in the state folder.
    expect(
      await readdir(join(root, 'state', 'cortexkit', 'anthropic-auth')).catch(
        () => [],
      ),
    ).toEqual([])
  })
}
