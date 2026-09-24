#!/usr/bin/env bun

/**
 * Build and install the plugin/extension for local development.
 *
 * Creates symlinks at:
 *   - Prime Agent: ~/.prime/agent/extensions/pi-anthropic-auth -> packages/pi
 *   - OpenCode plugin: ~/.config/opencode/node_modules/@cortexkit/opencode-anthropic-auth -> packages/opencode
 *   - OpenCode core: ~/.config/opencode/node_modules/@cortexkit/anthropic-auth-core -> packages/core
 *
 * Run with: bun run dev:install
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')

type Consumer = {
  label: string
  path: string
  source: string
}

const consumers: Consumer[] = [
  {
    label: 'Prime Agent extension',
    path: join(homedir(), '.prime/agent/extensions/pi-anthropic-auth'),
    source: join(REPO, 'packages/pi'),
  },
  {
    label: 'OpenCode plugin',
    path: join(
      homedir(),
      '.config/opencode/node_modules/@cortexkit/opencode-anthropic-auth',
    ),
    source: join(REPO, 'packages/opencode'),
  },
  {
    label: 'OpenCode core',
    path: join(
      homedir(),
      '.config/opencode/node_modules/@cortexkit/anthropic-auth-core',
    ),
    source: join(REPO, 'packages/core'),
  },
]

async function createSymlink(consumer: Consumer): Promise<boolean> {
  // Check if already correctly linked
  if (existsSync(consumer.path)) {
    try {
      if (lstatSync(consumer.path).isSymbolicLink()) {
        const target = realpathSync(consumer.path)
        if (target === realpathSync(consumer.source)) {
          console.log(`  ✓ ${consumer.label} (already linked)`)
          return true
        }
      }
      // Remove stale link or directory
      await rm(consumer.path, { recursive: true, force: true })
    } catch {}
  }

  // Create parent directories
  await mkdir(dirname(consumer.path), { recursive: true })

  // Create symlink
  await symlink(consumer.source, consumer.path, 'dir')
  console.log(`  ✓ ${consumer.label}`)
  console.log(`    ${consumer.path} -> ${consumer.source}`)
  return true
}

// Build packages
console.log('[install] Building packages...\n')

for (const pkg of ['core', 'opencode', 'pi']) {
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: join(REPO, 'packages', pkg),
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`[install] Build failed for ${pkg}`)
    process.exit(1)
  }
}

console.log('\n[install] Creating symlinks...\n')

for (const consumer of consumers) {
  try {
    await createSymlink(consumer)
  } catch (err) {
    console.error(`  ✗ ${consumer.label}: ${err}`)
  }
}

console.log('\n[install] ✓ Installation complete')
console.log('\nRestart OpenCode/Prime to pick up changes')
