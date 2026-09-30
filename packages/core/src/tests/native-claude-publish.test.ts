import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  publishNativeClaudeOAuth,
  readNativeClaudeOAuth,
} from '../native-claude-credentials.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})

/** The shape Claude Code actually writes, including fields only login sets. */
const NATIVE = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-old',
    refreshToken: 'sk-ant-ort01-old',
    expiresAt: 1_787_687_839_410,
    refreshTokenExpiresAt: 1_789_790_571_410,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
}

async function nativeDir(contents?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'native-claude-'))
  dirs.push(dir)
  if (contents !== undefined) {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify(contents), {
      mode: 0o600,
    })
  }
  return dir
}

const ROTATED = {
  accessToken: 'sk-ant-oat01-new',
  refreshToken: 'sk-ant-ort01-new',
  expiresAt: 1_787_700_000_000,
  refreshTokenExpiresAt: 1_789_800_000_000,
  scopes: ['user:inference', 'user:profile'],
}

describe('publishNativeClaudeOAuth', () => {
  test('publishes a rotation so Claude Code stops holding a dead token', async () => {
    // Anthropic revokes the family when a superseded refresh token is
    // presented. Without this write the native app keeps the old one and the
    // next refresh from either side kills the account for both.
    const dir = await nativeDir(NATIVE)

    expect(
      await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir }),
    ).toBe('written')

    const written = JSON.parse(
      await readFile(join(dir, '.credentials.json'), 'utf8'),
    )
    expect(written.claudeAiOauth.accessToken).toBe('sk-ant-oat01-new')
    expect(written.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-new')
    expect(written.claudeAiOauth.expiresAt).toBe(1_787_700_000_000)
  })

  test('preserves fields a refresh never returns', async () => {
    // subscriptionType and rateLimitTier are written by login, not refresh;
    // dropping them would degrade the native app's own behaviour.
    const dir = await nativeDir(NATIVE)

    await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir })

    const written = JSON.parse(
      await readFile(join(dir, '.credentials.json'), 'utf8'),
    )
    expect(written.claudeAiOauth.subscriptionType).toBe('max')
    expect(written.claudeAiOauth.rateLimitTier).toBe('default_claude_max_20x')
  })

  test('preserves unknown top-level keys — the file is Claude Code’s', async () => {
    const dir = await nativeDir({ ...NATIVE, somethingElse: { keep: true } })

    await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir })

    const written = JSON.parse(
      await readFile(join(dir, '.credentials.json'), 'utf8'),
    )
    expect(written.somethingElse).toEqual({ keep: true })
  })

  test('keeps the file owner-only', async () => {
    const dir = await nativeDir(NATIVE)

    await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir })

    const mode = (await stat(join(dir, '.credentials.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('reports absent when there is no native install', async () => {
    const dir = await nativeDir()
    expect(
      await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir }),
    ).toBe('absent')
  })

  test('refuses to clobber a file it cannot parse', async () => {
    // Possibly mid-write. Overwriting would log the user out of Claude Code.
    const dir = await nativeDir()
    await writeFile(join(dir, '.credentials.json'), '{ truncated', {
      mode: 0o600,
    })

    expect(
      await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir }),
    ).toBe('absent')
    expect(await readFile(join(dir, '.credentials.json'), 'utf8')).toBe(
      '{ truncated',
    )
  })

  test('is a no-op when the native copy already holds this token', async () => {
    // Avoids a pointless mtime bump, which would make Claude Code drop and
    // rebuild its credential cache for nothing.
    const dir = await nativeDir({
      claudeAiOauth: {
        ...NATIVE.claudeAiOauth,
        refreshToken: 'sk-ant-ort01-new',
      },
    })

    expect(
      await publishNativeClaudeOAuth(ROTATED, { configDirectory: dir }),
    ).toBe('unchanged')
  })
})

describe('readNativeClaudeOAuth', () => {
  test('reads the credential Claude Code currently holds', async () => {
    const dir = await nativeDir(NATIVE)
    const oauth = await readNativeClaudeOAuth({ configDirectory: dir })
    expect(oauth?.refreshToken).toBe('sk-ant-ort01-old')
  })

  test('returns null rather than throwing when absent or unreadable', async () => {
    expect(
      await readNativeClaudeOAuth({ configDirectory: await nativeDir() }),
    ).toBeNull()
    const bad = await nativeDir()
    await writeFile(join(bad, '.credentials.json'), 'not json')
    expect(await readNativeClaudeOAuth({ configDirectory: bad })).toBeNull()
  })
})
