import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packedHostVersions } from './packed-host-versions'

export const packedHostsEnv = 'ANTHROPIC_AUTH_PACKED_HOSTS'
export const packedHostNpmCache = (workspace: string) =>
  join(workspace, 'node_modules', '.cache', 'opencode-host-npm')

type HostEnvOptions = { path: string; password: string; npmCache: string }
type HostInstallOptions = HostEnvOptions & {
  run: (
    args: string[],
    cwd: string,
    env: Record<string, string>,
    phase: string,
    limit?: number,
  ) => Promise<{ stdout: string }>
}

function packedHostPaths(root: string) {
  const oc2Root = join(root, 'install')
  const oc1Root = join(root, 'install1')
  return {
    oc2Root,
    oc1Root,
    cli: join(oc2Root, 'node_modules', '.bin', 'opencode'),
    oc1: join(oc1Root, 'node_modules', '.bin', 'opencode'),
    oc1ConfigDependencies: {
      fixture: join(root, 'oc1-config-deps'),
      version: packedHostVersions.oc1,
    },
  }
}

async function verifyPackedHosts(root: string, options: HostInstallOptions) {
  const hosts = packedHostPaths(root)
  for (const [directory, pkg, version, cli, phase] of [
    [hosts.oc2Root, '@opencode/cli', packedHostVersions.oc2, hosts.cli, 'oc2'],
    [hosts.oc1Root, 'opencode-ai', packedHostVersions.oc1, hosts.oc1, 'oc1'],
    [
      hosts.oc1ConfigDependencies.fixture,
      '@opencode-ai/plugin',
      packedHostVersions.oc1,
    ],
  ] as const) {
    const manifest = JSON.parse(
      await readFile(
        join(directory, 'node_modules', pkg, 'package.json'),
        'utf8',
      ),
    )
    if (manifest.version !== version)
      throw new Error(`Expected ${pkg}@${version}, found ${manifest.version}`)
    if (cli && phase) {
      const env = await isolatedPackedHostEnv(directory, options)
      const result = await options.run(
        [cli, '--version'],
        directory,
        env,
        `${phase}.version`,
      )
      const reportedVersion = result.stdout.trim().replace(/^opencode v/, '')
      if (reportedVersion !== version)
        throw new Error(
          `Expected ${pkg} --version to print ${version}, found ${result.stdout.trim()}`,
        )
    }
  }
  return hosts
}

/** Reuse only executable, exactly pinned hosts; local runs can install their own. */
export async function installPackedHosts(
  root: string,
  options: HostInstallOptions,
  preparedRoot?: string,
) {
  if (preparedRoot) {
    try {
      return await verifyPackedHosts(preparedRoot, options)
    } catch {
      // A stale or incomplete prepared directory must not weaken the host gate.
    }
  }
  const hosts = packedHostPaths(root)
  const env = await isolatedPackedHostEnv(hosts.oc2Root, options)
  try {
    await options.run(
      [
        'npm',
        'ping',
        '--registry=https://registry.npmjs.org',
        '--fetch-retries=0',
        '--fetch-timeout=2000',
      ],
      hosts.oc2Root,
      env,
      'registry',
      10_000,
    )
  } catch (error) {
    throw new Error(
      'Packed OpenCode host verification requires npm registry access. Run this gate in network-enabled CI; no host checks ran.',
      { cause: error },
    )
  }
  for (const [directory, spec, phase] of [
    [hosts.oc2Root, `@opencode/cli@${packedHostVersions.oc2}`, 'oc2.install'],
    [hosts.oc1Root, `opencode-ai@${packedHostVersions.oc1}`, 'oc1.install'],
  ] as const) {
    const hostEnv = await isolatedPackedHostEnv(directory, options)
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ private: true }),
    )
    await options.run(
      ['npm', 'install', '--no-audit', '--no-fund', spec],
      directory,
      hostEnv,
      phase,
    )
  }
  // OC1 installs its own plugin SDK in each config directory before loading
  // plugins. Seed it once while online, then copy it into isolated scenarios.
  const sdk = hosts.oc1ConfigDependencies.fixture
  await mkdir(sdk, { recursive: true })
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({
      dependencies: { '@opencode-ai/plugin': packedHostVersions.oc1 },
    }),
  )
  await options.run(
    ['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts'],
    sdk,
    await isolatedPackedHostEnv(hosts.oc1Root, options),
    'oc1.sdk.install',
  )
  return verifyPackedHosts(root, options)
}

export async function isolatedPackedHostEnv(
  root: string,
  options: HostEnvOptions,
): Promise<Record<string, string>> {
  const directories = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'),
  }
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  )
  return {
    PATH: options.path,
    ...directories,
    // Share immutable package downloads, never host configuration or data.
    npm_config_cache: options.npmCache,
    npm_config_prefer_offline: 'true',
    // npm buffers lifecycle output by default; retain progress if it is killed.
    npm_config_foreground_scripts: 'true',
    npm_config_loglevel: 'http',
    OPENCODE_DB: join(root, 'disposable.sqlite'),
    OPENCODE_SERVER_PASSWORD: options.password,
    OPENCODE_PASSWORD: options.password,
    OPENCODE_ANTHROPIC_AUTH_LOG_FILE: join(root, 'anthropic-auth.log'),
  }
}

export function disposableCommandError(
  args: string[],
  result: {
    stdout: string
    stderr: string
    exit: number
    timedOut: boolean
  },
  redact: (text: string) => string,
): Error {
  // Redact before truncating so a boundary cannot expose part of a secret.
  const tail = (text: string) =>
    redact(text).trimEnd().split('\n').slice(-20).join('\n').slice(-4000) ||
    '(no output)'
  return new Error(
    `Disposable command failed: ${args[0]} ${args[1]} (exit ${result.exit}${result.timedOut ? ', deadline reached' : ''})\nstdout (last lines):\n${tail(result.stdout)}\nstderr (last lines):\n${tail(result.stderr)}`,
  )
}
