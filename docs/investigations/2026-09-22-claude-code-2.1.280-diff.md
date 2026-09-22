# Claude Code 2.1.280 vs 2.1.278 — binary diff for API-compatibility layers

**Date:** 2026-09-22
**Method:** flat-chunk extraction of both bun-compiled binaries, then content-level
(not per-file) diffing. Chunk names are randomized per build.

| | path | `.js` chunks |
|---|---|---|
| v2.1.278 | `/home/cole/SiteResearch/anthropic/v2.1.278/extracted` | 1902 |
| v2.1.280 | `/home/cole/SiteResearch/anthropic/v2.1.280/extracted` | 1976 |

Technique: raw-byte regex scans of every chunk per version, set-differenced by
category (env vars, beta dates, `/v1/` paths, header literals, snake_case API
tokens, statsig gate ids, `retry:` labels). Then each interesting hit was located
by chunk and beautified with `jsbeautify -d <chunk> -o /tmp/v280b/<chunk>`.

Out of scope (covered separately): the `claude-opus-5-5` model catalog entry.

---

## TL;DR for a compat layer

1. **One new beta: `inline-tools-2026-09-15`.** It adds a new content block
   `{type:"tool_addition", tool:{type:"tool_definition", definition:{...}}}`.
2. **One new retry step: `retry:inline-tools-strip`,** inserted *before* the
   existing `retry:tool-change-strip` in the sticky-beta fallback ladder.
3. **Refusal route map gains a `frontier_llm` route — but only for
   `claude-opus-5-5`.** First time any route map has a non-bio/cyber key.
4. **Thinking blocks from a *foreign model* are now kept across ANY model
   change, not just upgrades** (`tengu_rustling_pixel`, default `"all"`).
5. **Three new error classifications**, incl. two for *encrypted server-tool
   content that fails to decrypt* — directly relevant to any proxy that can
   switch accounts/keys mid-conversation.
6. **Zero changes** to: request/response headers, `anthropic-beta` header
   assembly, `/v1/*` paths, OAuth endpoints/flows, `cc_*` billing-header
   segments, stop reasons, SSE event types, rate-limit model, server-side
   fallback beta pair.

---

## 1. Betas

Only one beta added; none removed.

```
NEW BETA: inline-tools-2026-09-15
GONE BETA: (none)
```

Registry is `chunk-zq6v8njb.js` (v280) / `chunk-et71wjpk.js` (v278). Excerpt,
v280 beautified, showing the insertion point (between `mid_conv_tool_change`
and `server_side_fallback`):

```js
var F_ = v19("mid_conv_tool_change",  "mid-conversation-tool-changes-2026-07-01");
var U_ = v19("inline_tools",          "inline-tools-2026-09-15");          // NEW
var sM = v19("server_side_fallback",          "server-side-fallback-2026-06-01");
var vy = v19("server_side_fallback_category", "server-side-fallback-2026-07-01");
var CL = v19("fallback_credit",       "fallback-credit-2026-06-01");
```

The full ordered beta tuple `ty` is otherwise identical to v278's; `U_` is
spliced in at the same position in the frozen array.

**Server-side fallback is unchanged.** `WEt()` in `chunk-1xqpf2j8.js` still
pushes both betas base-first:

```js
for (let M of [sM, vy]) if (M !== null && uA(s, M) && !g && !r.includes(M)) r.push(M);
...
return w ? { fallbacks: "default" } : { fallbacks: [{ model: Xn(e.model) }] };
```

---

## 2. Inline tools (`inline-tools-2026-09-15`)

### 2.1 What it changes on the wire

v278 could only *reference* a late-added tool by name (mid-conversation tool
changes beta). v280 can embed the **full tool definition inside a message
content block**, so a tool never declared in top-level `tools[]` becomes usable
mid-conversation.

`chunk-8knzj4cj.js` (beautified), function `aZr` — the block builder:

