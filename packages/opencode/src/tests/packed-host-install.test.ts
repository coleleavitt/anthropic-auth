import { describe, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime'
import {
  disposableCommandError,
  installPackedHosts,
  isolatedPackedHostEnv,
  packedHostNpmCache,
  packedHostsEnv,
} from './support/packed-host-install'
import { packedHostVersions } from './support/packed-host-versions'

const { test, deferCleanup } = createTestLifetimeSuite()

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'packed-host-install-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

async function manifest(directory: string, pkg: string, version: string) {
  const target = join(directory, 'node_modules', pkg)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'package.json'), JSON.stringify({ version }))
}

async function preparedHosts(root: string) {
  await manifest(join(root, 'install'), '@opencode/cli', packedHostVersions.oc2)
  await manifest(join(root, 'install1'), 'opencode-ai', packedHostVersions.oc1)
  await manifest(
    join(root, 'oc1-config-deps'),
    '@opencode-ai/plugin',
    packedHostVersions.oc1,
  )
}

function installer(root: string) {
  const calls: { args: string[]; cwd: string }[] = []
  const options = {
    path: process.env.PATH ?? '',
    password: 'fixture-password',
    npmCache: packedHostNpmCache(root),
    async run(args: string[], cwd: string) {
      calls.push({ args, cwd })
      if (args[1] === '--version')
        return {
          stdout: `${cwd.endsWith('install1') ? packedHostVersions.oc1 : `opencode v${packedHostVersions.oc2}`}\n`,
        }
      if (args[1] === 'install') {
        if (args.includes(`@opencode/cli@${packedHostVersions.oc2}`))
          await manifest(cwd, '@opencode/cli', packedHostVersions.oc2)
        else if (args.includes(`opencode-ai@${packedHostVersions.oc1}`))
          await manifest(cwd, 'opencode-ai', packedHostVersions.oc1)
        else await manifest(cwd, '@opencode-ai/plugin', packedHostVersions.oc1)
      }
      return { stdout: '' }
    },
  }
  return { calls, options }
}

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

  test('CI saves host downloads immediately after provisioning, before tests can fail', async () => {
    const workspace = resolve(import.meta.dir, '../../../..')
    type Step = {
      id?: string
      if?: string
      uses?: string
      run?: string
      'timeout-minutes'?: number
      with?: { path?: string; key?: string }
    }
    const workflow = Bun.YAML.parse(
      await readFile(join(workspace, '.github/workflows/ci.yml'), 'utf8'),
    ) as { jobs: { unit: { steps: Step[] } } }
    const steps = workflow.jobs.unit.steps
    const restore = steps.findIndex((step) => step.id === 'packed-host-cache')
    const install = steps.findIndex((step) => step.id === 'packed-host-install')
    const save = steps.findIndex((step) =>
      step.uses?.startsWith('actions/cache/save@'),
    )
    const tests = steps.findIndex((step) =>
      step.run?.includes('scripts/ci-unit-tests.ts'),
    )
    expect(restore).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(restore)
    expect(save).toBe(install + 1)
    expect(tests).toBeGreaterThan(save)
    expect(steps[restore]?.uses).toStartWith('actions/cache/restore@')
    for (const step of [steps[restore], steps[install]])
      expect(step?.if).toBe(
        "matrix.suite == 'opencode' && matrix.shard != 'miniflare'",
      )
    expect(steps[install]?.['timeout-minutes']).toBe(5)
    expect(steps[install]?.run).toContain(
      'bun packages/opencode/scripts/install-packed-hosts.ts "$RUNNER_TEMP/packed-opencode-hosts"',
    )
    expect(steps[install]?.run).toContain(
      `${packedHostsEnv}=$RUNNER_TEMP/packed-opencode-hosts`,
    )
    expect(steps[install]?.run).toContain('>> "$GITHUB_ENV"')
    expect(steps[restore]?.with?.path).toBe(
      'node_modules/.cache/opencode-host-npm',
    )
    expect(steps[save]?.with?.path).toBe(steps[restore]?.with?.path)
    expect(steps[restore]?.with?.key).toBe(
      `packed-opencode-npm-v2-\${{ runner.os }}-\${{ runner.arch }}-\${{ steps.packed-host-versions.outputs.key }}`,
    )
    expect(steps[save]?.with?.key).toBe(
      `\${{ steps.packed-host-cache.outputs.cache-primary-key }}`,
    )
    expect(steps[save]?.if).toBe(
      "steps.packed-host-install.outcome == 'success' && steps.packed-host-cache.outputs.cache-hit != 'true'",
    )
    const versions = steps.findIndex(
      (step) => step.id === 'packed-host-versions',
    )
    expect(versions).toBeLessThan(restore)
    expect(steps[versions]?.run).toContain(
      'install-packed-hosts.ts --version-key',
    )
  })

  test('CI cache key reads the same version pins as host verification', async () => {
    const workspace = resolve(import.meta.dir, '../../../..')
    const child = Bun.spawn(
      [
        'bun',
        'packages/opencode/scripts/install-packed-hosts.ts',
        '--version-key',
      ],
      { cwd: workspace, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe(
      `oc1-${packedHostVersions.oc1}-oc2-${packedHostVersions.oc2}`,
    )
    const gate = await readFile(
      join(import.meta.dir, 'opencode2-e2e.test.ts'),
      'utf8',
    )
    expect(gate).toContain('process.env[packedHostsEnv]')
  })

  test('reuses prepared hosts only after checking both package and executable versions', async () => {
    const root = await fixture()
    const prepared = join(root, 'prepared')
    await preparedHosts(prepared)
    const { calls, options } = installer(root)
    const hosts = await installPackedHosts(
      join(root, 'local'),
      options,
      prepared,
    )
    expect(hosts.cli).toBe(join(prepared, 'install/node_modules/.bin/opencode'))
    expect(hosts.oc1).toBe(
      join(prepared, 'install1/node_modules/.bin/opencode'),
    )
    expect(hosts.oc1ConfigDependencies.fixture).toBe(
      join(prepared, 'oc1-config-deps'),
    )
    expect(calls.map(({ args }) => args)).toEqual([
      [hosts.cli, '--version'],
      [hosts.oc1, '--version'],
    ])
    expect(
      await Bun.file(join(root, 'local/install/package.json')).exists(),
    ).toBe(false)
  })

  for (const [directory, pkg] of [
    ['install', '@opencode/cli'],
    ['install1', 'opencode-ai'],
    ['oc1-config-deps', '@opencode-ai/plugin'],
  ] as const) {
    test(`reinstalls locally when prepared ${directory} has a stale ${pkg} version`, async () => {
      const root = await fixture()
      const prepared = join(root, 'prepared')
      await preparedHosts(prepared)
      await manifest(join(prepared, directory), pkg, '0.0.0')
      const { calls, options } = installer(root)
      const hosts = await installPackedHosts(
        join(root, 'local'),
        options,
        prepared,
      )
      expect(hosts.cli).toStartWith(join(root, 'local'))
      expect(
        calls
          .filter(({ args }) => args[1] === 'install')
          .map(({ args }) => args.at(-1)),
      ).toEqual([
        `@opencode/cli@${packedHostVersions.oc2}`,
        `opencode-ai@${packedHostVersions.oc1}`,
        '--ignore-scripts',
      ])
    })
  }

  for (const condition of [
    'absent',
    'missing',
    'wrong executable',
    'broken executable',
  ]) {
    test(`installs locally for ${condition} prepared hosts`, async () => {
      const root = await fixture()
      const prepared = join(root, 'prepared')
      if (condition.includes('executable')) await preparedHosts(prepared)
      const { calls, options } = installer(root)
      const run = options.run
      options.run = async (args, cwd) => {
        if (cwd.startsWith(prepared)) {
          if (condition === 'broken executable')
            throw new Error('not executable')
          return { stdout: '0.0.0\n' }
        }
        return run(args, cwd)
      }
      const hosts = await installPackedHosts(
        join(root, 'local'),
        options,
        condition === 'absent' ? undefined : prepared,
      )
      expect(hosts.cli).toStartWith(join(root, 'local'))
      expect(calls.filter(({ args }) => args[1] === 'install')).toHaveLength(3)
    })
  }

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
