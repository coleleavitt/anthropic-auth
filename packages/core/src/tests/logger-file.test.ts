import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { secureAppendLogFile } from '../logger.ts'

const directories: string[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'anthropic-auth-logger-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('secureAppendLogFile', () => {
  test('creates a user-only regular file and appends', () => {
    const logFile = join(temporaryDirectory(), 'plugin.log')

    expect(secureAppendLogFile(logFile, 'first\n')).toBe(true)
    expect(secureAppendLogFile(logFile, 'second\n')).toBe(true)

    expect(readFileSync(logFile, 'utf8')).toBe('first\nsecond\n')
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
  })

  test('restores user-only permissions on a world-readable log file', () => {
    const logFile = join(temporaryDirectory(), 'loose.log')
    writeFileSync(logFile, 'existing\n')
    chmodSync(logFile, 0o644)

    expect(secureAppendLogFile(logFile, 'next\n')).toBe(true)
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
  })

  test('refuses to follow a symlinked log path', () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'target.txt')
    const logFile = join(directory, 'link.log')
    writeFileSync(target, 'untouched\n')
    symlinkSync(target, logFile)

    expect(secureAppendLogFile(logFile, 'attacker\n')).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('untouched\n')
  })

  test('returns false instead of throwing on an unwritable path', () => {
    const directory = temporaryDirectory()
    expect(secureAppendLogFile(join(directory, 'missing', 'a.log'), 'x')).toBe(
      false,
    )
  })
})
