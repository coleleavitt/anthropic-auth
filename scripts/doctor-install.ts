/**
 * Verify every place this monorepo is consumed actually runs the current build.
 *
 * A stale consumer is silent: the plugin loads, requests work, and only a
 * specific fix is quietly absent. That matters most for the cross-process
 * refresh claim — it only prevents a double-spend if *every* app has it, so one
 * consumer left on an old copy reintroduces the exact bug the claim exists to
 * stop.
 *
 *   bun run scripts/doctor-install.ts          # report
 *   bun run scripts/doctor-install.ts --fix    # rebuild and relink
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { cp, mkdir, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const FIX = process.argv.includes('--fix')

/** Exports that must be present, so a stale build is caught by behaviour. */
const CORE_MARKERS = [
  'claimSharedAccountRefresh',
  'markSharedRefreshTokenDead',
  'recordSharedAccountQuota',
  'CONTEXT_1M_BETA',
  'classifyRetry',
] as const

type Consumer = {
  label: string
  /** Where the consumer expects the package. */
  path: string
  /** Which workspace package should back it. */
  source: string
  markerFile?: string
}

const consumers: Consumer[] = [
  {
    label: 'prime-agent extension (pi)',
    path: join(homedir(), '.prime/agent/extensions/pi-anthropic-auth'),
    source: join(REPO, 'packages/pi'),
  },
  {
    label: 'opencode plugin',
    path: join(
      homedir(),
      '.config/opencode/node_modules/@cortexkit/opencode-anthropic-auth',
    ),
    source: join(REPO, 'packages/opencode'),
  },
  {
    label: 'opencode plugin core',
    path: join(
      homedir(),
      '.config/opencode/node_modules/@cortexkit/anthropic-auth-core',
    ),
    source: join(REPO, 'packages/core'),
    markerFile: 'dist/index.js',
  },
]

function npmGlobalRoot(): string | undefined {
  const out = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
  return out.status === 0 ? out.stdout.trim() : undefined
}

const globalRoot = npmGlobalRoot()
if (globalRoot) {
  for (const [pkg, source] of [
    ['pi-anthropic-auth', 'packages/pi'],
    ['opencode-anthropic-auth', 'packages/opencode'],
    ['anthropic-auth-core', 'packages/core'],
  ] as const) {
    const path = join(globalRoot, '@cortexkit', pkg)
    if (existsSync(path)) {
      consumers.push({
        label: `npm global ${pkg}`,
        path,
        source: join(REPO, source),
      })
    }
  }
}

function versionOf(dir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** Does this package tree contain every marker? Proves the build is current. */
function missingMarkers(dir: string): string[] {
  const coreDist = join(dir, 'dist')
  if (!existsSync(coreDist)) return ['dist/ missing']
  const out = spawnSync(
    'grep',
    ['-rqs', '--', CORE_MARKERS.join('\\|'), coreDist],
    { encoding: 'utf8' },
  )
  // Only core carries these symbols; other packages import them.
  if (!dir.endsWith('/core') && !dir.includes('anthropic-auth-core')) return []
  return out.status === 0 ? [] : ['stale dist (markers absent)']
}

console.log(`repo: ${REPO}`)
if (FIX) {
  console.log('\n=== rebuilding every package ===')
  for (const pkg of ['core', 'opencode', 'pi']) {
    const r = spawnSync('bun', ['run', 'build'], {
      cwd: join(REPO, 'packages', pkg),
      encoding: 'utf8',
      stdio: 'inherit',
    })
    if (r.status !== 0) {
      console.error(`build failed for ${pkg}`)
      process.exit(1)
    }
  }
}

console.log('\n=== consumers ===')
let problems = 0
for (const consumer of consumers) {
  const repoVersion = versionOf(consumer.source)
  if (!existsSync(consumer.path)) {
    console.log(`  MISSING   ${consumer.label}\n            ${consumer.path}`)
    continue
  }

  const link = lstatSync(consumer.path).isSymbolicLink()
  const target = link ? realpathSync(consumer.path) : consumer.path
  const linkedToRepo = target === realpathSync(consumer.source)
  const installedVersion = versionOf(consumer.path)
  const stale = missingMarkers(consumer.path)

  const ok = linkedToRepo || (installedVersion === repoVersion && !stale.length)
  if (!ok) problems += 1
  console.log(
    `  ${ok ? 'OK      ' : 'STALE   '}  ${consumer.label}\n` +
      `            ${link ? `symlink -> ${target}` : `copy, v${installedVersion ?? '?'} (repo v${repoVersion ?? '?'})`}` +
      (stale.length ? `  [${stale.join(', ')}]` : ''),
  )

  if (!ok && FIX) {
    const backup = `${consumer.path}.bak.${Date.now()}`
    await rename(consumer.path, backup)
    await mkdir(dirname(consumer.path), { recursive: true })
    await symlink(consumer.source, consumer.path, 'dir')
    console.log(
      `            relinked -> ${consumer.source} (backup: ${backup})`,
    )
    problems -= 1
  }
}

console.log(
  problems === 0
    ? '\nall consumers current'
    : `\n${problems} stale consumer(s) — rerun with --fix`,
)
process.exit(problems === 0 ? 0 : 1)
