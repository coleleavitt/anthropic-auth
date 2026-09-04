import { createHash } from 'node:crypto'
import xxhashInit from 'xxhash-wasm'
import { getCachedClaudeCodeVersion } from './claude-version.ts'
import { CCH_POSITIONS, CCH_SALT } from './constants.ts'

type Message = {
  role?: string
  isMeta?: boolean
  content?: string | Array<{ type?: string; text?: string }>
}

// Claude Code 2.1.138–2.1.233 seed, independently validated against six
// controlled native-fetch oracles and four 92 KiB no-egress captures.
const CCH_SEED = 0x4d659218e32a3268n
const CCH_PLACEHOLDER = 'cch=00000;'
export const CCH_PATTERN = /\bcch=([0-9a-f]{5});/
const BILLING_HEADER_CCH_PATTERN =
  /("system":\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=[^;"]+; cc_entrypoint=[^;"]+; )cch=([0-9a-f]{5});/

let xxhashPromise: Promise<void> | null = null
let xxhash64Raw: ((input: Uint8Array, seed: bigint) => bigint) | null = null

async function ensureXxhash() {
  if (xxhash64Raw) return
  xxhashPromise ??= (async () => {
    const hasher = await xxhashInit()
    xxhash64Raw = hasher.h64Raw
  })()
  await xxhashPromise
}

/**
 * Extract text from the first user message's first text block.
 * Kept for diagnostics/backward-compatible tests; CCH signing no longer uses it.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find(
    (message) => message.role === 'user' && message.isMeta !== true,
  )
  if (!userMsg) return ''

  const { content } = userMsg
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block.type === 'text')
    if (textBlock?.text) return textBlock.text
  }

  return ''
}

/**
 * Compute the legacy CortexKit xxHash64 diagnostic token.
 *
 * Claude Code 2.1.260 does not place this value in its billing header; normal
 * request dispatch keeps the native literal `cch=00000`.
 */
export async function computeCCH(bodyBytes: Uint8Array): Promise<string> {
  await ensureXxhash()
  const hash = xxhash64Raw?.(bodyBytes, CCH_SEED) ?? 0n
  return (hash & 0xfffffn).toString(16).padStart(5, '0')
}

export async function computeXxhash64Hex(value: string): Promise<string> {
  await ensureXxhash()
  const hash = xxhash64Raw?.(new TextEncoder().encode(value), 0n) ?? 0n
  return hash.toString(16).padStart(16, '0').slice(0, 16)
}

export function resetBillingHeaderCCH(bodyString: string): string {
  return bodyString.replace(BILLING_HEADER_CCH_PATTERN, `$1${CCH_PLACEHOLDER}`)
}

/**
 * Build the legacy CortexKit diagnostic hash preimage.
 *
 * Retained for dump analysis and compatibility; it is not native 2.1.260 wire
 * signing and must not mutate a normal Messages request.
 */
export function buildCCHPreimage(bodyString: string): string {
  return bodyString
    .replace(/("model":")[^"]*(")/g, '$1$2')
    .replace(/"max_tokens":\d+,|,"max_tokens":\d+|"max_tokens":\d+(?=})/g, '')
}

export function extractBillingHeaderCCH(bodyString: string): string | null {
  return BILLING_HEADER_CCH_PATTERN.exec(bodyString)?.[2] ?? null
}

export async function signRequestBody(bodyString: string): Promise<string> {
  // Claude Code 2.1.260 emits this slot as the literal `cch=00000;`. Keep the
  // async API for callers while normalizing stale/non-native signed bodies back
  // to the native placeholder.
  return resetBillingHeaderCCH(bodyString)
}

/** Compute Claude Code's message-derived 3-character cc_version suffix. */
export function computeVersionSuffix(
  version: string = getCachedClaudeCodeVersion(),
  firstUserText = '',
): string {
  const sampled = CCH_POSITIONS.map(
    (position) => firstUserText[position] || '0',
  ).join('')
  return createHash('sha256')
    .update(`${CCH_SALT}${sampled}${version}`)
    .digest('hex')
    .slice(0, 3)
}

const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,36}$/
const PROMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BillingHeaderAttribution = {
  workload?: string
  isSubagent?: boolean
  previousRequestId?: string
  promptId?: string
}

/**
 * Build the billing header with Claude Code 2.1.260's literal cch placeholder.
 * `signRequestBody()` normalizes this slot but does not replace it with a hash.
 *
 * Segment order and spacing mirror Claude Code 2.1.260 exactly: each optional
 * segment carries its own leading space, and the cch placeholder is emitted
 * first so the five-character slot keeps a stable wire offset.
 */
export function buildBillingHeaderValue(
  _messages: Message[],
  version: string = getCachedClaudeCodeVersion(),
  entrypoint: string,
  _date: Date = new Date(),
  attribution: BillingHeaderAttribution = {},
): string {
  const suffix = computeVersionSuffix(
    version,
    extractFirstUserMessageText(_messages),
  )

  const workload = attribution.workload?.trim()
  const previousRequestId = attribution.previousRequestId?.trim()
  const promptId = attribution.promptId?.trim()

  return (
    'x-anthropic-billing-header: ' +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint};` +
    ' cch=00000;' +
    (workload ? ` cc_workload=${workload};` : '') +
    (attribution.isSubagent ? ' cc_is_subagent=true;' : '') +
    (previousRequestId && REQUEST_ID_PATTERN.test(previousRequestId)
      ? ` cc_prev_req=${previousRequestId};`
      : '') +
    (promptId && PROMPT_ID_PATTERN.test(promptId)
      ? ` cc_prompt_id=${promptId};`
      : '')
  )
}