```js
function aZr(v41, v44, v45, v46 = [], v42 = {}) {
  let v43 = [
    ...v41 ? [{ type: "text", text: v41 }] : [],
    ...v46.map((v47) => ({
      type: "tool_removal",
      tool: { type: "tool_reference", name: v47 }
    })),
    ...v44.map((v48) => {
      let v47 = QJe(v42, v48);
      return v47 === undefined
        ? { type: "tool_addition", tool: { type: "tool_reference", name: v48 } }
        : { type: "tool_addition", tool: { type: "tool_definition", definition: v47 } }; // NEW
    })
  ];
  if (v45 !== undefined && v43.length > 0) v43.push({ ...v43.pop(), cache_control: v45 });
  return v43;
}
```

So the new wire shape is only reachable through a `tool_addition` block whose
`tool.type` is `"tool_definition"` instead of `"tool_reference"`. `tool_removal`
is unchanged. The `api_system` message object gains a `toolDefinitions` field
client-side (`chunk-1xqpf2j8.js`: `er.type === "api_system" && er.toolDefinitions !== undefined`).

Request-build gate (`chunk-1xqpf2j8.js`, `QRt`):

```js
inlineToolDefinitions:
  v58.byValueNames !== undefined && v58.byValueNames.size > 0
  && v58.betas.includes(U_) && kde(v59) ? v58.byValueNames : undefined,
```

`kde(model)` is the same model-capability predicate used for
`mid_conv_tool_change`, so inline tools are only sent to models that already
support mid-conversation tool changes.

### 2.2 Enablement

`chunk-266evs5w.js` (beautified):

```js
var MA = "tengu_brisk_meadow";
function AMn() {
  if (!dL()) return false;                       // master kill switch, gate tengu_foamy_spring (default true)
  if (v16.CCR_SESSION_PROFILE) return false;     // off for remote/CCR sessions
  if (v16.CLAUDE_CODE_INLINE_TOOLS !== undefined) return v16.CLAUDE_CODE_INLINE_TOOLS;
  return Xf(MA);                                 // statsig gate, default false
}
// dL(): function dL(){let e=Za.reader;if(!e)return!0;try{return e("tengu_foamy_spring",!0)!==!1}catch{return!0}}
// Xf(g): reads gate g with default false
```

New env var: `CLAUDE_CODE_INLINE_TOOLS`. New gate: `tengu_brisk_meadow`.

### 2.3 Server rejection detector + new 400 strings

`chunk-1xqpf2j8.js`, function `yke` — this is the exact set of server messages
a compat layer would have to emit to make Claude Code back off:

```js
function yke(v51) {
  if (!(v51 instanceof Ct)) return;
  let v52 = v51.message;
  if ((v51.status === 400 || v51.status === 422) && /Input tag 'tool_definition'/.test(v52))
      return "unsupported_on_platform";
  if (v51.status !== 400) return;
  if (hy(v52, U_)) return "header_rejected";                       // beta name echoed in msg
  if (v52.includes("are not available on this platform")
      && /tool definitions|tool_addition/.test(v52)) return "unsupported_on_platform";
  if (v52.includes("cannot yet be defined in a message")) return "kind_not_enabled";
  if (v52.includes("is already used by a")
      && /tool\.definition|tool_addition/.test(v52)) return "name_conflict";
  return;
}
```

Compare the pre-existing `vX` (mid-conv tool change) detector, unchanged from
v278, which keys on `Input tag 'tool_(addition|removal)'`.

### 2.4 New retry rung

`chunk-1xqpf2j8.js`, `xce` (the sticky-beta strip ladder). The inline-tools rung
is checked **first**, before the tool-change rung:

