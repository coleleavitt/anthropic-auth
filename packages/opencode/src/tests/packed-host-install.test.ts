import { describe, expect } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime'
import {
  disposableCommandError,
  isolatedPackedHostEnv,
} from './support/packed-host-install'

const { test, deferCleanup } = createTestLifetimeSuite()

describe('packed host installation', () => {
  test('shares npm downloads without sharing host state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'packed-host-install-'))
    deferCleanup(() => rm(root, { recursive: true, force: true }))
    const npmCache = join(root, 'npm-downloads')
    const options = {
      path: process.env.PATH ?? '',
      password: 'fixture-password',
      npmCache,
    }
    const first = await isolatedPackedHostEnv(join(root, 'oc1'), options)
    const second = await isolatedPackedHostEnv(join(root, 'oc2'), options)
    expect(first.npm_config_cache).toBe(npmCache)
    expect(second.npm_config_cache).toBe(npmCache)
    expect(first.npm_config_prefer_offline).toBe('true')
    expect(first.npm_config_loglevel).toBe('http')
    expect(first.npm_config_foreground_scripts).toBe('true')
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'TMPDIR',
    ]) {
      expect(first[key]).not.toBe(second[key])
      expect((await stat(first[key]!)).isDirectory()).toBe(true)
      expect((await stat(second[key]!)).isDirectory()).toBe(true)
    }
    expect(first.OPENCODE_DB).not.toBe(second.OPENCODE_DB)
    const npm = Bun.spawn(['npm', 'config', 'get', 'cache'], {
      cwd: first.HOME,
      env: first,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [output, errors, exit] = await Promise.all([
      new Response(npm.stdout).text(),
      new Response(npm.stderr).text(),
      npm.exited,
    ])
    expect(errors).toBe('')
    expect(exit).toBe(0)
    expect(output.trim()).toBe(npmCache)
  })

  test('CI restores the cache used by the pinned host installs', async () => {
    const workspace = resolve(import.meta.dir, '../../../..')
    const workflow = await readFile(
      join(workspace, '.github/workflows/ci.yml'),
      'utf8',
    )
    const gate = await readFile(
      join(import.meta.dir, 'opencode2-e2e.test.ts'),
      'utf8',
    )
    expect(workflow).toContain('path: node_modules/.cache/opencode-host-npm')
    expect(workflow).toContain('-oc1-1.18.31-oc2-2.0.22')
    expect(gate).toContain(
      "npmCache: join(workspace, 'node_modules', '.cache', 'opencode-host-npm')",
    )
    expect(gate).toContain("'opencode-ai@1.18.31'")
    expect(gate).toContain("'@opencode/cli@2.0.22'")
  })

  test('failed installs include bounded redacted output tails without host logs', () => {
    const output = Array.from(
      { length: 30 },
      (_, index) => `line ${index}`,
    ).join('\n')
    const error = disposableCommandError(
      ['npm', 'install'],
      {
        stdout: `${output}\npostinstall fixture-secret\n`,
        stderr: `${output}\nnpm http fetch GET registry.example/platform.tgz\n`,
        exit: 137,
        timedOut: true,
      },
      (text) => text.replaceAll('fixture-secret', '[redacted]'),
    )
    expect(error.message).toContain('npm install (exit 137, deadline reached)')
    expect(error.message).toContain('postinstall [redacted]')
    expect(error.message).toContain(
      'npm http fetch GET registry.example/platform.tgz',
    )
    expect(error.message).not.toContain('fixture-secret')
    expect(error.message).not.toContain('line 0\n')
    expect(error.message).toContain('line 29\n')
  })

  test('failed installs explicitly report empty output and non-deadline exits', () => {
    const error = disposableCommandError(
      ['npm', 'install'],
      { stdout: '', stderr: '', exit: 1, timedOut: false },
      (text) => text,
    )
    expect(error.message).toContain('npm install (exit 1)')
    expect(error.message).not.toContain('deadline')
    expect(error.message).toContain('stdout (last lines):\n(no output)')
    expect(error.message).toContain('stderr (last lines):\n(no output)')
  })
})
