/**
 * Bun test preload (see each package's `bunfig.toml`): refuse to run unless
 * `scripts/test-isolated.ts` started this process with a per-run HOME.
 *
 * Bun fixes `os.homedir()` at process start and does not let a preload
 * replace `node:fs`, so isolation cannot be retrofitted from in here. The
 * runner sets it up (and overlays, audits and snapshots the real protected
 * directories); this file only makes sure nobody bypasses the runner with a
 * bare `bun test`.
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const runDir = process.env.ANTHROPIC_AUTH_TEST_ISOLATED

/** Password-database home; Bun's `os.userInfo().homedir` just echoes $HOME. */
function passwdHome(): string | undefined {
  if (typeof process.getuid !== 'function') return undefined
  const entry = spawnSync('getent', ['passwd', String(process.getuid())], {
    encoding: 'utf8',
  })
  return entry.status === 0 ? entry.stdout.split(':')[5]?.trim() : undefined
}

const realHomes = [
  process.env.ANTHROPIC_AUTH_TEST_REAL_HOME,
  passwdHome(),
].filter((home): home is string => Boolean(home))

function refuse(reason: string): never {
  console.error(
    `[test-isolation] refusing to run tests: ${reason}.\n` +
      '  Run them through the isolation runner, e.g. `bun run test` in the package,\n' +
      '  or `bun ../../scripts/test-isolated.ts <bun test args>`.',
  )
  process.exit(1)
}

if (!runDir) refuse('HOME is not isolated')
for (const realHome of realHomes) {
  if (resolve(homedir()) === resolve(realHome)) {
    refuse(`os.homedir() is the real home (${realHome})`)
  }
}
if (!resolve(homedir()).startsWith(resolve(runDir))) {
  refuse(`os.homedir() (${homedir()}) is outside the run directory`)
}
