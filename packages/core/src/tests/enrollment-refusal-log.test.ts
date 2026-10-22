import { expect, test } from 'bun:test'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { NativeCustodyError } from '../native-custody.ts'
import {
  NativePrivateFilesUnavailableError,
  PRIVATE_FILES_UNAVAILABLE_MESSAGE,
  readNativeEnrollmentMode,
} from '../native-enrollment-authority.ts'

test('enrollment refusal logs allowlisted stage and reason without token bytes or paths', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  try {
    await expect(
      readNativeEnrollmentMode(
        'opencode',
        {},
        {
          enrollmentAuthority: async () => 'unreadable',
          readClaustrumEnrollmentStatus: async () => {
            throw Object.assign(new Error('C:/private/synthetic-token-bytes'), {
              path: 'C:/private/synthetic-token-bytes',
              stage: 'safe-parent',
              reason: 'unsupported-filesystem',
            })
          },
        },
      ),
      // An unsupported-filesystem refusal names the private-files backend
      // instead of the token; it is checked on its own in the test below.
    ).rejects.toThrow(PRIVATE_FILES_UNAVAILABLE_MESSAGE)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'warn',
      channel: 'enrollment',
      payload: {
        host: 'opencode',
        stage: 'safe-parent',
        reason: 'unsupported-filesystem',
      },
    })
    expect(JSON.stringify(records)).not.toContain('private')
    expect(JSON.stringify(records)).not.toContain('synthetic-token-bytes')
  } finally {
    __setLogTestSink(null)
  }
})

test('enrollment refusal does not log unrecognized error properties', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  try {
    await expect(
      readNativeEnrollmentMode(
        'pi',
        {},
        {
          enrollmentAuthority: async () => 'unreadable',
          readClaustrumEnrollmentStatus: async () => {
            throw {
              stage: 'C:/secret',
              code: 'token-bytes',
              reason: 'token-bytes',
            }
          },
        },
      ),
    ).rejects.toThrow('Native custody refused: invalid-token')
    expect(records[0]).toMatchObject({
      payload: { stage: 'enrollment', reason: 'unreadable' },
    })
    expect(JSON.stringify(records)).not.toContain('token-bytes')
  } finally {
    __setLogTestSink(null)
  }
})

/** The refusal readNativeEnrollmentMode gives when the diagnostic probe throws `failure`. */
async function refusalFor(failure: unknown): Promise<unknown> {
  __setLogTestSink(() => {})
  try {
    return await readNativeEnrollmentMode(
      'opencode',
      {},
      {
        enrollmentAuthority: async () => 'unreadable',
        readClaustrumEnrollmentStatus: async () => {
          throw failure
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
  } finally {
    __setLogTestSink(null)
  }
}

test('a private-files backend that did not load gets its own refusal message', async () => {
  // Shaped like common-auth's PrivateFileError when @cortexkit/private-files
  // answers unsupported-filesystem, with the backend's own result as cause.
  const error = await refusalFor(
    Object.assign(new Error('Private file refused at verify'), {
      name: 'PrivateFileError',
      stage: 'verify',
      code: 'ERR_PRIVATE_FILES_SECURITY',
      reason: 'unsupported-filesystem',
      cause: {
        reason: 'unsupported-filesystem',
        code: 'ERR_PRIVATE_FILES_SECURITY',
      },
    }),
  )
  expect(error).toBeInstanceOf(NativePrivateFilesUnavailableError)
  expect((error as Error).message).toBe(
    "Private file support didn't load on this machine (@cortexkit/private-files). Reinstall the plugin; if this persists, report it with your OS and Node version.",
  )
  // Callers branch on the custody error class and code; both are unchanged.
  expect(error).toBeInstanceOf(NativeCustodyError)
  expect((error as NativeCustodyError).code).toBe('invalid-token')
  expect((error as Error).name).toBe('NativeCustodyError')
})

test('every other unreadable enrollment keeps the invalid-token refusal', async () => {
  for (const failure of [
    { stage: 'read', reason: 'wrong-owner' },
    { stage: 'verify', reason: 'not-protected' },
    { stage: 'decode', kind: 'invalid-token' },
    { code: 'ENOENT' },
    { code: 'ERR_PRIVATE_FILES_SECURITY' },
    new Error('unrecognised failure'),
  ]) {
    const error = await refusalFor(failure)
    expect(error).toBeInstanceOf(NativeCustodyError)
    expect(error).not.toBeInstanceOf(NativePrivateFilesUnavailableError)
    expect((error as Error).message).toBe(
      'Native custody refused: invalid-token',
    )
  }
})
