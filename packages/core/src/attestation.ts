export const DEVICE_ATTESTATION_STATUS_PREFIX =
  'DEVICE_ATTESTATION_STATUS_' as const
export const ATTESTATION_STATUS_PREFIX = DEVICE_ATTESTATION_STATUS_PREFIX

export const DEVICE_ATTESTATION_STATUSES = [
  'UNSPECIFIED',
  'ABSENT',
  'VERIFIED',
  'VERIFIED_BY_GATE',
  'INVALID',
  'UNCHECKED',
  'VERIFIED_KEYLESS_DEVICE',
  'SERVICE_VOUCHED',
] as const

export type DeviceAttestationStatus =
  (typeof DEVICE_ATTESTATION_STATUSES)[number]

/** The numeric bridge wire values defined by Claude Code 2.1.233. */
export const NUMERIC_DEVICE_ATTESTATION_STATUSES = [
  'UNSPECIFIED',
  'ABSENT',
  'VERIFIED',
  'VERIFIED_BY_GATE',
  'INVALID',
  'UNCHECKED',
] as const satisfies readonly DeviceAttestationStatus[]

export const ATTESTATION_THRESHOLD_ORDER = [
  'VERIFIED',
  'VERIFIED_KEYLESS_DEVICE',
  'VERIFIED_BY_GATE',
] as const

export type AttestationAcceptLevel =
  (typeof ATTESTATION_THRESHOLD_ORDER)[number]

export const ATTESTATION_EXCEPTION_STATUSES = [
  'UNSPECIFIED',
  'ABSENT',
  'INVALID',
  'UNCHECKED',
] as const

export type AttestationExceptionStatus =
  (typeof ATTESTATION_EXCEPTION_STATUSES)[number]

export type AttestationPolicy = {
  enforce: boolean
  acceptLevel: AttestationAcceptLevel
  acceptStatuses: ReadonlySet<AttestationExceptionStatus>
  malformed: boolean
}

export type EnforcedAttestationConfig = {
  accept_level?: AttestationAcceptLevel
  accept_statuses?: AttestationExceptionStatus[]
}

/** Parses numeric, prefixed, and bare statuses exactly like Claude Code. */
export function normalizeDeviceAttestationStatus(
  value: unknown,
): DeviceAttestationStatus {
  if (value === undefined || value === null) return 'UNSPECIFIED'
  if (typeof value === 'number') {
    return NUMERIC_DEVICE_ATTESTATION_STATUSES[value] ?? 'UNSPECIFIED'
  }
  if (typeof value !== 'string') return 'UNSPECIFIED'

  const bare = value.startsWith(DEVICE_ATTESTATION_STATUS_PREFIX)
    ? value.slice(DEVICE_ATTESTATION_STATUS_PREFIX.length)
    : value
  return isDeviceAttestationStatus(bare) ? bare : 'UNSPECIFIED'
}

export const parseDeviceAttestationStatus = normalizeDeviceAttestationStatus

/** SERVICE_VOUCHED bypasses thresholds; the remaining trusted levels are ordered. */
export function attestationStatusMeetsThreshold(
  status: DeviceAttestationStatus,
  acceptLevel: AttestationAcceptLevel,
): boolean {
  if (status === 'SERVICE_VOUCHED') return true
  const statusIndex = ATTESTATION_THRESHOLD_ORDER.indexOf(
    status as AttestationAcceptLevel,
  )
  return (
    statusIndex !== -1 &&
    statusIndex <= ATTESTATION_THRESHOLD_ORDER.indexOf(acceptLevel)
  )
}

/** Returns a fresh permissive policy, which is the bridge default. */
export function permissiveAttestationPolicy(): AttestationPolicy {
  return {
    enforce: false,
    acceptLevel: 'VERIFIED',
    acceptStatuses: new Set<AttestationExceptionStatus>(),
    malformed: false,
  }
}

/**
 * Parses an enabled enforcement configuration. Any malformed field fails
 * closed to VERIFIED with no status exceptions.
 */
export function parseEnforcedAttestationConfig(
  config: unknown,
): AttestationPolicy {
  if (!isRecord(config)) return failClosedAttestationPolicy()

  const acceptLevelValue = config.accept_level
  const acceptStatusesValue = config.accept_statuses
  const acceptLevel =
    acceptLevelValue === undefined ? 'VERIFIED' : acceptLevelValue
  const acceptStatuses =
    acceptStatusesValue === undefined ? [] : acceptStatusesValue

  if (
    !isAttestationAcceptLevel(acceptLevel) ||
    !Array.isArray(acceptStatuses) ||
    !acceptStatuses.every(isAttestationExceptionStatus)
  ) {
    return failClosedAttestationPolicy()
  }

  return {
    enforce: true,
    acceptLevel,
    acceptStatuses: new Set(acceptStatuses),
    malformed: false,
  }
}

/** Undefined means enforcement is disabled; a supplied config enables it. */
export function resolveAttestationPolicy(config?: unknown): AttestationPolicy {
  return config === undefined
    ? permissiveAttestationPolicy()
    : parseEnforcedAttestationConfig(config)
}

export function shouldAcceptAttestationStatus(
  value: unknown,
  policy: AttestationPolicy = permissiveAttestationPolicy(),
): boolean {
  const status = normalizeDeviceAttestationStatus(value)
  if (attestationStatusMeetsThreshold(status, policy.acceptLevel)) return true
  if (!policy.enforce) return true
  return policy.acceptStatuses.has(status as AttestationExceptionStatus)
}

export type AttestationDecision = {
  status: DeviceAttestationStatus
  accepted: boolean
}

export function evaluateAttestationStatus(
  value: unknown,
  policy: AttestationPolicy = permissiveAttestationPolicy(),
): AttestationDecision {
  const status = normalizeDeviceAttestationStatus(value)
  return {
    status,
    accepted: shouldAcceptAttestationStatus(status, policy),
  }
}

function failClosedAttestationPolicy(): AttestationPolicy {
  return {
    enforce: true,
    acceptLevel: 'VERIFIED',
    acceptStatuses: new Set<AttestationExceptionStatus>(),
    malformed: true,
  }
}

function isDeviceAttestationStatus(
  value: string,
): value is DeviceAttestationStatus {
  return (DEVICE_ATTESTATION_STATUSES as readonly string[]).includes(value)
}

function isAttestationAcceptLevel(
  value: unknown,
): value is AttestationAcceptLevel {
  return (
    typeof value === 'string' &&
    (ATTESTATION_THRESHOLD_ORDER as readonly string[]).includes(value)
  )
}

function isAttestationExceptionStatus(
  value: unknown,
): value is AttestationExceptionStatus {
  return (
    typeof value === 'string' &&
    (ATTESTATION_EXCEPTION_STATUSES as readonly string[]).includes(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
