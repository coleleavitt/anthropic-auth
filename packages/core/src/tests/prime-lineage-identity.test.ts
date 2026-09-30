import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAccountStatePath,
  getOrCreatePrimeAuthLineageId,
  storeCredentialIdentity,
} from '../accounts.ts'

let dir: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prime-lineage-'))
  configPath = join(dir, 'anthropic-auth.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('a store-backed main keeps one lineage across refreshes', async () => {
  const identity = storeCredentialIdentity('work@example.com')
  const first = await getOrCreatePrimeAuthLineageId(
    'main',
    configPath,
    identity,
  )
  expect(first).toBeTruthy()
  // Refreshes happen in the store and do not change the identity.
  expect(
    await getOrCreatePrimeAuthLineageId('main', configPath, identity),
  ).toBe(first)
  // No identity observed: the bound lineage is still served.
  expect(await getOrCreatePrimeAuthLineageId('main', configPath)).toBe(first)
})

test('switching the main account mints a new lineage', async () => {
  const first = await getOrCreatePrimeAuthLineageId(
    'main',
    configPath,
    storeCredentialIdentity('a'),
  )
  const second = await getOrCreatePrimeAuthLineageId(
    'main',
    configPath,
    storeCredentialIdentity('b'),
  )
  expect(second).toBeTruthy()
  expect(second).not.toBe(first)
})

test('without any identity no lineage is created', async () => {
  expect(
    await getOrCreatePrimeAuthLineageId('main', configPath),
  ).toBeUndefined()
})

test('only a fingerprint of the identity is persisted', async () => {
  await getOrCreatePrimeAuthLineageId(
    'main',
    configPath,
    'sk-ant-oat01-staticstaticstaticstaticstatic',
  )
  const state = readFileSync(getAccountStatePath(configPath), 'utf8')
  expect(state).not.toContain('sk-ant-')
})
