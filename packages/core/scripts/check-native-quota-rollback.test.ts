import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { QuotaCodec } from '@cortexkit/common-auth/quota'
import type { ProviderAccountUuid } from '../dist/index.js'
import type { OAuthQuotaSnapshot } from '../src/accounts.ts'
import {
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../src/native-quota-codec.ts'
import { initializeNativeTestAuthority } from '../src/tests/native-authority-fixture.ts'

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0)
    throw new Error(`${command.join(' ')} exited ${code}: ${stderr}`)
  return stdout
}

type Core = typeof import('../dist/index.js')
type PrivateCodec = {
  rollbackCodec: QuotaCodec
  rollbackFormat(quota: unknown, options: { now: number }): string
  rollbackDisplay(
    snapshot: OAuthQuotaSnapshot | undefined,
    now: number,
  ): unknown
}

/** Network integration gate: install the actual older release, not a copy of its validator. */
test('published Core 2.2.7 accepts current quota or only needs a quota repoll, without disabling serving or refresh', async () => {
  const scratch = new URL('../../../target/scratch/', import.meta.url).pathname
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'quota-rollback-227-'))
  const close: Array<() => void | Promise<void>> = []
  try {
    const branch: Core = await import('../dist/index.js')
    const [pack] = JSON.parse(
      await run(
        [
          'npm',
          'pack',
          '@cortexkit/anthropic-auth-core@2.2.7',
          '--json',
          '--pack-destination',
          root,
        ],
        root,
      ),
    ) as Array<{
      filename: string
      version: string
      shasum: string
      integrity: string
    }>
    if (pack?.version !== '2.2.7') throw new Error('Wrong rollback release')
    console.log(
      'ROLLBACK_PACK',
      JSON.stringify({
        filename: pack.filename,
        version: pack.version,
        shasum: pack.shasum,
        integrity: pack.integrity,
      }),
    )
    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@cortexkit/anthropic-auth-core': `file:${join(root, pack.filename)}`,
        },
      }),
    )
    await run([process.execPath, 'install'], consumer)
    const bundle = join(
      consumer,
      'node_modules/@cortexkit/anthropic-auth-core/dist/index.js',
    )
    const source = await readFile(bundle, 'utf8')
    for (const name of [
      'nativeMetadata',
      'fromNativeQuotaMap',
      'createNativePoolStore',
      'projectNativeAccountViews',
      'createNativeAccountRuntime',
      'quotaDisplayProjection',
      'formatQuota',
    ]) {
      const position = source.indexOf(`function ${name}(`)
      if (position < 0) throw new Error(`Published function missing: ${name}`)
      console.log(
        'ROLLBACK_SOURCE',
        `${bundle}:${source.slice(0, position).split('\n').length} ${name}`,
      )
    }
    // The native codec is private. Add test-only exports after the unchanged
    // packed bundle; public runtime operations below use the original bundle.
    const codecBundle = join(
      consumer,
      'node_modules/@cortexkit/anthropic-auth-core/dist/rollback-codec.js',
    )
    await writeFile(
      codecBundle,
      `${source}\nexport {nativeQuotaCodec as rollbackCodec, quotaDisplayProjection as rollbackDisplay, formatQuota as rollbackFormat};\n`,
    )
    const published: Core = await import(pathToFileURL(bundle).href)
    const privateCodec: PrivateCodec = await import(
      pathToFileURL(codecBundle).href
    )
    const now = Date.now()
    const identities = {
      bad: '11111111-1111-4111-8111-111111111111' as ProviderAccountUuid,
      good: '22222222-2222-4222-8222-222222222222' as ProviderAccountUuid,
    }
    const directory = join(root, 'pool')
    await mkdir(directory)
    const paths = await branch.resolveNativePoolPaths(
      join(directory, 'auth.json'),
    )
    await initializeNativeTestAuthority(paths)
    const writer = branch.createNativePoolStore({
      paths,
      quota: nativeQuotaCodec,
    })
    close.push(() => writer.close())
    await writer.initialize()
    for (const id of ['bad', 'good'] as const)
      await writer.add({
        id,
        identity: identities[id],
        credential: {
          type: 'oauth',
          access: `sk-ant-oat01-rollback-${id}`,
          refresh: `synthetic-${id}`,
          expires: now + 3_600_000,
        },
      })
    await writer.updateSettings((settings) => {
      settings.mainAccountId = 'bad'
    })
    const observation = toNativeQuotaMap({
      accountIdentity: identities.bad,
      source: 'poll',
      checkedAt: now,
      five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: now },
      scoped: [
        {
          id: 'fable',
          title: 'Fable',
          modelName: 'Fable',
          usedPercent: 30,
          remainingPercent: 70,
          checkedAt: now,
        },
      ],
    })
    await writer.recordQuota(
      'bad',
      { credentialEpoch: 1, identity: identities.bad },
      observation,
    )
    await writer.close()
    const fresh = branch.createNativePoolStore({
      paths,
      quota: nativeQuotaCodec,
    })
    close.push(() => fresh.close())
    const disk = await fresh.read()
    if (disk.status !== 'ready') throw new Error('Branch pool was not ready')
    const written = disk.rows.find((row) => row.id === 'bad')?.quota
    const accepted = privateCodec.rollbackCodec.validate(written)
    const oldStore = published.createNativePoolStore({
      paths,
      quota: privateCodec.rollbackCodec,
    })
    let refreshes = 0
    let lookups = 0
    let polls = 0
    const options = {
      paths,
      host: 'opencode' as const,
      vault: {
        env: {
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
            directory,
            'no-enrollment',
          ),
        },
      },
      local: {
        now: () => now,
        resolveIdentity: async (access: string) => {
          lookups++
          return {
            deviceId: 'synthetic-device',
            sessionId: 'synthetic-session',
            accountUuid: access.includes('good')
              ? identities.good
              : identities.bad,
          }
        },
        refreshToken: async () => {
          refreshes++
          return {
            access: 'sk-ant-oat01-rollback-successor',
            refresh: 'synthetic-successor',
            expires: now + 7_200_000,
            expiresIn: 7200,
          }
        },
      },
    }
    const runtime = published.createNativeAccountRuntime(options)
    close.push(() => runtime.close())
    const pool = await oldStore.read()
    const snapshot = await runtime.read()
    const main = snapshot.accounts.find((account) => account.id === 'main')
    const display = privateCodec.rollbackDisplay(main?.quota, now)
    const displayText = privateCodec.rollbackFormat(display, { now })
    const admission = await runtime.authorizeLocal('main')
    const goodAdmission = await runtime.authorizeLocal('good')
    const refresh = await runtime.authorizeLocal('main', { intent: 'refresh' })
    let poll: { ok: boolean; message?: string; code?: unknown }
    try {
      const transport = Object.assign(
        async () => {
          polls++
          return Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          })
        },
        { preconnect() {} },
      )
      await runtime.fetchQuota('main', transport)
      await runtime.drainQuotaPublications()
      poll = { ok: true }
    } catch (error) {
      poll = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown }).code,
      }
    }
    const afterPoll = await runtime.read()
    const afterPollMain = afterPoll.accounts.find(
      (account) => account.id === 'main',
    )
    const observed = {
      codecAccepted: accepted,
      poolStatus: pool.status,
      rows:
        pool.status === 'ready'
          ? pool.rows.map((row) => ({
              id: row.id,
              invalid: row.invalid,
              candidate: row.candidate,
              hasQuota: row.quota !== undefined,
              hasEpoch: row.credentialEpoch !== undefined,
            }))
          : [],
      accounts: snapshot.accounts.map((account) => ({
        id: account.id,
        enabled: account.enabled,
        hasBinding: !!account.binding,
        hasQuota: !!account.quota,
      })),
      display: display ?? null,
      displayText,
      admission: {
        status: admission.status,
        ...('reason' in admission ? { reason: admission.reason } : {}),
      },
      goodAdmission: {
        status: goodAdmission.status,
        ...('reason' in goodAdmission ? { reason: goodAdmission.reason } : {}),
      },
      refresh: {
        status: refresh.status,
        ...('reason' in refresh ? { reason: refresh.reason } : {}),
      },
      poll,
      callbacks: { refreshes, lookups, polls },
      afterPoll: {
        enabled: afterPollMain?.enabled,
        hasQuota: !!afterPollMain?.quota,
      },
    }
    console.log('ROLLBACK_OBSERVED', JSON.stringify(observed))
    await runtime.close()

    // Rewrite only the quota with the established encoding. If this control
    // serves, the credential epoch, identity, and migration setup did not cause refusal.
    const legacy = branch.createNativePoolStore({
      paths,
      quota: {
        validate: nativeQuotaCodec.validate,
        merge: (_stored, incoming) => incoming,
      },
    })
    close.push(() => legacy.close())
    await legacy.recordQuota(
      'bad',
      { credentialEpoch: 1, identity: identities.bad },
      observation,
    )
    await legacy.close()
    const control = published.createNativeAccountRuntime(options)
    close.push(() => control.close())
    const controlSnapshot = await control.read()
    const controlMain = controlSnapshot.accounts.find(
      (account) => account.id === 'main',
    )
    const controlAdmission = await control.authorizeLocal('main')
    const controlRefresh = await control.authorizeLocal('main', {
      intent: 'refresh',
    })
    console.log(
      'ROLLBACK_LEGACY_CONTROL',
      JSON.stringify({
        enabled: controlMain?.enabled,
        hasQuota: !!controlMain?.quota,
        display: privateCodec.rollbackDisplay(controlMain?.quota, now),
        admission: controlAdmission.status,
        refresh: controlRefresh.status,
      }),
    )
    expect(controlMain?.enabled).toBe(true)
    expect(controlMain?.quota?.five_hour?.remainingPercent).toBe(80)
    expect(controlAdmission.status).toBe('usable')
    expect(controlRefresh.status).toBe('usable')

    expect(main?.enabled).toBe(true)
    expect(main?.binding).toBeDefined()
    if (accepted) {
      expect(main?.quota?.five_hour?.remainingPercent).toBe(80)
      expect(display).toBeDefined()
    } else {
      expect(main?.quota).toBeUndefined()
      expect(displayText).toBe('no quota reading yet')
    }
    expect(admission.status).toBe('usable')
    expect(goodAdmission.status).toBe('usable')
    expect(refresh.status).toBe('usable')
    expect(poll.ok).toBe(true)
    expect(polls).toBe(1)
    expect(afterPollMain?.quota?.five_hour?.remainingPercent).toBe(90)
  } finally {
    await Promise.allSettled(close.map((dispose) => dispose()))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
