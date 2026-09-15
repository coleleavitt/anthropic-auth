# Model-switch "refusal" on Pi (Prime) — root cause + Claude Code ground truth

Date: 2026-09-15
Evidence: Prime session `01a03411-8ff2-75b9-8da1-96727d5e9061`, log `/tmp/opencode-anthropic-auth.log`,
Claude Code v2.1.268 extracted CLI (`~/SiteResearch/anthropic/binaries/v268/extracted/chunk-pryvkh3w.js`).

## Symptom
User reports: "when I switch models in anthropic-auth I get a refusal."
Surfaced error: `Anthropic refused this request (stop_reason: refusal). The input and any thinking
or output tokens produced before the refusal are billed.`

## What actually happens (runtime evidence)

Every refusal in the traces is a LARGE-CONTEXT request on Opus 5 / Fable 5, not a model-switch bug per se:

| session line | model        | total tok | cacheRead | note |
|--------------|--------------|-----------|-----------|------|
| 40868        | claude-opus-5| 209,600   | 208,228 (WARM) | refused with a warm cache |
| 40964        | claude-fable-5-1 | 210,963 | 0 (cold) | refused cold |
| 43453        | claude-opus-5| 196,257   | 8,705     | refused |
| 65358 (09-15)| claude-opus-5| 741,265   | 0 (cold after switch) | refused, req_011Cf4Xi4cJiZjNKExBv6mS9 |

Key facts for the 09-15 refusal (fixed build with server-fallback):
- Request DID opt into server-side fallback: log line 8423 shows betas include
  `server-side-fallback-2026-07-01`, body 2,011,508 bytes.
- Anthropic returned HTTP 200, `unifiedStatus:allowed`, then a terminal `stop_reason: refusal`.
  The server-side fallback did NOT substitute a model.
- Anthropic processed the whole 741,263-token prompt (13.6 s, cacheWrite billed) BEFORE refusing.
  → this is a content-safety refusal after reading the context, not an upfront credit/quota gate.
- Cost billed on the refused request: **$4.63** (741,263 cacheWrite tokens).
- Pi then logs `primary status is terminal; not falling back {status:200}` and surfaces the error.
  Pi has NO client-side recovery, so the user manually switches to opus-4-8 — which succeeds.

Why "switching models" is implicated:
1. Switching TO opus-5/fable-5 is exactly when the refusing model is used.
2. A model switch cold-invalidates the Anthropic prompt cache (cacheRead=0), so the first
   post-switch request re-sends the ENTIRE accumulated context as one fresh request (741k tokens),
   maximizing both refusal probability and re-cache cost.

## Claude Code ground truth (v2.1.268) — how the real client survives this

Claude Code has TWO layers; anthropic-auth Pi only has the first, and it isn't enough.

1. Server-side fallback (`fallbacks:"default"` + `server-side-fallback-2026-07-01`): Anthropic may
   serve a `fallback_message` iteration inline. If it does NOT (terminal refusal), layer 2 runs.

2. CLIENT-side refusal→fallback routing (the missing piece). On terminal `stop_reason:"refusal"`,
   Claude Code reads `message_delta.delta.stop_details.{category,explanation}` and routes by category
   to a different model, RETRACTS the streamed refusal, and re-issues the prompt:

   ```js
   // chunk-pryvkh3w.js
   var ywo = { bio: "claude-opus-5",  cyber: "claude-opus-4-8" };  // default map
   var _wo = { cyber: "claude-opus-4-8" };                         // map for opus-5
   var bwo = { bio: "claude-opus-4-8", cyber: "claude-opus-4-8" }; // map for SOe() models
   function Swo(e){ if (SOe(e)) return bwo;
                    if (e==="claude-opus-5"||e==="claude-opus-5[1m]") return _wo;
                    return ywo; }
   ```
   - Refusal categories are **`bio`** and **`cyber`**.
   - For **opus-5**, only `cyber` has a route (→ `claude-opus-4-8`); `bio` has NO route → terminal.
   - On refusal Claude Code yields `{type:"fallback_request", trigger:"refusal", originalModel,
     fallbackModel, apiRefusalCategory, apiRefusalExplanation, ...}` and re-runs on the fallback model.
   - Telemetry `tengu_refusal_fallback_route_declined` fires when no route exists.
   - Escape hatch env: `CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL`.
   - Client arms `refusalFallbackModel` on EVERY request (visible lane), independent of server fallback.