```js
let xce = (er) => {
  let Ar = Ee.includes(U_) && !ow(er) && vX(er) !== "header_rejected" ? yke(er) : undefined;
  if (Ar !== undefined) {
    ...
    Ee = Ee.filter((fi) => fi !== U_);
    iZr(ht, Ar);
    v39("tengu_inline_tools_refused_retry", { cause: v36(Ar) });
    return "retry:inline-tools-strip";                             // NEW
  }
  let Nr = Ee.includes(F_) && !ow(er) ? vX(er) : undefined;
  if (Nr !== undefined) {
    ...
    Ee = Ee.filter((fi) => fi !== F_ && fi !== U_);                // tool-change strip also drops U_
    return "retry:tool-change-strip";
  }
  ... "retry:per-turn-timing-strip" / "retry:mid-conv-system" ...
};
```

A `mid-conv-system` rejection now also strips `U_`:
`Ee.filter(sa => sa !== jC && sa !== TL && sa !== F_ && sa !== U_ && sa !== W1)`.

Fallback behaviour on rejection (`chunk-8knzj4cj.js`, `iZr`):

> `[inline-tools] tool_definition rejected (<cause>) — falling back to declaring
> late tools in tools[] and showing them by reference, off for the rest of this
> conversation (carried through a compaction; /clear starts afresh)`

New telemetry keys: `tengu_inline_tools_announced`, `tengu_inline_tools_refused_retry`,
`mcp_inline_tools` (with `rejected_<cause>`).

Full `retry:` label diff (everything else is minifier noise):

```
NEW:  retry:inline-tools-strip
GONE: (none)
```

---

## 3. Refusal → fallback routing

**Changed.** v280 adds a third route map, used only by `claude-opus-5-5`, and it
is the first map with a `frontier_llm` key.

v278 (`grep -ohP 'var cvr=3.{0,420}'`):

```js
var cvr = 3,
    dvr = { bio: "claude-opus-5",   cyber: "claude-opus-4-8" },   // default
    uvr = {                         cyber: "claude-opus-4-8" },   // opus-5
    fvr = { bio: "claude-opus-4-8", cyber: "claude-opus-4-8" };   // unreachable (Hce() => false)
function pvr(e) {
  if (Hce(e)) return fvr;
  if (e === "claude-opus-5" || e === "claude-opus-5[1m]") return uvr;
  return dvr;
}
```

v280 (`chunk-8knzj4cj.js`):

```js
var Oj = 3,
    Pj = { bio: "claude-opus-5",   cyber: "claude-opus-4-8" },                               // default
    Dj = {                         cyber: "claude-opus-4-8" },                               // opus-5
    Mj = { bio: "claude-opus-5",   cyber: "claude-opus-4-8", frontier_llm: "claude-opus-5" },// NEW: opus-5-5
    Ij = { bio: "claude-opus-4-8", cyber: "claude-opus-4-8" };                               // unreachable (Hc() => false)
function Lj(e) {
  if (Hc(e)) return Ij;
  if (e === "claude-opus-5-5" || e === "claude-opus-5-5[1m]") return Mj;   // NEW
  if (e === "claude-opus-5"   || e === "claude-opus-5[1m]")   return Dj;
  return Pj;
}
```

Unchanged: max hop count `3`; `CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL` env
escape hatch; category predicates
`U5t = cyber|bio`, `Cj = frontier_llm|reasoning_extraction`,
`DX = U5t || Cj ? e : "other"`; the whole `stop_details.{category,explanation}`
plumbing; banner/`saw_cyber_refusal` schema.

New exported helpers in the model module (`chunk-g2qb9jpy.js` barrel):
`getRefusalFallbackOpusModel`, `getRefusalFallbackOpusLineupIds`,
`enforcementRefusalFallbackOpusModel`, `preserve1mContextForRefusalFallback`,
`getFableDeclineFallbackModel`.

---

## 4. Thinking: foreign-model thinking blocks are now kept on any model change

This is the highest-impact silent behavioural change for a request-transform layer.

**v278** (`chunk-xb8gq2xw.js`): boolean session field
`keepForeignThinkingOnUpgrade`, gate `tengu_luminous_whistle` (default `true`),
env `CLAUDE_CODE_LUMINOUS_WHISTLE` (boolean). Foreign thinking survived only an
*upgrade*.

