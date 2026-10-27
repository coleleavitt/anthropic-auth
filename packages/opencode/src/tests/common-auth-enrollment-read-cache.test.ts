// Every enrollment write must be visible to the next enrollment read, in the
// writing process and in any other process. common-auth 0.27.1 caches
// readClaustrumEnrollmentStatus() per process on POSIX, keyed on the token and
// state files' identity (device, inode, size, mtime, ctime). The writers here
// are the real ones: the setup ceremony (enrollNativeVaultForHost over
// common-auth's ClaustrumEnrollmentManager), Core's terminal-state reset used
// by the OpenCode menus and Pi, and common-auth's disconnect. Reads go through
// readClaustrumEnrollmentStatus and enrollmentAuthority, which decide the
// runtime's vault or local mode. These tests pass on 0.25.0 too, which reads
// both files every time.

import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetClaustrumEnrollmentState } from '@cortexkit/anthropic-auth-core'
import {
  disconnectClaustrumEnrollment,
  enrollmentAuthority,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'

import { enrollNativeVaultForHost } from '../setup/native-enrollment.ts'

const NAME = 'anthropic-auth-opencode'
const roots: string[] = []

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function enrollmentPaths() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-enrollment-cache-')),
  )
  roots.push(root)
  return {
    tokenPath: join(root, 'enrollment.json'),
    statePath: join(root, 'enrollment-state.json'),
  }
}

type Paths = Awaited<ReturnType<typeof enrollmentPaths>>

/** Run the setup ceremony to completion with a stub enrollment client and a stubbed `ck` command. */
async function enroll(
  paths: Paths,
  outcome: { approve: true; generation: number } | { approve: false },
) {
  let approved = false
  return enrollNativeVaultForHost('opencode', {
    paths,
    env: {},
    processFence: async () => {},
    grantPermissions: false,
    runner: {
      run: async (_command, args) => {
        if (args.includes('approve')) approved = true
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    client: {
      enrollPropose: async () => ({ requestId: 'synthetic-request-id' }),
      enrollPoll: async () => {
        if (!approved) return { status: 'pending' }
        return outcome.approve
          ? {
              status: 'approved',
              name: NAME,
              // Same length every time, so the token file's size never changes.
              token: String(outcome.generation % 10).repeat(64),
              tokenGeneration: outcome.generation,
            }
          : { status: 'denied' }
      },
    },
  })
}

const claustrumModule = import.meta.resolve('@cortexkit/common-auth/claustrum')

/** Run one common-auth enrollment call in a separate Bun process. */
async function inChild(paths: Paths, body: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import * as claustrum from ${JSON.stringify(claustrumModule)};
    const paths = ${JSON.stringify(paths)};
    const name = ${JSON.stringify(NAME)};
    ${body}
  `,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const [exit, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`child exited ${exit}: ${error}`)
  return out.trim()
}

const childStatus = `
    const status = await claustrum.readClaustrumEnrollmentStatus(paths, name);
    const mode = await claustrum.enrollmentAuthority(paths, name);
    console.log(JSON.stringify({ state: status.state, tokenGeneration: status.tokenGeneration, mode }));
`

async function status(paths: Paths) {
  const read = await readClaustrumEnrollmentStatus(paths, NAME)
  return {
    state: read.state,
    tokenGeneration:
      'tokenGeneration' in read ? read.tokenGeneration : undefined,
    mode: await enrollmentAuthority(paths, NAME),
  }
}

test('setup enrollment and disconnect are seen by the next read in this process and in another', async () => {
  const paths = await enrollmentPaths()
  // Warm this process's view of both (absent) files.
  expect(await status(paths)).toEqual({
    state: 'idle',
    tokenGeneration: undefined,
    mode: 'local',
  })

  for (let generation = 1; generation <= 6; generation++) {
    await enroll(paths, { approve: true, generation })
    const approved = { state: 'approved' as const, tokenGeneration: generation }
    expect(await status(paths)).toEqual({ ...approved, mode: 'vault' })
    expect(JSON.parse(await inChild(paths, childStatus))).toEqual({
      ...approved,
      mode: 'vault',
    })
    // Disconnect alternates between this process and another one.
    if (generation % 2) {
      expect(await disconnectClaustrumEnrollment(paths, NAME)).toBe(
        'disconnected',
      )
    } else {
      expect(
        await inChild(
          paths,
          'console.log(await claustrum.disconnectClaustrumEnrollment(paths, name));',
        ),
      ).toBe('disconnected')
    }
    const idle = {
      state: 'idle',
      tokenGeneration: undefined,
      mode: 'local',
    } as const
    expect(await status(paths)).toEqual(idle)
    expect(JSON.parse(await inChild(paths, childStatus))).toEqual({
      state: 'idle',
      mode: 'local',
    })
  }
}, 60_000)

test('a refused ceremony and its reset are seen by the next read in this process and in another', async () => {
  const paths = await enrollmentPaths()
  expect((await status(paths)).state).toBe('idle')
  for (let round = 0; round < 4; round++) {
    await expect(enroll(paths, { approve: false })).rejects.toMatchObject({
      code: 'enrollment-refused',
    })
    expect((await status(paths)).state).toBe('denied')
    expect(JSON.parse(await inChild(paths, childStatus)).state).toBe('denied')
    // The reset the OpenCode menus and Pi run (Core's own writer).
    expect(await resetClaustrumEnrollmentState(paths, NAME)).toBe('reset')
    expect(await status(paths)).toEqual({
      state: 'idle',
      tokenGeneration: undefined,
      mode: 'local',
    })
    expect(JSON.parse(await inChild(paths, childStatus)).state).toBe('idle')
  }
}, 60_000)
