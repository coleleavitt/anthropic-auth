import { describe, expect, test } from 'bun:test'

import {
  ATTESTATION_EXCEPTION_STATUSES,
  ATTESTATION_STATUS_PREFIX,
  ATTESTATION_THRESHOLD_ORDER,
  type AttestationAcceptLevel,
  DEVICE_ATTESTATION_STATUSES,
  type DeviceAttestationStatus,
  normalizeDeviceAttestationStatus,
  parseEnforcedAttestationConfig,
  permissiveAttestationPolicy,
  resolveAttestationPolicy,
  shouldAcceptAttestationStatus,
} from '../attestation.ts'

describe('device attestation status normalization', () => {
  test('exposes the exact prefix and status vocabulary', () => {
    expect(ATTESTATION_STATUS_PREFIX).toBe('DEVICE_ATTESTATION_STATUS_')
    expect(DEVICE_ATTESTATION_STATUSES).toEqual([
      'UNSPECIFIED',
      'ABSENT',
      'VERIFIED',
      'VERIFIED_BY_GATE',
      'INVALID',
      'UNCHECKED',
      'VERIFIED_KEYLESS_DEVICE',
      'SERVICE_VOUCHED',
    ])
  })

  test('maps numeric bridge values 0 through 5 exactly', () => {
    const expected: DeviceAttestationStatus[] = [
      'UNSPECIFIED',
      'ABSENT',
      'VERIFIED',
      'VERIFIED_BY_GATE',
      'INVALID',
      'UNCHECKED',
    ]
    expected.forEach((status, numeric) => {
      expect(normalizeDeviceAttestationStatus(numeric)).toBe(status)
    })

    expect(normalizeDeviceAttestationStatus(6)).toBe('UNSPECIFIED')
    expect(normalizeDeviceAttestationStatus(-1)).toBe('UNSPECIFIED')
    expect(normalizeDeviceAttestationStatus(2.5)).toBe('UNSPECIFIED')
  })

  test('accepts bare and prefixed string statuses and normalizes malformed values', () => {
    for (const status of DEVICE_ATTESTATION_STATUSES) {
      expect(normalizeDeviceAttestationStatus(status)).toBe(status)
      expect(
        normalizeDeviceAttestationStatus(
          `${ATTESTATION_STATUS_PREFIX}${status}`,
        ),
      ).toBe(status)
    }

    expect(normalizeDeviceAttestationStatus('2')).toBe('UNSPECIFIED')
    expect(normalizeDeviceAttestationStatus('VERIFIED_UNKNOWN')).toBe(
      'UNSPECIFIED',
    )
    expect(normalizeDeviceAttestationStatus(null)).toBe('UNSPECIFIED')
    expect(normalizeDeviceAttestationStatus({})).toBe('UNSPECIFIED')
  })
})

describe('device attestation policy', () => {
  const acceptedAtThreshold: Record<
    AttestationAcceptLevel,
    DeviceAttestationStatus[]
  > = {
    VERIFIED: ['VERIFIED', 'SERVICE_VOUCHED'],
    VERIFIED_KEYLESS_DEVICE: [
      'VERIFIED',
      'VERIFIED_KEYLESS_DEVICE',
      'SERVICE_VOUCHED',
    ],
    VERIFIED_BY_GATE: [
      'VERIFIED',
      'VERIFIED_KEYLESS_DEVICE',
      'VERIFIED_BY_GATE',
      'SERVICE_VOUCHED',
    ],
  }

  test('uses the exact VERIFIED -> KEYLESS -> GATE threshold matrix', () => {
    expect(ATTESTATION_THRESHOLD_ORDER).toEqual([
      'VERIFIED',
      'VERIFIED_KEYLESS_DEVICE',
      'VERIFIED_BY_GATE',
    ])

    for (const acceptLevel of ATTESTATION_THRESHOLD_ORDER) {
      const policy = parseEnforcedAttestationConfig({
        accept_level: acceptLevel,
      })
      for (const status of DEVICE_ATTESTATION_STATUSES) {
        expect(shouldAcceptAttestationStatus(status, policy)).toBe(
          acceptedAtThreshold[acceptLevel].includes(status),
        )
      }
    }
  })

  test('always accepts SERVICE_VOUCHED', () => {
    for (const acceptLevel of ATTESTATION_THRESHOLD_ORDER) {
      expect(
        shouldAcceptAttestationStatus(
          'SERVICE_VOUCHED',
          parseEnforcedAttestationConfig({ accept_level: acceptLevel }),
        ),
      ).toBe(true)
    }
    expect(
      shouldAcceptAttestationStatus(
        'SERVICE_VOUCHED',
        parseEnforcedAttestationConfig({ accept_level: 'not-valid' }),
      ),
    ).toBe(true)
  })

  test('is permissive by default', () => {
    const policy = resolveAttestationPolicy()
    expect(policy).toMatchObject({
      enforce: false,
      acceptLevel: 'VERIFIED',
      malformed: false,
    })
    for (const status of DEVICE_ATTESTATION_STATUSES) {
      expect(shouldAcceptAttestationStatus(status, policy)).toBe(true)
    }
    expect(
      shouldAcceptAttestationStatus('unknown', permissiveAttestationPolicy()),
    ).toBe(true)
  })

  test('allows only the four configured exception statuses', () => {
    expect(ATTESTATION_EXCEPTION_STATUSES).toEqual([
      'UNSPECIFIED',
      'ABSENT',
      'INVALID',
      'UNCHECKED',
    ])
    const policy = parseEnforcedAttestationConfig({
      accept_statuses: [...ATTESTATION_EXCEPTION_STATUSES],
    })
    expect(policy.malformed).toBe(false)
    for (const status of ATTESTATION_EXCEPTION_STATUSES) {
      expect(shouldAcceptAttestationStatus(status, policy)).toBe(true)
    }
  })

  test('fails malformed enforced configs closed to VERIFIED with no exceptions', () => {
    const malformedConfigs: unknown[] = [
      null,
      [],
      { accept_level: 'VERIFIED_BY_SERVICE' },
      { accept_statuses: 'ABSENT' },
      { accept_statuses: ['SERVICE_VOUCHED'] },
      { accept_statuses: ['VERIFIED'] },
      { accept_statuses: ['VERIFIED_KEYLESS_DEVICE'] },
      { accept_statuses: ['VERIFIED_BY_GATE'] },
      { accept_statuses: ['UNSPECIFIED', 'UNKNOWN'] },
    ]

    for (const config of malformedConfigs) {
      const policy = parseEnforcedAttestationConfig(config)
      expect(policy.enforce).toBe(true)
      expect(policy.acceptLevel).toBe('VERIFIED')
      expect([...policy.acceptStatuses]).toEqual([])
      expect(policy.malformed).toBe(true)
      expect(shouldAcceptAttestationStatus('VERIFIED', policy)).toBe(true)
      expect(shouldAcceptAttestationStatus('ABSENT', policy)).toBe(false)
    }
  })

  test('treats an empty enforced config as VERIFIED with no exceptions', () => {
    const policy = resolveAttestationPolicy({})
    expect(policy.enforce).toBe(true)
    expect(policy.acceptLevel).toBe('VERIFIED')
    expect([...policy.acceptStatuses]).toEqual([])
    expect(policy.malformed).toBe(false)
  })
})
