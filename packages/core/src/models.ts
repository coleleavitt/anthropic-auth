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

/**
 * Fable 5.1 and Mythos 5.1 share Fable/Mythos 5's input, output, and cache-write
 * rates but sit on a cheaper cache-read tier: Claude Code's baked catalog maps
 * `claude-fable-5`/`claude-mythos-5` to `tier_10_50` (cache read $1.00) and
 * `claude-fable-5-1`/`claude-mythos-5-1` to `tier_10_50_cache_read_0_25`
 * (cache read $0.25). Without this split the 5.1 models are billed at 4x their
 * true cache-read rate in cost projections.
 */
export const CLAUDE_FABLE_MYTHOS_5_1_PRICING = {
  ...CLAUDE_FABLE_MYTHOS_5_PRICING,
  cacheRead: 0.25,
} as const

/**
 * True for the 5.1 point releases of the Fable/Mythos families, which differ from
 * their 5.0 counterparts only in cache-read pricing.
 */
export function isClaudeFableOrMythos5PointOneModel(model: unknown): boolean {
  if (typeof model !== 'string') return false
  const canonical = model.trim().toLowerCase()
  return CLAUDE_FABLE_MYTHOS_5_MODEL_IDS.some(
    (id) => canonical === `${id}-1` || canonical.startsWith(`${id}-1-`),
  )
}

/**
 * Cache-read-accurate pricing for any Fable/Mythos model, selecting the 5.1 tier
 * when the id is a 5.1 point release.
 */
export function resolveClaudeFableMythos5Pricing(model: unknown) {
  return isClaudeFableOrMythos5PointOneModel(model)
    ? CLAUDE_FABLE_MYTHOS_5_1_PRICING
    : CLAUDE_FABLE_MYTHOS_5_PRICING
}

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

/**
 * NOTE ON `claude-mythos-5`: its entry in Claude Code's baked model catalog ships
 * `capabilities: []`, which looks like it denies adaptive thinking. It does not.
 * The catalog lookup returns `undefined` ("unknown"), never `false`, for a
 * capability that is merely absent, and Claude Code additionally hardcodes
 * `|| canonical === "claude-mythos-5"` into its `adaptive_thinking`, `effort`,
 * `max_effort`, and `xhigh_effort` predicates precisely because the catalog entry
 * is empty. Mythos 5 is adaptive and effort-capable, and (like Fable) it rejects
 * `{type:"disabled"}`, so treating it as adaptive here is correct.
 */
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

/**
 * True for every member of the Opus 5 series, including the 5.5 point release
 * (`claude-opus-5-5`) and dated snapshots. Call sites use this as the FAMILY
 * predicate — adaptive thinking injection, server-side fallback eligibility,
 * refusal recovery, effort variants — because those behaviors are shared.
 * Anything that differs between 5.0 and 5.5 (pricing, disabled-thinking
 * support, display label) must additionally consult
 * {@link isClaudeOpus55Model}.
 */
export function isClaudeOpus5Model(model: unknown) {
  return (
    typeof model === 'string' &&
    (model === CLAUDE_OPUS_5_MODEL_ID ||
      model.startsWith(`${CLAUDE_OPUS_5_MODEL_ID}-`))
  )
}

/**
 * Opus 5.5 — a separate catalog entry in Claude Code 2.1.280, not a snapshot of
 * Opus 5. It differs from Opus 5 in three ways that change the wire request or
 * the numbers we report:
 *
 *  - pricing: `tier_4_20_cache_read_0_20` ($4 in / $20 out / $0.20 cache read)
 *    against Opus 5's `tier_5_25` ($5 / $25 / $0.50)
 *  - thinking: capability `rejects_disabled_thinking` — `{type:"disabled"}` is a
 *    400 ("\"thinking.type.disabled\" is not supported for this model"), while
 *    Opus 5 accepts it under `thinking_disabled_effort_cap`
 *  - default effort: `medium` against Opus 5's `high`
 *
 * Matched on the exact id plus dated snapshots, never on Opus 5's prefix.
 */
export const CLAUDE_OPUS_5_5_MODEL_ID = 'claude-opus-5-5'

