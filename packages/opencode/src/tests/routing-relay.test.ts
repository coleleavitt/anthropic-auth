import { afterEach, describe, expect, test } from 'bun:test'
import { createRoutingRelay, ROUTING_HOLD_LIMIT_MS } from '../routing-relay'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
afterEach(() => {
  delete globals[key]
})

describe('shared routing relay', () => {
  test('discovers a bridge installed after module and client load', async () => {
    const relay = createRoutingRelay()
    expect(await relay.accountFor('session', 'model')).toBeNull()
    globals[key] = (session: string) => ({
      accountFor: async (input: unknown) => {
        expect(session).toBe('session')
        expect(input).toEqual({ provider: 'anthropic', modelId: 'model' })
        return { account_id: 'account', credential_id: 'credential' }
      },
    })
    expect(await relay.accountFor('session', 'model')).toEqual({
      account_id: 'account',
      credential_id: 'credential',
    })
  })

  test.each(['null', 'throw', 'reject', 'malformed'])(
    '%s advice fails open',
    async (mode) => {
      globals[key] = () => ({
        accountFor: () => {
          if (mode === 'throw') throw new Error('bridge failed')
          if (mode === 'reject')
            return Promise.reject(new Error('bridge failed'))
          return mode === 'null' ? null : { account_id: 5 }
        },
      })
      expect(
        await createRoutingRelay().accountFor('session', 'model'),
      ).toBeNull()
    },
  )

  test('a reply resolved after two seconds is ignored', async () => {
    let resolve!: (value: unknown) => void
    globals[key] = () => ({
      accountFor: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    const start = performance.now()
    const result = await createRoutingRelay().accountFor('session', 'model')
    expect(result).toBeNull()
    expect(performance.now() - start).toBeGreaterThanOrEqual(1900)
    resolve({ account_id: 'late', credential_id: 'late' })
  })

  test('caps a hold at fifteen minutes plus twenty seconds', async () => {
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: 'account',
        credential_id: 'credential',
        hold: { retry_after_ms: 9_000_000 },
      }),
    })
    expect(
      (await createRoutingRelay().accountFor('session', 'model'))?.hold
        ?.retry_after_ms,
    ).toBe(ROUTING_HOLD_LIMIT_MS)
  })

  test('reports only all lowercased rate-limit headers and attributed exhausted windows', async () => {
    const reports: unknown[] = []
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    const relay = createRoutingRelay()
    const subject = { accountIdentity: 'account', credentialId: 'credential' }
    relay.report(
      'session',
      subject,
      new Headers({
        'Anthropic-RateLimit-Unified-5h-Utilization': '1',
        'Anthropic-RateLimit-Future-Field': 'unfiltered',
        authorization: 'never sent',
        'request-id': 'never sent',
      }),
      200,
      {
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: 1,
          resetsAt: 'known',
        },
        scoped: [
          {
            id: 'FaBlE',
            title: 'Fable',
            modelName: 'Fable',
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: 1,
          },
        ],
      },
    )
    await Promise.resolve()
    expect(reports).toEqual([
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'served',
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-future-field': 'unfiltered',
        },
      },
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'exhausted',
        window: '5h',
        resets_at: 'known',
      },
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'exhausted',
        window: 'fable',
      },
    ])
    relay.report('session', subject, new Headers(), 429)
    relay.report('session', subject, new Headers(), 401)
    await Promise.resolve()
    expect(reports.slice(3)).toEqual([
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'exhausted',
        window: '7d',
      },
    ])
  })

  test.each(['throw', 'reject', 'pending'])(
    'a %s report is detached and harmless',
    async (mode) => {
      globals[key] = () => ({
        report: () => {
          if (mode === 'throw') throw new Error('report failed')
          if (mode === 'reject')
            return Promise.reject(new Error('report failed'))
          return new Promise(() => {})
        },
      })
      expect(
        createRoutingRelay().report(
          'session',
          { accountIdentity: 'account' },
          new Headers(),
          200,
        ),
      ).toBeUndefined()
      await Promise.resolve()
      await Promise.resolve()
    },
  )

  test.each([
    ['five_hour', '5h'],
    ['seven_day', '7d'],
    ['FaBlE', 'fable'],
  ])(
    'attributes a 429 binding window %s as %s',
    async (bindingWindow, window) => {
      const reports: unknown[] = []
      globals[key] = () => ({
        report: (report: unknown) => reports.push(report),
      })
      createRoutingRelay().report(
        'session',
        { accountIdentity: 'account' },
        new Headers(),
        429,
        { bindingWindow },
      )
      await Promise.resolve()
      expect(reports).toEqual([
        { account_id: 'account', outcome: 'exhausted', window },
      ])
    },
  )
})
