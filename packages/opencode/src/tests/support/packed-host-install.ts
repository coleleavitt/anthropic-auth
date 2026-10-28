import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function isolatedPackedHostEnv(
  root: string,
  options: { path: string; password: string; npmCache: string },
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
