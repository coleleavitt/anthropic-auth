import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  ACCOUNT_FILE_NAME,
  getAccountStoragePath,
} from '@cortexkit/anthropic-auth-core'

export function getPiConfigDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
}

/**
 * The `anthropic-auth.json` settings file pi shares with opencode and
 * prime-agent (one file for every tool; credentials are the separate shared
 * `~/.anthropic-accounts` store):
 *
 * 1. an explicit `PI_ANTHROPIC_AUTH_FILE` or `OPENCODE_ANTHROPIC_AUTH_FILE`;
 * 2. pi's own copy (`$PI_AGENT_DIR` or `~/.pi/agent`), only if it already
 *    exists, so a user who kept settings there keeps them;
 * 3. otherwise opencode's path (`$OPENCODE_CONFIG_DIR`, else
 *    `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`), which a settings
 *    command's first write creates.
 *
 * prime-agent's `pa-anthropic-auth` resolves the same order.
 */
export function getPiAccountStoragePath(): string {
  const explicit =
    process.env.PI_ANTHROPIC_AUTH_FILE?.trim() ||
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim()
  if (explicit) return explicit
  const piCopy = join(getPiConfigDir(), ACCOUNT_FILE_NAME)
  if (existsSync(piCopy)) return piCopy
  return getAccountStoragePath()
}