**v280** (`chunk-1xqpf2j8.js`): tri-state field `foreignThinkingKeep`, gate
`tengu_rustling_pixel` (**default `"all"`**), env `CLAUDE_CODE_RUSTLING_PIXEL`
(`"all" | "upgrade" | "none"`, anything else warns and falls back to `"upgrade"`):

```js
var fCt = "tengu_rustling_pixel";
function Ddr() {
  if (!Ba()) return "none";
  if (!v34._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL) { if (!mwt()) return "none"; }
  let v51 = v34.CLAUDE_CODE_RUSTLING_PIXEL;
  if (v51 !== undefined) {
    if (v51 !== "all" && v51 !== "upgrade" && v51 !== "none")
      v46(`CLAUDE_CODE_RUSTLING_PIXEL=${v51} is not 'all', 'upgrade' or 'none'; using 'upgrade'`, {level:"warn"});
    return Exe(v51);
  }
  let v52 = Tc()?.[fCt];
  if (typeof v52 === "string") return Exe(v52);
  return Exe(v49(fCt, "all"));            // statsig default "all"
}
function Exe(v51) { return v51 === "all" || v51 === "none" ? v51 : "upgrade"; }
```

Decision functions (`chunk-1xqpf2j8.js`):

```js
function VRe(v51, v52, v53) {              // keep this foreign block?
  switch (v53) {
    case "all":     return typeof v51.message.model === "string";   // keep whenever model is known
    case "upgrade": return Cpo(v51.message.model, v52);             // v278 behaviour
    case "none":    return false;
  }
}
function Nle(v51, v52) {                   // is this assistant msg from a foreign model?
  let v53 = v51.message.model;
  if (typeof v53 !== "string") return true;
  return v53 !== Gl && v53 !== v52
      && Ge(v53, { identity: true }) !== Ge(v52, { identity: true })
      && t0t(v52)?.has(v53) !== true;
}
```

`keepForeignThinking: pCt()` is threaded into the request builder
(`zs` object in `chunk-1xqpf2j8.js`).

**Consequence:** signed `thinking` blocks produced by model A are now routinely
resent to model B. Any layer that rewrites/strips/re-signs thinking blocks, or
that routes different models to different accounts, will see many more
cross-model thinking blocks on the wire than under 2.1.278.

Notably the *existing* client-side heal path is unchanged — on a rejected
thinking block Claude Code still emits `retry:thinking-signature-strip` and
records `tengu_thinking_signature_strip_retry`, now additionally calling
`oz("rejected_fell_back" | "rejected_healed" | "rejected_surfaced")` to disable
foreign-thinking retention for the rest of the session.

Related new telemetry ids: `thinking_mode_changed`, `thinking_display_changed`,
`prevThinkingMode/newThinkingMode`, `prevThinkingDisplay/newThinkingDisplay`.

---

## 5. Error classification

The main classifier (`chunk-1xqpf2j8.js`, near `grammar_compile_error`) gains
exactly **three** new kinds. Normalized diff of the function body, v278 → v280:

```diff
+if (F(V) !== null) return "system_role_misplaced";
 if (F(V)) return "system_role_unsupported";
+if (F(V)) return "web_search_content_rejected";
+if (F(V)) return "code_execution_output_rejected";
 if (V instanceof Ct && V.status === 400 && /`?(thinking|redacted_thinking)`? ... cannot be modified/i ...)
```

Everything else in the classifier is byte-equivalent modulo minified names,
including the canonical `NGt` mapper:

```js
function NGt(v51) {
  if (v51.status === 529 || v51.message?.includes("\"type\":\"overloaded_error\"")) return "overloaded";
  if (v51.status === 429) return "rate_limit";
  if (v51.status === 401 || v51.status === 403) return "authentication_failed";
  if (v51.status !== undefined && v51.status >= 408) return "server_error";
  if (v51.isCloudCredentialError) return "cloud_credential_error";
  return "unknown";
}
```