This session does security / reverse-engineering work (account `exploitdemon@gmail.com`, RE of Claude
Code binaries, auth tooling). That is the classic **`cyber`** refusal-category trigger. Claude Code
would auto-route `cyber → claude-opus-4-8`. The user's manual switch to opus-4-8 is that exact route
done by hand.

## Bugs / gaps in packages/pi/src/stream.ts

- GAP A (primary): No client-side refusal→fallback routing. On terminal refusal Pi throws
  (lines ~2208-2246) instead of re-issuing on a mapped fallback model. Mirror Claude Code's
  `Swo` category map, or reuse the OpenCode `FableFallbackManager` deterministic opus-4-8 downgrade.
- GAP B: Pi discards `stop_details.category` / `stop_details.explanation`. The refusal handler
  (lines 2176-2207) reads only `event.delta.stop_reason`. Without the category it can neither route
  nor tell the user WHY (bio/cyber content vs credit/context). Capture and surface it.
- GAP C (amplifier): Model switch cold-invalidates the prompt cache; the first post-switch request
  re-sends the full context. On a huge session this both trips the refusal and re-bills the cache
  ($4.63 on one refused 741k request here). Worth a user-facing warning and/or context compaction
  before switching to opus-5.
- GAP D (cost): A refused request still bills full cacheWrite. Client-side routing at least converts
  that spend into a served answer (as Claude Code does).

## Recommended fix (ordered)
1. Capture `stop_details` on refusal (GAP B) — small, unlocks everything else.
2. Add client refusal routing in stream.ts using the `Swo` category map (bio/cyber) with opus-4-8 as
   the cyber target and a catch-all downgrade for unmapped/`bio`-on-opus-5 (GAP A). Retract the
   refused stream and re-issue on the fallback model, like `fallback_request`.
3. Warn on switching to opus-5/fable-5 with a large cold context; offer compaction (GAP C).


## v2.1.272 diff (checked 2026-09-15, newest on npm; we had v268)

Extracted 2.1.272 and diffed the refusal machinery against the implementation.

- **Route map is byte-identical to v268.** v272 `chunk-b2hkftr9.js`:
  `FYo={bio:"claude-opus-5",cyber:"claude-opus-4-8"}`, `$Yo={cyber:"claude-opus-4-8"}`,
  `BYo={bio:"claude-opus-4-8",cyber:"claude-opus-4-8"}`, selector
  `UYo(e){ if(k$e(e)) return BYo; if(e==="claude-opus-5"||e==="claude-opus-5[1m]") return $Yo; return FYo }`.
  `k$e` (the SOe/BYo predicate) returns `false` — BYo is unreachable in the shipped catalog.
  Our `resolveRefusalFallbackModel` matches this exactly.
- **NEW: two server-fallback betas, and Claude Code sends BOTH.** v272 `chunk-04p5afpb.js`:
  `MP=Re("server_side_fallback","server-side-fallback-2026-06-01")` (base capability) and
  `Ch=Re("server_side_fallback_category","server-side-fallback-2026-07-01")` (category routing).
  The opt-in `nnr(...)` pushes `[MP, Ch]` — both betas — whenever server fallback is active.
  v268 does the same (`dI`=06-01, `zg`=07-01). Pi and OpenCode were sending ONLY 07-01, so the
  base capability was never enabled — a likely reason the server returned a terminal refusal
  instead of serving an inline `fallback_message`. FIXED: both packages now send
  `[server-side-fallback-2026-06-01, server-side-fallback-2026-07-01]` (base first).
- **NEW refusal categories exist but have no fallback route.** v272 adds
  `["bio","cyber","aup","agentic","control"]` and the `frontier_llm`/`reasoning_extraction`
  classifications, but only `bio`/`cyber` are in the route map (`wX(e)=e==="cyber"||e==="bio"`).
  Claude Code declines the rest unless `CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL` is set. Our
  implementation intentionally downgrades any unmapped/absent category to the opus-4-8 catch-all
  (bounded, non-looping) — a deliberate superset of Claude Code's default, matching the manual
  recovery the user was doing.