export function isClaudeOpus55Model(model: unknown) {
  if (typeof model !== 'string') return false
  const normalized = model.trim().toLowerCase()
  return (
    normalized === CLAUDE_OPUS_5_5_MODEL_ID ||
    normalized.startsWith(`${CLAUDE_OPUS_5_5_MODEL_ID}-`)
  )
}

/**
 * Per-million-token USD pricing for Opus 5.5, mirroring Claude Code 2.1.280's
 * `tier_4_20_cache_read_0_20`. Opus 5.5 is CHEAPER than Opus 5 on every axis,
 * so reusing the Opus 5 prefix price overstates cost by 25% on tokens and 2.5x
 * on cache reads.
 */
export const CLAUDE_OPUS_5_5_PRICING = {
  input: 4,
  output: 20,
  cacheRead: 0.2,
  cacheWrite5m: 5,
  cacheWrite1h: 8,
} as const

export const CLAUDE_OPUS_5_5_CONTEXT_WINDOW = 1_000_000
export const CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS = 128_000

/**
 * Models that reject `thinking: {type:"disabled"}` outright (HTTP 400,
 * `invalid_request_error`: use `thinking.type.adaptive` and
 * `output_config.effort`). Mirrors the `rejects_disabled_thinking` capability
 * in Claude Code 2.1.280's baked catalog: Fable 5, Fable 5.1, Mythos 5.1, and
 * Opus 5.5. Mythos 5 ships an empty capability array but is hardcoded adaptive
 * by Claude Code, and it rejects a disable exactly like Fable, so the whole
 * Fable/Mythos family is covered here.
 *
 * Opus 5 and Sonnet 5 are deliberately absent: both accept an explicit disable
 * (Opus 5 only caps `effort` at `high` while disabled), so a caller's opt-out
 * is honored there.
 */
export function modelRejectsDisabledThinking(model: unknown): boolean {
  return isClaudeFableOrMythos5Model(model) || isClaudeOpus55Model(model)
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

/**
 * Canonical model id: strips a trailing `-YYYYMMDD` / `@YYYYMMDD` snapshot suffix
 * and the `[1m]` context marker, matching Claude Code's `getCanonicalName`.
 */
const CANONICAL_CLAUDE_FAMILY_MATCHERS: ReadonlyArray<
  readonly [needle: RegExp, canonical: string]
> = [
  [/claude-opus-4-8/, 'claude-opus-4-8'],
  [/claude-opus-4-7/, 'claude-opus-4-7'],
  [/claude-opus-4-6/, 'claude-opus-4-6'],
  [/claude-opus-4-5/, 'claude-opus-4-5'],
  [/claude-opus-4-1/, 'claude-opus-4-1'],
  [/claude-opus-4(?!-\d(?!\d))/, 'claude-opus-4-0'],
  [/claude-sonnet-4-6/, 'claude-sonnet-4-6'],
  [/claude-sonnet-4-5/, 'claude-sonnet-4-5'],
  [/claude-sonnet-4(?!-\d(?!\d))/, 'claude-sonnet-4-0'],
  [/claude-haiku-4-5/, 'claude-haiku-4-5'],
  [/claude-3-7-sonnet/, 'claude-3-7-sonnet'],
  [/claude-3-5-sonnet/, 'claude-3-5-sonnet'],
  [/claude-3-5-haiku/, 'claude-3-5-haiku'],
  [/claude-3-opus/, 'claude-3-opus'],
  [/claude-3-sonnet/, 'claude-3-sonnet'],
  [/claude-3-haiku/, 'claude-3-haiku'],
]

export function canonicalClaudeModelId(model: string): string {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]/gi, '')
  for (const [needle, canonical] of CANONICAL_CLAUDE_FAMILY_MATCHERS) {
    if (needle.test(normalized)) return canonical
  }
  return normalized.replace(/[-@]\d{8}$/, '')
}

function isFirstPartyClaudeId(canonical: string): boolean {
  return canonical.startsWith('claude-') || canonical.startsWith('anthropic')
}