### 5.1 New 400 message strings for encrypted server-tool content

```js
var cNn = [
  "invalid encrypted_content in search_result block",
  "invalid encrypted_index in text block",
  "failed to decrypt web search result content"
];
var dNn = "invalid encrypted_stdout in encrypted_code_execution_result block";
function Sat(v51) { return v51.toLowerCase().replaceAll("`", ""); }
function uNn(v51) {   // -> "web_search_content_rejected"
  if (!(v51 instanceof Ct) || v51.status !== 400) return false;
  return cNn.some((v53) => Sat(v51.message).includes(v53));
}
function fNn(v51) {   // -> "code_execution_output_rejected"
  return v51 instanceof Ct && v51.status === 400 && Sat(v51.message).includes(dNn);
}
```

**Why this matters to a routing/auth proxy:** `encrypted_content` /
`encrypted_index` / `encrypted_stdout` are server-tool payloads bound to the
issuing credential. Replaying a conversation that contains them against a
*different* OAuth account or API key produces exactly these 400s. v280 only
*labels* them — there is **no automatic strip-and-retry rung** for either. The
turn fails and the label is surfaced. A fallback-account router should strip
`search_result` / `encrypted_code_execution_result` blocks when it migrates a
session across credentials.

New snake tokens confirming the blocks exist client-side:
`encrypted_code_execution_result`, `encrypted_index`, `encrypted_stdout`.

### 5.2 `system_role_misplaced`

Not a new capability, a new *label* for the existing mid-conv-system 400 parse
(`wX`/`Lsr`). The retry telemetry gained `wire_message_count` and
`misplaced_index` fields, and the user-facing warning now names the exact index:

> `[mid-conv-system] API refused where a system message sits (messages[N] of M
> on the wire; conversation entry ... of L) — retrying once without system
> messages; off for this conversation until /clear or /compact`

---

## 6. Request body shape

Top-level keys sent on the main loop are **unchanged**:
`model, messages, system, tools, tool_choice, betas, metadata, max_tokens,
thinking, temperature, context_management, safeguards, output_config, speed,
thread, diagnostics`.

One gate changed — `diagnostics.previous_message_id` (cache-diagnosis beta) is
now also sent when the session has a fork point:

```
v278: ...Yx && Ee && jl && !ys                        ? {diagnostics:{previous_message_id: he ?? null}} : {}
v280: ...dv && (ve || h.forkPointUuid !== void 0) && zy && !hs ? {diagnostics:{previous_message_id: he ?? null}} : {}
```

One helper signature changed — the generic non-main-loop query helper
(`streamSimple`-equivalent) gained an `effort` parameter and now builds
`output_config` as a full object rather than `{format}`:

```
v278: {model, system, messages, tools, tool_choice, output_format, max_tokens=1024, maxRetries=2,
       timeout, signal, skipSystemPromptPrefix, forceAttributionHeader, temperature, thinking,
       stop_sequences, extraBodyParams, extraBetas, onFetchAttempt, credentials}
      ... ...yt && {output_config: {format: y}} ...

v280: {..., temperature, thinking, effort,  <-- NEW
       stop_sequences, extraBodyParams, extraBetas, onFetchAttempt, credentials}
      ... ...Qt && {output_config: Bn} ...
