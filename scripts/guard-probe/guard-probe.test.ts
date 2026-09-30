/**
 * Deliberately misbehaving test, run only by
 * `bun scripts/test-isolated.ts --self-test`. It reaches for the operator's
 * real `~/.anthropic-accounts`; the runner must flag the run as failed while
 * the real directory stays untouched.
 *
 * The write is attempted only when the runner reports the bubblewrap overlay,
 * where the real path is a bind mount of an empty per-run directory. Without
 * the overlay the probe limits itself to a stat, which cannot change anything.
 */
import { expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Set by the runner from the password database (Bun's os.userInfo() echoes
// the sandboxed $HOME).
const realHome = process.env.ANTHROPIC_AUTH_TEST_REAL_HOME ?? ''
if (!realHome) throw new Error('run this only via test-isolated.ts --self-test')
const realStoreDir = join(realHome, '.anthropic-accounts')

test('the runner gave this process a sandbox HOME', () => {
  expect(homedir()).not.toBe(realHome)
  expect(process.env.ANTHROPIC_AUTH_TEST_ISOLATED).toBeTruthy()
})

test('probe: stat a real protected path', () => {
  // The result does not matter; the attempt is what the audit must catch.
  existsSync(join(realStoreDir, 'accounts.json'))
})

test('probe: write under a real protected path (overlay only)', () => {
  if (process.env.ANTHROPIC_AUTH_TEST_GUARD_OVERLAY !== '1') return
  const target = join(realStoreDir, 'guard-probe-write.json')
  writeFileSync(target, '{"probe":true}\n', { flag: 'wx' })
  // Inside the overlay the file exists in the sandboxed copy only.
  expect(existsSync(target)).toBe(true)
})
