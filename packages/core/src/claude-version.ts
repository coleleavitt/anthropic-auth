import { CLAUDE_CODE_VERSION } from './constants.ts'

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[\w.-]+)?$/
const VERSION_CACHE_TTL_MS = 3_600_000
const FETCH_TIMEOUT_MS = 5_000
const LATEST_VERSION_URL =
  'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'

function isValidVersion(version: string): boolean {
  return SEMVER_PATTERN.test(version) && version.length <= 50
}

function versionParts(version: string): [number, number, number] {
  const [core = ''] = version.split('-')
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return [major, minor, patch]
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < 3; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

let cachedVersion: string | null = null
let cachedAt = 0
let inflight: Promise<string> | null = null

export function getCachedClaudeCodeVersion(): string {
  return cachedVersion ?? CLAUDE_CODE_VERSION
}

export async function getClaudeCodeVersion(): Promise<string> {
  if (process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK === '1')
    return getCachedClaudeCodeVersion()
  const now = Date.now()
  if (cachedVersion && now >= cachedAt && now - cachedAt < VERSION_CACHE_TTL_MS)
    return cachedVersion
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const response = await fetch(LATEST_VERSION_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return getCachedClaudeCodeVersion()
      }
      const data = (await response.json()) as { version?: string }
      if (!data.version || !isValidVersion(data.version))
        return getCachedClaudeCodeVersion()
      // Never downgrade below the verified floor: a stale registry mirror must
      // not reintroduce a fingerprint Anthropic already rejects.
      cachedVersion =
        compareVersions(data.version, CLAUDE_CODE_VERSION) >= 0
          ? data.version
          : CLAUDE_CODE_VERSION
      cachedAt = Date.now()
      return cachedVersion
    } catch {
      return getCachedClaudeCodeVersion()
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export function getClaudeCodeUserAgent(
  version: string = getCachedClaudeCodeVersion(),
): string {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT?.trim() || 'cli'
  const details = [entrypoint]
  const sdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION?.trim()
  if (sdkVersion) details.push(`agent-sdk/${sdkVersion}`)
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP?.trim()
  if (clientApp) details.push(`client-app/${clientApp}`)
  return `claude-cli/${version} (external, ${details.join(', ')})`
}

export function resetClaudeCodeVersionCache(): void {
  cachedVersion = null
  cachedAt = 0
  inflight = null
}
