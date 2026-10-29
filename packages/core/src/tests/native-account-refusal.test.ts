import { expect, test } from 'bun:test'
import {
  NativeAccountRefusal,
  nativeAccountRefusal,
  nativeLocalAccountRefusal,
} from '../native-account-refusal.ts'
import { NativeCustodyError } from '../native-custody.ts'

test.each([
  'quota-ineligible',
  'account-disabled',
  'custody-mode',
  'row-ineligible',
  'unsupported-access',
  'invalid-grant',
  'binding-changed',
  'validation-contradicted',
])('local refusal %s is terminal with a closed reason', (reason) => {
  expect(
    nativeLocalAccountRefusal({ status: 'refused', reason, persisted: false }),
  ).toBeInstanceOf(NativeAccountRefusal)
})

test.each([
  'refresh-backoff',
  'validation-backoff',
  'cancelled',
  'initializing',
  'unknown-private-text',
])('local refusal %s retains retries', (reason) => {
  expect(
    nativeLocalAccountRefusal({ status: 'refused', reason, persisted: false }),
  ).toBeUndefined()
})

test.each([
  'unavailable',
  'closed',
  'roster-busy',
  'insufficient-validity',
] as const)('custody %s retains retries', (code) => {
  expect(nativeAccountRefusal(new NativeCustodyError(code))).toBeUndefined()
})

test.each([
  'not-active',
  'route-declined',
  'route-unavailable',
  'not-enrolled',
  'invalid-token',
  'identity-changed',
] as const)('custody %s is a terminal refusal', (code) => {
  expect(nativeAccountRefusal(new NativeCustodyError(code))).toBeInstanceOf(
    NativeAccountRefusal,
  )
})

test('transport and transient refresh failures are not account refusals', () => {
  expect(
    nativeAccountRefusal(new Error('Native custody refused: not-active')),
  ).toBeUndefined()
  expect(
    nativeLocalAccountRefusal({
      status: 'failed',
      failure: { kind: 'provider', classification: 'transient', status: 503 },
      persisted: false,
      reconciliationFailed: false,
    }),
  ).toBeUndefined()
})

test.each([undefined, 408, 429, 503])(
  'a failed refresh with status %s is retryable even if classified permanent',
  (status) => {
    expect(
      nativeLocalAccountRefusal({
        status: 'failed',
        failure: { kind: 'provider', classification: 'permanent', status },
        persisted: false,
        reconciliationFailed: false,
      }),
    ).toBeUndefined()
  },
)

test('an invalid grant requires signing in again', () => {
  expect(
    nativeLocalAccountRefusal({
      status: 'failed',
      failure: {
        kind: 'provider',
        classification: 'invalid-grant',
        status: 400,
      },
      persisted: false,
      reconciliationFailed: false,
    })?.reason,
  ).toBe('account-unavailable')
})