```

---

## 7. Explicit non-changes (verified by full-corpus string diff)

All of the following produced an **empty** new/gone set across all 1902/1976 chunks:

| Category | Regex | Result |
|---|---|---|
| Request/response header literals | `"x-[a-z0-9-]{3,50}"` | no change |
| `anthropic-*` headers | `"anthropic-[a-z0-9-]{3,50}"` | no change |
| Stainless headers | `"x-stainless-[a-z-]+"` | no change |
| Internal latch headers | `x-cc-internal-*` | no change |
| Billing header segments | `cc_[a-z0-9_]+` | no change |
| API paths | `/v1/...` | no change |
| OAuth/API paths | `/api/...` | no change |
| OAuth identifiers | `oauth[A-Za-z_]*` | no change |
| Stop reasons | `end_turn\|max_tokens\|...\|refusal\|model_context_window_exceeded` | no change |
| SSE event names | `message_start\|content_block_delta\|...` | no change |
| Rate-limit / low-priority / overage fields | `lowPriority*`, `overage*` | no change |
| Refusal categories | `"bio"\|"cyber"\|"aup"\|"agentic"\|"control"\|"frontier_llm"\|"reasoning_extraction"` | no change |
| `stop_details`, `fallback_message`, `usage.iterations` | literal | no change |

So the 2.1.233-era wire contract documented for the billing header
(`x-anthropic-billing-header` with ` cch=00000;` first, agent-id headers only on
subagents, `x-stainless-helper-method: stream` gated on `body.stream`) still
holds verbatim in 2.1.280.

---

## 8. Environment variables

```
NEW:
  CLAUDE_CODE_INLINE_TOOLS                  inline-tools beta override (§2.2)
  CLAUDE_CODE_RUSTLING_PIXEL                foreign-thinking retention: all|upgrade|none (§4)
  CLAUDE_CODE_MAX_EFFORT_REMINDER           gate tengu_proud_clover (default false)
  CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH    prompt-injection scan window over MCP tool
                                            descriptions; default 2048 (`t4e = 2048`)
  CLAUDE_CODE_AUTO_MODE_CLASSIFIER_OVERLAP  auto-mode speculative classifier overlap
  CLAUDE_CODE_REMOTE_TOOLS_ASK_SEATS        gate tengu_unified_waterfall (remote tools)
  CLAUDE_CODE_REMOTE_TOOLS_JUMP_QUEUE       gate tengu_valiant_rain (remote tools)
  CLAUDE_CODE_DIR_SYNC_CHAIN                directory sync
  CLAUDE_CODE_HOST_SCHEDULED_RUN            host/scheduled run marker
  CLAUDE_CODE_PLUGIN_DIRS                   plugin discovery

GONE:
  CLAUDE_CODE_LUMINOUS_WHISTLE              superseded by CLAUDE_CODE_RUSTLING_PIXEL
```

(Secondary scan also surfaced `CLAUDE_CODE_SESSION_KIND`, `CLAUDE_CODE_TAGS`,
`CLAUDE_CODE_REPL`, `CLAUDE_CODE_HOST_PLATFORM`, `CLAUDE_CODE_ACTION`,
`CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE`, `CLAUDE_CODE_DISABLE_ATTACHMENTS`,
`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, `CLAUDE_CODE_PLUGIN_DIR_WATCH`,
`CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_GATEWAY_ALLOW_LOOPBACK` — all
host/plugin/session plumbing, no API surface.)

---

## 9. Quota / rate limits

The rate-limit model itself is unchanged (no new `lowPriority*`, `overage*`,
`unifiedRateLimit*` fields; `anthropic-ratelimit-unified-*` header names
untouched). Two new gates cover *remote* (CCR) sessions adopting rate-limit
state pushed over the relay rather than polled — `chunk-t1ewfqcr.js`:

```js
v17("tengu_remote_rate_limits_adopted", {
  via: v13(v37), status: v13(v35.info.status),
  degradation: v13(v35.degradation), frames: v38.length });
v17("tengu_remote_rate_limits_dropped", {
  via: v13(v31), reason: v12("account_switched"), frames: v34 });
```

Adopted frames are merged into the same snapshot shape already used locally
(`unifiedRateLimitFallbackAvailable`, `upgradePaths`, `lowPriorityOffer`,
`lowPriorityRetryAfterSeconds`, `lowPriorityMaxWaitSeconds`). New ids:
`adoptRateLimits`, `seedRateLimitInfos`, `rateLimitInfos`,
`remote_rate_limit_frame_drop`, `usage_limit_wait_heartbeat` (a periodic
`setInterval` heartbeat while the CLI is blocked waiting for a usage window,
`chunk-afv7trc2.js`).

