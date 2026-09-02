import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const fixtureDir = join(
  import.meta.dir,
  '..',
  'packages/opencode/src/tests/fixtures/claustrum-golden',
)
const source = JSON.parse(
  await readFile(join(fixtureDir, 'SOURCE.json'), 'utf8'),
) as {
  repo: string
  ref: string
  paths: Record<string, string>
}

let drifted = false
for (const [name, sourcePath] of Object.entries(source.paths)) {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${sourcePath}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${name} golden: ${response.status} ${url}`)
  }
  const remote = Buffer.from(await response.arrayBuffer())
  const local = await readFile(join(fixtureDir, `${name}.json`))
  if (Buffer.compare(remote, local) !== 0) {
    console.error(`DRIFT: ${name}.json differs from ${url}`)
    drifted = true
    continue
  }
  console.log(`${name}.json: IDENTICAL (${source.ref})`)
}

if (drifted) process.exitCode = 1
