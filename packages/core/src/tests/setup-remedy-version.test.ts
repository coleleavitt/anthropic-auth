import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Users copy remedies such as "run npx @cortexkit/opencode-anthropic-auth
// setup" straight from error text and docs. A version pinned in that text
// stays the same while the plugin moves on, so following it installs an old
// release. Shipped source and docs must name the package without a version;
// templates such as `@${version}` and placeholders such as `@VERSION` are fine.
const PINNED_PACKAGE = /@cortexkit\/[a-z-]*anthropic-auth[a-z-]*@\d/

const root = join(import.meta.dir, '..', '..', '..', '..')

const USER_FACING = [
  'packages/{core,opencode,pi}/src/**/*.{ts,tsx}',
  'README.md',
  'packages/*/README.md',
  'docs/**/*.md',
]

function isTestFile(path: string): boolean {
  return (
    path.includes('/tests/') ||
    path.includes('/__tests__/') ||
    /\.test\.tsx?$/.test(path)
  )
}

test('no user-facing remedy names a pinned package version', async () => {
  const offenders: string[] = []
  let scanned = 0
  for (const pattern of USER_FACING) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) {
      const normalized = path.replaceAll('\\', '/')
      if (isTestFile(normalized)) continue
      scanned++
      const lines = (await readFile(join(root, path), 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (PINNED_PACKAGE.test(line))
          offenders.push(`${normalized}:${index + 1}`)
      })
    }
  }
  // Guard against a glob that silently matches nothing.
  expect(scanned).toBeGreaterThan(100)
  expect(offenders).toEqual([])
})
