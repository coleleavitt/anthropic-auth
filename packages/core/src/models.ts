export const CLAUDE_FABLE_5_MODEL_ID = 'claude-fable-5'
export const CLAUDE_MYTHOS_5_MODEL_ID = 'claude-mythos-5'

/**
 * Haiku 4.5 model identifier used by `/claude-prime` to start each OAuth
 * account's five-hour quota window with a minimal request. Usage is measured
 * from response accounting. Kept distinct from the Fable/Mythos pricing block
 * above so per-million-token cost estimation does not conflate families.
 */
export const CLAUDE_HAIKU_4_5_MODEL_ID = 'claude-haiku-4-5'

/**
 * Per-million-token USD pricing for Haiku 4.5. Used to project the cumulative
 * cost of prime requests from persisted usage counters — never persisted on
 * disk; derive at display time so future pricing revisions land in one place.
 */
export const CLAUDE_HAIKU_4_5_PRICING = {
  input: 1,
  output: 5,
} as const

export const CLAUDE_FABLE_MYTHOS_5_MODEL_IDS = [
  CLAUDE_FABLE_5_MODEL_ID,
  CLAUDE_MYTHOS_5_MODEL_ID,
] as const

export type ClaudeFableMythos5ModelId =
  (typeof CLAUDE_FABLE_MYTHOS_5_MODEL_IDS)[number]

export const CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING = {
  type: 'adaptive',
  display: 'summarized',
} as const

export const CLAUDE_FABLE_MYTHOS_5_PRICING = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
} as const

export const CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW = 1_000_000
export const CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS = 128_000
export const CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE = '2026-06-09'

export const CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS: Record<
  ClaudeFableMythos5ModelId,
  { id: ClaudeFableMythos5ModelId; name: string; limited?: boolean }
> = {
  [CLAUDE_FABLE_5_MODEL_ID]: {
    id: CLAUDE_FABLE_5_MODEL_ID,
    name: 'Claude Fable 5',
  },
  [CLAUDE_MYTHOS_5_MODEL_ID]: {
    id: CLAUDE_MYTHOS_5_MODEL_ID,
    name: 'Claude Mythos 5',
    limited: true,
  },
}

export function isClaudeFableOrMythos5Model(model: unknown) {
  return (
    typeof model === 'string' &&
    CLAUDE_FABLE_MYTHOS_5_MODEL_IDS.some(
      (id) => model === id || model.startsWith(`${id}-`),
    )
  )
}

export const CLAUDE_SONNET_5_MODEL_ID = 'claude-sonnet-5'

/**
 * Sonnet 5 enables adaptive thinking by default but ships `display: "omitted"`,
 * so the `thinking` field returns empty and the user sees nothing. Injecting
 * this makes the adaptive thinking summary visible. Reuses the Fable/Mythos
 * shape because the API contract is identical.
 */
export const CLAUDE_SONNET_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeSonnet5Model(model: unknown) {
  return (
    typeof model === 'string' &&
    (model === CLAUDE_SONNET_5_MODEL_ID ||
      model.startsWith(`${CLAUDE_SONNET_5_MODEL_ID}-`))
  )
}

export const CLAUDE_OPUS_5_MODEL_ID = 'claude-opus-5'

/**
 * Opus 5 has the same adaptive-thinking-by-default + `display: "omitted"`
 * shape as Sonnet 5, so the injected thinking must also be summarized to be
 * visible. Kept as its own constant per the PR #100 lesson — hook callers
 * should reference the per-family name (`CLAUDE_OPUS_5_ADAPTIVE_THINKING`,
 * not the Fable/Mythos alias) so a future divergence between the families
 * only changes this re-export, not every call site.
 */
export const CLAUDE_OPUS_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeOpus5Model(model: unknown) {
  return (
    typeof model === 'string' &&
    (model === CLAUDE_OPUS_5_MODEL_ID ||
      model.startsWith(`${CLAUDE_OPUS_5_MODEL_ID}-`))
  )
}

/**
 * Models that use adaptive thinking (`{type:"adaptive"}` + `output_config.effort`)
 * rather than the legacy `{type:"enabled", budget_tokens:N}` shape. Mirrors Claude
 * Code 2.1.260's model capability catalog and the 2.1.137 `FH8` predicate: adaptive
 * thinking is the default for first-party models, with an explicit deny list for the
 * older families that only accept manual token budgets.
 *
 * Sending `budget_tokens` to an adaptive-only model 400s (hard rejection on Opus 4.7+),
 * and adaptive models pair thinking depth with `effort`, not a token budget. Fable/
 * Mythos 5, Sonnet 5, and Opus 5 are covered by their own predicates but are adaptive
 * too, so this returns true for them as well.
 *
 * The deny list is matched on the canonical (date-suffix-stripped) model id:
 * `claude-3-*`, `claude-opus-4-0/4-1/4-5`, `claude-sonnet-4-0/4-5`, `claude-haiku-4-5`.
 * Everything else (Opus 4.6/4.7/4.8, Sonnet 4.6, all 5-series) is adaptive.
 */
const NON_ADAPTIVE_THINKING_MODEL_IDS = new Set([
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
])

export function modelSupportsAdaptiveThinking(model: unknown): boolean {
  if (typeof model !== 'string') return false
  // Strip a trailing 8-digit or @date version suffix to get the canonical id.
  const canonical = model
    .trim()
    .toLowerCase()
    .replace(/[-@]\d{8}$/, '')
  if (canonical.startsWith('claude-3-')) return false
  if (NON_ADAPTIVE_THINKING_MODEL_IDS.has(canonical)) return false
  return canonical.startsWith('claude-') || canonical.startsWith('anthropic')
}

export function isOpenAIReasoningSignature(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.startsWith('gAAAA')) return true
  if (!value.startsWith('{')) return false

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return (
      parsed.type === 'reasoning' &&
      typeof parsed.id === 'string' &&
      parsed.id.startsWith('rs_') &&
      typeof parsed.encrypted_content === 'string' &&
      parsed.encrypted_content.startsWith('gAAAA')
    )
  } catch {
    return false
  }
}