export function modelSupportsAdaptiveThinking(model: unknown): boolean {
  if (typeof model !== 'string') return false
  const canonical = canonicalClaudeModelId(model)
  if (canonical.startsWith('claude-3-')) return false
  if (NON_ADAPTIVE_THINKING_MODEL_IDS.has(canonical)) return false
  return isFirstPartyClaudeId(canonical)
}

/**
 * `output_config.effort: "max"` support. Mirrors Claude Code's `N5$`, which shares
 * the adaptive-thinking split exactly: every model that supports adaptive thinking
 * also accepts `max` effort.
 */
export function modelSupportsMaxEffort(model: unknown): boolean {
  return modelSupportsAdaptiveThinking(model)
}

/**
 * `output_config.effort: "xhigh"` support. Mirrors Claude Code's `E5$`, which is
 * STRICTLY NARROWER than adaptive/max support: Opus 4.6 and Sonnet 4.6 are adaptive
 * and take `max`, but do NOT accept `xhigh`. Claude Code downgrades an unsupported
 * `xhigh` to `high` rather than sending it.
 */
const NON_XHIGH_EFFORT_MODEL_IDS = new Set([
  ...NON_ADAPTIVE_THINKING_MODEL_IDS,
  'claude-opus-4-6',
  'claude-sonnet-4-6',
])

export function modelSupportsXhighEffort(model: unknown): boolean {
  if (typeof model !== 'string') return false
  const canonical = canonicalClaudeModelId(model)
  if (canonical.startsWith('claude-3-')) return false
  if (NON_XHIGH_EFFORT_MODEL_IDS.has(canonical)) return false
  return isFirstPartyClaudeId(canonical)
}

/**
 * Downgrade an effort level the target model cannot serve, exactly as Claude Code
 * does before sending (`max`/`xhigh` → `high`). Sending an unsupported level is a
 * request-shaping error, so it is corrected rather than passed through.
 */
export function clampEffortForModel(effort: string, model: unknown): string {
  if (effort === 'max' && !modelSupportsMaxEffort(model)) return 'high'
  if (effort === 'xhigh' && !modelSupportsXhighEffort(model)) return 'high'
  return effort
}

/**
 * Models where adaptive thinking can be forced back to a manual token budget.
 * Mirrors Claude Code's `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` gate, which is
 * deliberately limited to Opus 4.6 and Sonnet 4.6: those two still ACCEPT the
 * deprecated `{type:"enabled",budget_tokens}` shape (the SDK only logs a
 * deprecation warning), whereas Opus 4.7 and newer hard-reject `budget_tokens`
 * with a 400. Forcing a manual budget on anything else would break the request,
 * so the escape hatch must not apply to other models.
 */
const FORCIBLE_MANUAL_THINKING_MODEL_IDS = new Set([
  'claude-opus-4-6',
  'claude-sonnet-4-6',
])

export function modelAllowsForcedManualThinking(model: unknown): boolean {
  if (typeof model !== 'string') return false
  return FORCIBLE_MANUAL_THINKING_MODEL_IDS.has(canonicalClaudeModelId(model))
}

/**
 * Resolves the thinking shape for a model, honoring the opt-in
 * `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` escape hatch. Returns `'adaptive'` for
 * models on the adaptive contract and `'budget'` for the legacy manual-budget
 * families. The escape hatch downgrades ONLY the two models that still accept a
 * manual budget; it is ignored everywhere else so it cannot produce a 400.
 */
export function resolveThinkingShape(
  model: unknown,
  env: Record<string, string | undefined> = process.env,
): 'adaptive' | 'budget' {
  if (!modelSupportsAdaptiveThinking(model)) return 'budget'
  const flag = env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING?.trim().toLowerCase()
  const disabled =
    flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
  if (disabled && modelAllowsForcedManualThinking(model)) return 'budget'
  return 'adaptive'
}

export const CLAUDE_OPUS_4_8_MODEL_ID = 'claude-opus-4-8'

/**
 * Anthropic refusal categories carried on `message_delta.delta.stop_details`.
 * Claude Code 2.1.280 recognizes `bio`/`cyber` (`U5t`) and
 * `frontier_llm`/`reasoning_extraction` (`Cj`), collapsing anything else to
 * `other` (`DX`). Only categories present in a model's route map below are
 * routed; the rest are unmapped.
 */
