import {
  enrollmentAuthority,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'

import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import { logger } from './logger.ts'
import { NativeCustodyError } from './native-custody.ts'
import { closeNativeVaultAuthority } from './native-vault-invalidation.ts'

const stages = new Set([
  'safe-parent',
  'directory',
  'verify',
  'read',
  'open',
  'decode',
])
const reasons = new Set([
  'unsupported-filesystem',
  'wrong-owner',
  'extra-ace',
  'not-protected',
  'null-dacl',
  'empty-dacl',
  'reparse-point',
  'unsafe-ancestor',
  'wrong-kind',
  'io-error',
  'mode',
  'invalid-state',
  'invalid-token',
  'unsafe-file',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'ERR_PRIVATE_FILES_SECURITY',
])

/**
 * Codes and reasons that mean the Windows private-files native addon did not
 * load. common-auth 0.24.0 and later refuse with code
 * `ERR_PRIVATE_FILES_UNAVAILABLE` and reason `native-addon-unavailable`
 * instead of passing through the backend's `unsupported-filesystem`.
 */
const addonUnavailable = new Set([
  'ERR_PRIVATE_FILES_UNAVAILABLE',
  'native-addon-unavailable',
])

/** Logged reasons that mean the private-files backend, not the enrollment, failed. */
const privateFilesUnavailableReasons = new Set([
  'unsupported-filesystem',
  'native-addon-unavailable',
])

async function logRefusal(
  host: 'opencode' | 'pi',
  paths: ReturnType<typeof getHostClaustrumEnrollmentPaths>,
  readStatus: typeof readClaustrumEnrollmentStatus,
): Promise<string> {
  let stage = 'enrollment'
  let reason = 'unreadable'
  let unavailable = false
  try {
    // The shared authority intentionally closes errors. A failure-only probe
    // recovers diagnostic codes without changing the authority decision.
    await readStatus(paths, `anthropic-auth-${host}`)
  } catch (error) {
    let current: unknown = error
    for (
      let depth = 0;
      depth < 4 && current && typeof current === 'object';
      depth++
    ) {
      const detail = current as {
        stage?: string
        reason?: string
        code?: string
        kind?: string
        cause?: unknown
      }
      if (detail.stage && stages.has(detail.stage)) stage = detail.stage
      for (const value of [detail.kind, detail.code, detail.reason]) {
        if (value && reasons.has(value)) reason = value
        if (value && addonUnavailable.has(value)) unavailable = true
      }
      current = detail.cause
    }
  }
  // A missing addon explains every other refusal in the chain (an inner
  // cause may carry an unrelated code such as ENOENT), so it wins.
  if (unavailable) reason = 'native-addon-unavailable'
  logger.warn('enrollment', 'Native enrollment authority refused', {
    host,
    stage,
    reason,
  })
  return reason
}

/**
 * Shown instead of `Native custody refused: invalid-token` when the
 * enrollment files could not be read because the private-files backend did
 * not load. Older common-auth passes on the backend's
 * `unsupported-filesystem`, which is what every private-file check returns on
 * Windows when the @cortexkit/private-files native addon did not load; newer
 * common-auth refuses with `ERR_PRIVATE_FILES_UNAVAILABLE`. Either way the
 * enrollment itself may be fine.
 */
export const PRIVATE_FILES_UNAVAILABLE_MESSAGE =
  "Private file support didn't load on this machine (@cortexkit/private-files). Reinstall the plugin; if this persists, report it with your OS and Node version."

/**
 * The enrollment refusal for a private-files backend that did not load. It
 * keeps the `invalid-token` code, so every caller that branches on the code
 * treats it exactly as before; only the message names the cause and remedy.
 */
export class NativePrivateFilesUnavailableError extends NativeCustodyError {
  constructor() {
    super('invalid-token')
    this.message = PRIVATE_FILES_UNAVAILABLE_MESSAGE
  }
}

/** Enrollment files, not account settings, choose the host's credential source. */
export async function readNativeEnrollmentMode(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
  dependencies = { enrollmentAuthority, readClaustrumEnrollmentStatus },
): Promise<'local' | 'claustrum'> {
  const paths = getHostClaustrumEnrollmentPaths(host, env)
  const authority = await dependencies.enrollmentAuthority(
    paths,
    `anthropic-auth-${host}`,
  )
  if (authority !== 'vault')
    closeNativeVaultAuthority(
      getHostClaustrumEnrollmentPaths(host, env).tokenPath,
    )
  if (authority === 'unreadable') {
    const reason = await logRefusal(
      host,
      paths,
      dependencies.readClaustrumEnrollmentStatus,
    )
    if (privateFilesUnavailableReasons.has(reason))
      throw new NativePrivateFilesUnavailableError()
    throw new NativeCustodyError('invalid-token')
  }
  return authority === 'vault' ? 'claustrum' : 'local'
}