`tengu_unified_waterfall` is **not** rate-limit related despite the name — it
gates remote-tool "ask seats" (`chunk-8knzj4cj.js`, `mir()`).

---

## 10. OAuth / device

No change to OAuth endpoints, flows, token handling, or any `oauth*` identifier.
The only addition is a UI affordance: `DeviceReenrollDialog`
(`chunk-m9w3nv38.js`, title *"This computer was removed from your devices"*)
with telemetry `tengu_device_reenroll`, `tengu_device_reenroll_prompt`,
`tengu_device_reenroll_prompt_shown`.

---

## 11. Other notable additions (lower priority)

- **New pricing tier** `tier_4_20_cache_read_0_20` (`chunk-kx6bqsxn.js`):
  `input 4, output 20, cache_write_5m 5, cache_write_1h 8, cache_read 0.20,
  web_search 0.01`. Used by `claude-opus-5-5`.
- **Auto-mode speculative classifier.** New telemetry fields `speculative`,
  `speculative_used`, `speculative_discard_reason`, `speculative_lead_ms`,
  `speculative_ready_ms` (`chunk-21mc3nx7.js`), gate
  `tengu_violin_speculative_classifier`, env
  `CLAUDE_CODE_AUTO_MODE_CLASSIFIER_OVERLAP`. This issues **extra billed model
  calls speculatively, ahead of the tool call** — relevant to quota accounting,
  not to request shape.
- **New auto-mode classifier failure codes**: `server_call_unavailable_error`,
  `server_call_unavailable_other`, `server_call_unavailable_refused`,
  `server_call_unavailable_input_too_long`, `server_unavailable_other`.
  Only the first group is treated as permanent ("Don't retry it"); the
  `_error`/`_timeout`/`_other` group is transient.
- `tengu_ccr_classifier_keepalive_enabled`, `tengu_ccr_replay_acks_at_request_dispatch` —
  remote (CCR) transport only.
- `tengu_normalizer_retained_output_check_failed` (`chunk-16xb27k4.js`) — local
  transcript normalizer self-check, not wire-visible.

---

## Appendix: reproduction

```python
V278 = "/home/cole/SiteResearch/anthropic/v2.1.278/extracted"
V280 = "/home/cole/SiteResearch/anthropic/v2.1.280/extracted"

def raw_scan(d, pat):
    p = re.compile(pat); idx = collections.defaultdict(set)
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(('.js', '.mjs')): continue
        for m in p.finditer(open(os.path.join(d, fn), 'rb').read()):
            idx[m.group(0).decode('utf-8', 'ignore')].add(fn)
    return idx

def diff_raw(pat):
    a, b = raw_scan(V278, pat), raw_scan(V280, pat)
    return set(b) - set(a), set(a) - set(b)
```

Key patterns used:

```
env      rb'\b(?:CLAUDE_CODE_|ANTHROPIC_|CLAUDE_|DISABLE_)[A-Z0-9_]{2,60}\b'
beta     rb'\b[a-z0-9]+(?:-[a-z0-9]+)*-20\d\d-\d\d-\d\d\b'
paths    rb'/v1/[A-Za-z0-9_\-/{}:.]{1,60}'
headers  rb'"x-[a-z0-9\-]{3,50}"'
snake    rb'\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,6}\b'      # 473 new / 31 gone
retry    rb'\bretry:[a-z\-]+\b'
```

Note: a naive quote-delimited string extractor mis-aligns on minified JS
(apostrophes inside double-quoted prose, regex literals containing quotes) and
produced ~34 false "new betas" on the first pass. The raw-byte pattern scans
above are quote-agnostic and were used for every claim in this report.