export type RefusalCategory =
  | 'bio'
  | 'cyber'
  | 'frontier_llm'
  | 'reasoning_extraction'
  | (string & {})

/**
 * Per-model refusal-category → fallback-model route maps, mirrored verbatim from
 * Claude Code 2.1.280 (`chunk-8knzj4cj.js`, selector `Lj`):
 *
 *   Pj (default)  = { bio: "claude-opus-5", cyber: "claude-opus-4-8" }
 *   Dj (opus-5)   = { cyber: "claude-opus-4-8" }   // bio has NO route on opus-5
 *   Mj (opus-5-5) = { bio: "claude-opus-5", cyber: "claude-opus-4-8",
 *                     frontier_llm: "claude-opus-5" }
 *   Ij            = { bio/cyber → opus-4-8 }, selected only when `Hc()` is true,
 *                   and `Hc` is `return false` in the shipped build — dead.
 *
 * `Lj` matches the plain id and the `[1m]` suffixed form, so the maps are keyed
 * on the canonical (snapshot- and `[1m]`-stripped) id here. Claude Code also
 * allows a route VALUE to be a chain (array) capped at 3 hops (`Oj`); every
 * shipped route is a single model, so these stay scalar.
 */
const REFUSAL_ROUTE_DEFAULT: Readonly<Record<string, string>> = {
  bio: CLAUDE_OPUS_5_MODEL_ID,
  cyber: CLAUDE_OPUS_4_8_MODEL_ID,
}
const REFUSAL_ROUTE_OPUS_5: Readonly<Record<string, string>> = {
  cyber: CLAUDE_OPUS_4_8_MODEL_ID,
}
const REFUSAL_ROUTE_OPUS_5_5: Readonly<Record<string, string>> = {
  bio: CLAUDE_OPUS_5_MODEL_ID,
  cyber: CLAUDE_OPUS_4_8_MODEL_ID,
  frontier_llm: CLAUDE_OPUS_5_MODEL_ID,
}

/** The safe floor a terminal refusal downgrades to when no category route applies. */
export const CLAUDE_REFUSAL_CATCH_ALL_MODEL = CLAUDE_OPUS_4_8_MODEL_ID

export function refusalFallbackRouteMap(
  model: string,
): Readonly<Record<string, string>> {
  const canonical = canonicalClaudeModelId(model)
  if (canonical === CLAUDE_OPUS_5_5_MODEL_ID) return REFUSAL_ROUTE_OPUS_5_5
  if (canonical === CLAUDE_OPUS_5_MODEL_ID) return REFUSAL_ROUTE_OPUS_5
  return REFUSAL_ROUTE_DEFAULT
}

/**
 * Resolves the model a terminal `stop_reason: refusal` should re-route to, given
 * the refusing model, the Anthropic refusal category (may be null/unknown), and
 * the canonical ids already tried this turn.
 *
 * Faithful to Claude Code's category map (bio/cyber), with one deliberate
 * addition: when the category is missing or unmapped and `catchAll` is set
 * (default), it downgrades to opus-4-8 — the safe floor a user reaches by hand
 * today. Never routes to the refusing model itself or to an already-tried model,
 * so a bounded hop count cannot loop.
 */
export function resolveRefusalFallbackModel(
  model: string,
  category: string | null | undefined,
  triedModels: readonly string[] = [],
  options: { catchAll?: boolean } = {},
): string | undefined {
  const catchAll = options.catchAll ?? true
  const map = refusalFallbackRouteMap(model)
  const mapped = category ? map[category] : undefined
  const candidate =
    mapped ?? (catchAll ? CLAUDE_REFUSAL_CATCH_ALL_MODEL : undefined)
  if (!candidate) return undefined
  const candidateCanonical = canonicalClaudeModelId(candidate)
  if (candidateCanonical === canonicalClaudeModelId(model)) return undefined
  const tried = new Set(triedModels.map((id) => canonicalClaudeModelId(id)))
  if (tried.has(candidateCanonical)) return undefined
  return candidate
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
