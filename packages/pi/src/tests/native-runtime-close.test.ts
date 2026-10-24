import { expect, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'

const { test, gate, deferCleanup, trackDetached } = createTestLifetimeSuite()

test('Pi shutdown joins a quota drain from an evicted runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-evicted-runtime-'))
  const paths = Array.from({ length: 17 }, (_, index) =>
    join(root, `${index}.json`),
  )
  const drain = gate()
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  deferCleanup(async () => {
    drain.open()
    await Promise.all(paths.map((path) => closePiNativeRuntime(path)))
  })
  const first = getPiNativeRuntime(paths[0]!)
  const close = first.close.bind(first)
  const closing = drain.wait.then(close)
  const spy = spyOn(first, 'close').mockReturnValue(closing)
  deferCleanup(() => spy.mockRestore())
  trackDetached(closing)
  for (const path of paths.slice(1)) getPiNativeRuntime(path)
  expect(spy).toHaveBeenCalledTimes(1)
  let finished = false
  const shutdown = closePiNativeRuntime(paths[0]!).then(() => {
    finished = true
  })
  trackDetached(shutdown)
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(finished).toBe(false)
  } finally {
    drain.open()
  }
  await shutdown
  expect(finished).toBe(true)
})
