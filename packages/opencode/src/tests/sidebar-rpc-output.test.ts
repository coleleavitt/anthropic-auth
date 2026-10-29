import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { normalizeSidebarState } from '../sidebar-state'
import { NATIVE_MENU_RPC } from '../v2/rpc'

const validate = (value: unknown) =>
  NATIVE_MENU_RPC.methods.sidebar.output['~standard'].validate(value)

describe('sidebar RPC output', () => {
  test('keeps every account quota when the main five-hour window has no reset', async () => {
    const mainQuota = {
      five_hour: { usedPercent: 0, remainingPercent: 100 },
      seven_day: {
        usedPercent: 80,
        remainingPercent: 20,
        resetsAt: '2026-08-24T12:00:00Z',
      },
    }
    const fallbackQuota = {
      five_hour: {
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: '2026-08-20T16:00:00Z',
      },
    }
    const normalized = normalizeSidebarState({
      main: { quota: mainQuota, enabled: true },
      fallbacks: [
        {
          id: 'work',
          label: 'Work',
          quota: fallbackQuota,
          enabled: true,
          needsReauth: false,
        },
        {
          id: 'spare',
          quota: { seven_day: { usedPercent: 10, remainingPercent: 90 } },
          enabled: true,
          needsReauth: false,
        },
      ],
      activeId: 'work',
      route: 'balanced',
      lastUpdated: 123,
    })
    const result = await validate(normalized)
    if (result.issues) throw new Error('Sidebar output did not validate')

    expect(result.value.main.quota).toStrictEqual(mainQuota)
    expect(
      result.value.fallbacks.map((account) => account.quota),
    ).toStrictEqual([
      fallbackQuota,
      { seven_day: { usedPercent: 10, remainingPercent: 90 } },
    ])
    expect(result.value.activeId).toBe('work')
    expect(result.value.route).toBe('balanced')
    expect(
      Object.hasOwn(normalized.main.quota?.five_hour ?? {}, 'resetsAt'),
    ).toBe(false)
    expect(Object.hasOwn(normalized, 'cacheKeep')).toBe(false)
    expect(normalized).toStrictEqual(JSON.parse(JSON.stringify(normalized)))
    const encode = Schema.encodeSync(Schema.toCodecJson(Schema.Unknown)) as (
      value: unknown,
    ) => unknown
    expect(encode(result.value)).toStrictEqual(result.value)
  })

  test('repairs one deep invalid field, preserves siblings, and warns once per process', () => {
    // Isolate the mock so every other test still uses the real normalizer.
    // It represents a future field that normalization accidentally lets through.
    const probe = `
import { mock } from 'bun:test';
import { __setLogTestSink, setLogLevel } from '@cortexkit/anthropic-auth-core';
import { Schema } from 'effect';
const warnings = [];
setLogLevel('warn');
__setLogTestSink((record) => warnings.push(record));
const quota = { five_hour: { usedPercent: 25, remainingPercent: 75 } };
const state = {
  main: { quota },
  fallbacks: [{ id: 'work', quota, enabled: true, needsReauth: false }],
  route: 'balanced', relay: null, fastMode: true, lastUpdated: 123,
};
mock.module(${JSON.stringify(fileURLToPath(new URL('../sidebar-state.ts', import.meta.url)))}, () => ({
  normalizeSidebarState: () => state,
}));
const { NATIVE_MENU_RPC } = await import(${JSON.stringify(new URL('../v2/rpc.ts', import.meta.url).href)});
const validate = NATIVE_MENU_RPC.methods.sidebar.output['~standard'].validate;
const encode = Schema.encodeSync(Schema.toCodecJson(Schema.Unknown));
const answers = [];
for (const invalid of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('private-value'), () => 'private-value']) {
  state.main = { quota: { five_hour: { ...quota.five_hour, checkedAt: invalid } } };
  const answer = await validate(state);
  if (answer.issues) throw new Error('Sidebar output did not validate');
  answers.push(encode(answer.value));
}
console.log(JSON.stringify({ answers, warnings }));
`
    const child = Bun.spawnSync([process.execPath, '-e', probe], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    })
    expect({
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    }).toEqual({
      exitCode: 0,
      stderr: '',
    })
    const { answers, warnings } = JSON.parse(child.stdout.toString())
    expect(answers).toHaveLength(7)
    for (const answer of answers) {
      expect(answer).toStrictEqual({
        main: {
          quota: { five_hour: { usedPercent: 25, remainingPercent: 75 } },
        },
        fallbacks: [
          {
            id: 'work',
            quota: { five_hour: { usedPercent: 25, remainingPercent: 75 } },
            enabled: true,
            needsReauth: false,
          },
        ],
        route: 'balanced',
        relay: null,
        fastMode: true,
        lastUpdated: 123,
      })
    }
    expect(warnings).toStrictEqual([
      {
        level: 'warn',
        channel: 'sidebar',
        message: 'Dropped non-JSON sidebar field',
        payload: { path: 'sidebar.main.quota.five_hour.checkedAt' },
      },
    ])
  })
})
