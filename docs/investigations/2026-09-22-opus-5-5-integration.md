# Opus 5.5 (Claude Code 2.1.280) — what changed here

Date: 2026-09-22
Binary: Claude Code **2.1.280** (`BUILD_TIME 2026-09-21T20:40:17Z`), extracted to
`~/SiteResearch/anthropic/v2.1.280/extracted` with `bun_binary_extractor`, beautified with `jsbeautify -d`.

Companion reports:

- [`2026-09-22-claude-code-2.1.280-diff.md`](./2026-09-22-claude-code-2.1.280-diff.md) — full 2.1.278 → 2.1.280 behavioral diff
- [`2026-09-22-opus-5-5-capabilities.md`](./2026-09-22-opus-5-5-capabilities.md) — capability-by-capability wire analysis

## The model

`claude-opus-5-5` ("Opus 5.5") is the only new catalog entry in 2.1.280. It is a separate model, not an
Opus 5 snapshot:

| | Opus 5 | Opus 5.5 |
|---|---|---|
| pricing tier | `tier_5_25` — $5 / $25, cache read $0.50 | `tier_4_20_cache_read_0_20` — **$4 / $20, cache read $0.20**, cache write 5m $5 / 1h $8 |
| `default_effort` | `high` | `medium` |
| `max_output_tokens` | 64k default / 128k upper | 128k / 128k |
| disabled thinking | accepted (`thinking_disabled_effort_cap`) | **rejected** (`rejects_disabled_thinking`) |
| refusal routes | `{cyber: opus-4-8}` | `{bio: opus-5, cyber: opus-4-8, frontier_llm: opus-5}` |
| knowledge cutoff | January 2026 | June 2026 |

Catalog-wide: the `opus` alias and `latest_per_family.opus` now resolve to `claude-opus-5-5`, and
`claude-fable-5.fallback_3p` was retargeted from `claude-opus-5` to `claude-opus-5-5`. Nothing else changed.

## Two gates that blocked us, both verified live

1. **Declared-version gate.** Anthropic rejects `claude-opus-5-5` when the request's `user-agent` declares a
   Claude Code version below 2.1.280:

   ```
   HTTP 400 invalid_request_error
   "Claude Code 2.1.260 does not support this model; version 2.1.280 or newer is required."
   details.error_code = "claude_code_version_too_old"
   ```

   The gate reads the **user agent**, not the billing header: a request with `user-agent: claude-cli/2.1.280`
   and `x-anthropic-billing-header: cc_version=2.1.260; ...` succeeds. Our offline floor was `2.1.260`.

2. **Disabled thinking.** `thinking: {"type":"disabled"}` on Opus 5.5 is a hard 400
   (`"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and
   "output_config.effort" to control thinking behavior.`), while the same request succeeds on Opus 5.
   Claude Code handles this by omitting the `thinking` key entirely; we send the adaptive shape, which is
   the treatment Fable/Mythos already gets — visible summarized reasoning instead of a silent omission.

## Changes in this repo

- `constants.ts`: `CLAUDE_CODE_VERSION` floor `2.1.260` → `2.1.280`. The npm-tracked live version already
  reaches 2.1.280 within an hour of start, but the floor covers cold start, offline use, and
  `OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK=1`.
- `models.ts`: `CLAUDE_OPUS_5_5_MODEL_ID`, `isClaudeOpus55Model`, `CLAUDE_OPUS_5_5_PRICING`,
  `modelRejectsDisabledThinking`, and the Opus 5.5 refusal route map (`frontier_llm` is the first such route
  Anthropic has shipped). `isClaudeOpus5Model` stays inclusive — Opus 5.5 shares server-fallback eligibility,
  refusal recovery, and the effort variants with Opus 5.
- `model-catalog.ts`: Opus 5.5 pricing entry. Without it the `claude-opus-5` prefix matched and reporting
  overstated cost by 25% on tokens and **2.5x on cache reads** — the same class of bug as Fable 5.1.
- `transform.ts`: a disabled-thinking request for Opus 5.5 is rewritten to adaptive instead of 400ing.
- `opencode/index.ts`: publishes `claude-opus-5-5` when the host catalog has not caught up (same mechanism as
  the Fable/Mythos injection), labels it "Opus 5.5" in fallback notices, and detects the version gate on a 400
  to force a version refresh instead of surfacing an opaque error.
- `pi/index.ts`: Opus 5.5 in the offline fallback catalog. The live `/v1/models` path already lists it — the
  6-hour cache is the only delay.
- `pi/stream.ts`: the version gate produces an actionable error instead of a raw 400 body.
- `retry-policy.ts`: `isClaudeCodeVersionTooOldError` / `requiredClaudeCodeVersion`.
- `model-catalog.ts`: the cache now records the Claude Code version it was fetched under, and a version
  change invalidates it regardless of age (`modelCatalogVersionChanged`). The 6-hour TTL alone hid Opus 5.5
  for hours after the 2.1.280 update — the cache on this machine was written at 08:22 and the model launched
  at 12:59. On a version change the refresh is awaited (bounded by the 3s fetch timeout) instead of serving
  a list that is known to predate the release; a failed refresh still falls back to the stale list.
- `encrypted-content.ts` (new): 2.1.280 added `web_search_content_rejected` and
  `code_execution_output_rejected` labels for 400s on `search_result.encrypted_content`,
  `text.encrypted_index`, and `encrypted_code_execution_result.encrypted_stdout`. Those payloads are bound to
  the credential that issued them, so a session migrated to a fallback account is rejected. Anthropic only
  labels it; the OpenCode path now strips the undecryptable blocks (replacing them with a text placeholder so
  no `content` array is left empty) and retries once on the same account.

## Live verification

```
UA (offline floor): claude-cli/2.1.280 (external, cli)
cost opus-5-5: {"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5}
cost opus-5  : {"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}
rewritten thinking: {"type":"adaptive","display":"summarized"}  output_config: {"effort":"max"}
live POST with plugin-rewritten body -> 200 {"model":"claude-opus-5-5", ...}
```

`GET /v1/models` under subscription OAuth already returns `claude-opus-5-5` (1M context, 128k output,
effort `low|medium|high|xhigh|max`, adaptive thinking, no budget thinking).

Pi's resolved catalog before and after the cache change, on the same machine and the same 08:22 cache file:

```
before: 11 models, no claude-opus-5-5   (cache still inside its 6h TTL)
after:  12 models, claude-opus-5-5 {"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5}
```

## Not adopted (yet)

- `inline-tools-2026-09-15` and the `retry:inline-tools-strip` rung — only relevant if we emit
  `tool_definition` blocks mid-conversation, which we do not.
- Per-turn control (`per-turn-control-2026-07-01` + `timing-2026-09-09`) — a `role:"system"` message carrying
  `output_config.effort` / `output_config.timing`. Opus 5.5 supports it; neither host exposes per-turn effort.
- Tri-state foreign-thinking retention (`tengu_rustling_pixel`, default `all`). Expect more cross-model signed
  thinking blocks on the wire than under 2.1.278.
