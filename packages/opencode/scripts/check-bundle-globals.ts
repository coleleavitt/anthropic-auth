import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const distDir = join(import.meta.dir, '..', 'dist')
const bundlePath = join(distDir, 'index.js')
const minBundleBytes = 1024

try {
  await stat(bundlePath)
} catch {
  throw new Error(`Bundle artifact check failed: ${bundlePath} is missing`)
}

// The build uses --splitting (OpenCode 1 and OpenCode 2 entry points share
// chunks), so index.js is a thin entry; check the whole emitted JS graph.
const jsFiles = (await readdir(distDir, { recursive: true }))
  .filter((file) => file.endsWith('.js'))
  .map((file) => join(distDir, file))
const bundle = (
  await Promise.all(jsFiles.map((file) => readFile(file, 'utf8')))
).join('\n')
const size = Buffer.byteLength(bundle)

if (size <= minBundleBytes) {
  throw new Error(
    `Bundle artifact check failed: ${distDir} is not substantial (${size} bytes)`,
  )
}
const registryMatches = bundle.match(/__anthropicAuthRpcServers/g)?.length ?? 0
if (registryMatches === 0) {
  throw new Error(
    'Bundle positive-control check failed: __anthropicAuthRpcServers is absent',
  )
}

// This catches one identifier; the positive control makes its zero assertion meaningful, not proof that no other stale global exists.
const singularMatches =
  bundle.match(/__anthropicAuthRpcServer(?!s)/g)?.length ?? 0
if (singularMatches !== 0) {
  throw new Error(
    `Bundle stale-global check failed: __anthropicAuthRpcServer appears ${singularMatches} time(s)`,
  )
}
