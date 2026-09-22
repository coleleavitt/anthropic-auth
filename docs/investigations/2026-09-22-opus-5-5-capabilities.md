# Claude Code 2.1.280 — `claude-opus-5-5` capability wire analysis

Date: 2026-09-22
Binary: Claude Code **2.1.280** (`VERSION: "2.1.280"`, `BUILD_TIME: "2026-09-21T20:40:17Z"`, `GIT_SHA: 80abbfe7d7232280011ff01a21ae3338f4c6e372` — chunk-1xqpf2j8.js)
Extract: `/home/cole/SiteResearch/anthropic/v2.1.280/extracted` (compare: `/home/cole/SiteResearch/anthropic/v2.1.278/extracted`)
Method: `jsbeautify -d <chunk> -o /tmp/v280/<chunk>` (deobfuscating beautifier). All line numbers below are **lines in the beautified file**, byte offsets are offsets into the beautified text.

> Variable names are the deobfuscator's stable renames (`v##`) plus the bundle's own minified identifiers. Where a name is a minified identifier (e.g. `Lm`, `rnt`, `SCt`) it is byte-identical to the shipped bundle.

---

## Contents

0. [Catalog entry and v278 diff](#0-catalog-entry-and-v278-diff)
1. [Request body: what an Opus 5.5 request looks like](#1-request-body-what-an-opus-55-main-loop-request-actually-looks-like)
2. [`rejects_disabled_thinking` / `adaptive_thinking` / `thinking_disabled_effort_cap`](#2-rejects_disabled_thinking--thinking-is-omitted-never-typedisabled)
3. [`effort`, `per_turn_effort`, `per_turn_timing`](#3-effort--per_turn_effort--per_turn_timing)
   3a. `mid_conv_system` / `mid_conv_tool_change` · 3b. `context_management` · 3c. `lean_prompt`
4. [Prompt bundles](#4-prompt-bundles--opus_5_5_prompt_bundle-vs-opus_5_prompt_bundle-vs-fable_5_1_prompt_bundle)
5. [`refusal_fallback` and `fast_mode`](#5-refusal_fallback-and-fast_mode)
6. [Answers to the five questions, condensed](#6-answers-condensed)

---

## 0. Catalog entry and v278 diff

Baked catalog: **chunk-kx6bqsxn.js** (beautified 38 041 bytes). Entry at line **698** (offset 17411):

```js
{
    id: "claude-opus-5-5",
    family: "opus",
    display_name: "Opus 5.5",
    knowledge_cutoff: "June 2026",
    provider_ids: { first_party: "claude-opus-5-5", bedrock: "us.anthropic.claude-opus-5-5",
                    vertex: "claude-opus-5-5", foundry: "claude-opus-5-5",
                    anthropic_aws: "claude-opus-5-5", anthropic_google_cloud: "claude-opus-5-5",
                    mantle: "anthropic.claude-opus-5-5", gateway: "claude-opus-5-5" },
    eager_input_streaming: { bedrock: true, vertex: true },
    vertex_region_env_var: "VERTEX_REGION_CLAUDE_5_5_OPUS",
    fallback_3p: "claude-opus-5",
    context: { window: 1e6, native_1m: true, supports_1m_beta: true, supports_1m_suffix: true },
    max_output_tokens: { default: 128e3, upper: 128e3 },
    pricing: "tier_4_20_cache_read_0_20",
    capabilities: [ "effort", "max_effort", "xhigh_effort", "adaptive_thinking",
                    "rejects_disabled_thinking", "mid_conv_system", "mid_conv_tool_change",
                    "per_turn_effort", "per_turn_timing", "context_management",
                    "fast_mode", "lean_prompt", "refusal_fallback", "opus_5_5_prompt_bundle" ],
    default_effort: "medium",
    image_limits: { maxWidth: 2e3, maxHeight: 2e3 },
    advisor_rank: 4
}
```

Pricing tier (same chunk, `pricing_tiers`): `tier_4_20_cache_read_0_20 = { input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: .2, web_search: .01 }`.
Opus 5 stays `tier_5_25` (`5/25`, cache_read `.5`). **Opus 5.5 is ~20 % cheaper per input/output token and 2.5x cheaper on cache reads than Opus 5.**

### Machine diff of the whole baked catalog, v2.1.278 (chunk-nx23dqm4.js) → v2.1.280 (chunk-kx6bqsxn.js)

* **`claude-opus-5-5` is the only new model entry.**
* `claude-fable-5.fallback_3p`: `"claude-opus-5"` → **`"claude-opus-5-5"`**.
* No other entry changed (capabilities, pricing, default_effort, max_output all identical).
* Aliases (line 957): `opus.default = "claude-opus-5-5"`, `per_provider.bedrock/vertex/mantle/anthropic_aws = "claude-opus-5-5"`, but `foundry: "claude-opus-4-6"`, `gateway: "claude-opus-4-7"`. `latest_per_family.opus = "claude-opus-5-5"`. `best: "fable"` (unchanged).
* Opus preference order `_xt = ["opus55","opus5","opus48","opus47","opus46","opus45"]` (chunk-kx6bqsxn.js), and `CATALOG_ID_TO_KEY` gains `"claude-opus-5-5": "opus55"`.

### Capability delta vs Opus 5

| capability | opus-5 | opus-5-5 |
|---|---|---|
| effort / max_effort / xhigh_effort / adaptive_thinking | yes | yes |
| `rejects_disabled_thinking` | **no** | **yes** |
| `thinking_disabled_effort_cap` | **yes** | **no** (moot — see §2) |
| `per_turn_effort`, `per_turn_timing` | **no** | **yes** |
| `opus_5_prompt_bundle` | yes | — |
| `opus_5_5_prompt_bundle` | — | **yes** |
| `effort_cost_index` | `{low .67, med .76, high 1, xhigh 1.6, max 1.7}` | **absent** |
| `default_effort` | `high` | **`medium`** |
| `max_output_tokens` | 64k default / 128k upper | **128k / 128k** |

### Gating: is opus-5-5 hidden?

* **No `min_cli_version`** on the entry (the schema supports it — `min_cli_version: v25().optional()`, chunk-kx6bqsxn.js line ~1090 — but opus-5-5 does not set it), no `picker` section, no `deprecation`.
* Model-picker entries (`chunk-8knzj4cj.js`: `Tv()`, `_v()`, `Og()`, `kv()`, `uj()`) are gated only by `jn("opus55")`, which is pure provider availability:
  ```js
  function jn(v41){ let v42 = Ao[v41]; if (v42[Oe()] !== null) return true;
                    return Boolean(Ke().modelOverrides?.[v42.firstParty]); }
  ```
  opus-5-5 has a non-null id for every provider, so the picker always offers it (label `"Opus"`, description `` `Opus 5.5 · ${bs}` ``, `descriptionForModel: "Opus 5.5 - best for everyday, complex tasks"`).
* Capability resolution itself (`Lm`, chunk-kx6bqsxn.js line 1192) is:
  ```js
  // Lm(canonicalModel, capability, model)
  function Lm(v32, v34, v33) { return oen(v34, v32) ?? yxt(v32, v34, v33); }        // env override wins first
  function yxt(v32, v34, v33) {                                                     // (canonical, capability, model)
      if (xF().servedCapabilityLookup?.(v34, [v33, v22(v32)]) === true && v2(v34)) return true;   // server-served
      return lwr(v32, v34) ? true : undefined;                                      // baked catalog
  }
  function lwr(v32, v33) { return pc(v22(v32))?.capabilities.includes(v33); }       // (model, capability)
  var v14 = { per_turn_effort: "tengu_per_turn_effort" };                           // line 1183
  function v2(v32) { let v33 = v14[v32]; if (v33 === undefined) return true;
                     return xF().featureGateLookup?.(v33) === true; }
  ```
  The statsig gate `tengu_per_turn_effort` applies **only** to the *server-served* capability path; the **baked** catalog path (`lwr`) is not gated. Env escape hatch: `CLAUDE_CODE_MODEL_CAPABILITIES="claude-opus-5-5=-per_turn_effort,lean_prompt;..."` (`oen`, supports `model*` prefix wildcards and `-cap` negation).

---

## 1. Request body: what an Opus 5.5 main-loop request actually looks like

Body construction: **chunk-1xqpf2j8.js line 83192–83240** (offset ~2 715 500). Verbatim:

```js
let Au = {
    model: jH(v56.model),
    messages: ...,
    system: Ju.system,
    ...Ju.tools !== undefined && { tools: Ju.tools },
    tool_choice: Xh,
    ...pl && { betas: WC(Kl) },
    metadata: tA({ agentContext: v56.agentContext }),
    max_tokens: Iv,
    thinking: yc,
    ...Ys !== undefined && { temperature: Ys },
    ...f_ && zy && Nr.includes(sGe) && { context_management: f_ },
    ...Iae && sa !== undefined && { safeguards: [{ type: Ywe, classifier_context: sa }] },
    ...!hs && pC ? pC : {},
    ...!hs && Lv ? Lv : {},
    ...vl,                                   // server-side refusal fallback: { fallbacks: ... }
    ...Mi,                                   // bedrock extra body params
    ...Object.keys(fi).length > 0 && { output_config: fi },
    ...m_ !== undefined && { speed: m_ },    // fast mode
    ..._s !== null && { thread: _s.thread },
    ...dv && (...) ? { diagnostics: { previous_message_id: he ?? null } } : {}
};
```

For Opus 5.5 on a first-party OAuth session the concrete shape is:

```jsonc
{
  "model": "claude-opus-5-5",
  "max_tokens": 128000,
  // NO "thinking" key at all when the user disabled thinking (see §2)
  "thinking": { "type": "adaptive", "display": "summarized" },   // default case
  "output_config": { "effort": "medium" },                        // §3
  "context_management": { "edits": [ { "type": "clear_thinking_20251015", "keep": "all" } ] },
  "speed": "fast",                                                // only in fast mode, §5
  "betas": [ "...", "effort-2025-11-24", "context-management-2025-06-27",
             "mid-conversation-system-2026-04-07", "per-turn-control-2026-07-01",
             "server-side-fallback-2026-06-01", "server-side-fallback-2026-07-01" ],
  "messages": [
     { "role": "system", "content": [], "output_config": { "effort": "high",
                                                           "timing": { "type": "now", "now": "2026-09-22T13:04:07-07:00" } } },
     { "role": "user", "content": [ ... ] }
  ]
}
```

`oAt()` (chunk-1xqpf2j8.js, `[API REQUEST DETAIL]` verbose log) confirms the four fields Claude Code itself considers the model-shape fields: `model, thinking, output_config, temperature, betas/anthropic_beta`.

---

## 2. `rejects_disabled_thinking` — thinking is **omitted**, never `{"type":"disabled"}`

Predicate **chunk-266evs5w.js line 8988** (`rnt`):

```js
function rnt(v32) {
    let v33 = Ge(v32);
    if (v33.includes("claude-3-") || v33 === "claude-opus-4-0" || ... || v33 === "claude-opus-5"
        || v33 === "claude-sonnet-5" || v33 === "claude-haiku-4-5") return false;
    let v34 = Lm(v33, "rejects_disabled_thinking", v32);
    if (v34 !== undefined) return v34;
    return pM(ic(v32));                 // unknown models on 1P-ish providers default to true
}
```
`claude-opus-5-5` is **not** in the hard-coded exclusion list, and the catalog says `true` → `rnt("claude-opus-5-5") === true`.

Main-loop thinking field, **chunk-1xqpf2j8.js line 83053** (offset 2 709 565):

```js
let Sb = Me(process.env.CLAUDE_CODE_DISABLE_THINKING);
let Kg = v59.type !== "disabled" && !Sb;             // thinking requested
let cc = Kg && Fg() && tQt(var_14);                  // interleaved thinking
let Vg = !cc ? undefined : (v59.display === "highlights" && AIr() ? "omitted" : v59.display);
let yc = undefined;
if (Kg && Jyr(var_14)) {
    if (CMn({ runtimeOverride: Vrn(v56.model), resolvedModel: var_14, canonicalModel: xe }) === "adaptive")
        yc = { type: "adaptive", display: Vg };
    else {
        let gf = plo(var_14);
        if (v59.type === "enabled" && v59.budgetTokens !== undefined) gf = v59.budgetTokens;
        gf = Math.max(1024, Math.min(Iv - 1, gf));
        yc = { budget_tokens: gf, type: "enabled", display: Vg };
    }
} else if (v59.type === "disabled" && Oe() === "firstParty" && !Sb && Jyr(var_14) && !rnt(var_14))
    yc = { type: "disabled" };
```

So with thinking **off** and `rnt === true`, `yc` stays `undefined` and `thinking: yc` serialises the key away (JSON.stringify drops `undefined`). **Claude Code never sends `thinking:{"type":"disabled"}` to Opus 5.5** — the model would 400. The client then treats "no thinking field" as "thinking is on":

```js
// line 83116
let Yh = yc?.type === "enabled" || yc?.type === "adaptive" || (yc === undefined && rnt(var_14));
let Xh = v56.toolChoice;
if (Xh?.type === "tool" && Yh) {            // forced single-tool choice is incompatible with thinking
    v46(`tool_choice {type:'tool', name:'${Xh.name}'} demoted to auto: extended thinking is active`);
    Xh = { type: "auto" };
}
```

Side/mechanical queries use the same rule with a token pad — **chunk-266evs5w.js line 8995**:
```js
function aoe(v32){ if (rnt(v32)) return [undefined, 2048]; return [false, 0]; }
```
i.e. `[thinkingParam, extraMaxTokens]`: for Opus 5.5 the `thinking` argument is `undefined` (omitted) and `max_tokens` is raised by **2048** to pay for the thinking the model will emit anyway (`let [ve,Ee] = aoe(he); let xe = Math.min((v57 ?? t6n) + Ee, var_14);`, chunk-1xqpf2j8.js `$.model.complete` hook path).

### `adaptive_thinking` and `budget_tokens`

```js
// chunk-266evs5w.js line 9002
function CMn({ runtimeOverride: v32, resolvedModel: v33, canonicalModel: v34 }) {
    if (v32 !== undefined) return v32;
    let v35 = v16.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING && (v34.includes("opus-4-6") || v34.includes("sonnet-4-6"));
    return vCt(v33) && !v35 ? "adaptive" : "enabled";
}
// line 9007
function vCt(v32) {
    let v33 = vde(v32, "adaptive_thinking"); if (v33 !== undefined) return v33;
    let v34 = Ge(v32);
    if (v34.includes("claude-3-") || v34 === "claude-opus-4-0" || ... || v34 === "claude-haiku-4-5") return false;
    let v35 = Lm(v34, "adaptive_thinking", v32); if (v35 !== undefined) return v35;
    if (v34 === "claude-mythos-5") return true;
    return pM(ic(v32));
}
```
`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` is still hard-gated to `opus-4-6`/`sonnet-4-6` only, so **there is no supported way to send a manual `budget_tokens` to Opus 5.5**; the `{budget_tokens, type:"enabled"}` branch is unreachable for it (only reachable by forcing `CLAUDE_CODE_MODEL_CAPABILITIES=claude-opus-5-5=-adaptive_thinking`).

### `thinking_disabled_effort_cap` — present on Opus 5, **absent** on Opus 5.5

```js
// chunk-7ecsxd13.js line 139
function zPn(v29) { let v30 = Ge(v29);
    return Lm(v30, "thinking_disabled_effort_cap", v29) ?? v30 === "claude-opus-5"; }
```
Consumer, **chunk-1xqpf2j8.js line 83122**:
```js
let d_ = v59.type === "disabled" && v59.mechanical === true;
if (yc?.type === "disabled" && (d_ || zPn(var_14)) && typeof fi.effort === "string" && WPn(fi.effort)) {
    v46(`output_config.effort '${fi.effort}' clamped to '${b2e}': thinking is ${d_ ? "mechanically " : ""}disabled for this request, and this model rejects higher effort when thinking is disabled`);
    ...
    fi.effort = b2e;            // b2e = "high"
}
```
(`WPn(level)` = level ranks above `"high"`, i.e. `xhigh`/`max`.) For Opus 5.5 the capability is absent **and** `yc?.type === "disabled"` can never happen (§2), so the clamp is dead code for it — the cap moved from "clamp effort when thinking is off" (Opus 5) to "you may not turn thinking off at all" (Opus 5.5).

---

## 3. `effort` / `per_turn_effort` / `per_turn_timing`

### Top-level `output_config.effort`

Writer, **chunk-1xqpf2j8.js line 81377**:
```js
function gTe(v51, v53, v54, v55, v52) {         // (effort, output_config, extraBody, betas, model)
    if (!L_(v52)) { delete v53.effort; return; }
    if ("effort" in v53) return;
    if (v51 === undefined) v55.push(h0e);                                   // beta only
    else if (typeof v51 === "string") { v53.effort = v51; v55.push(h0e); }  // field + beta
}
```
`h0e = v19("effort", "effort-2025-11-24")` (chunk-zq6v8njb.js line ~5205). Call site: `gTe(lo, fi, Mi, Nr, var_14)` then `...Object.keys(fi).length > 0 && { output_config: fi }`.

Default level resolution ends at the catalog (**chunk-7ecsxd13.js line 582**):
```js
function Ee(v29) { return pc(Ge(v29))?.default_effort ?? "high"; }
```
chain `v12 = OPe(model) ?? ce(model) /*tengu_witty_wand*/ ?? me(model) /*served*/ ?? Ee(model)`.
**Opus 5.5 therefore sends `output_config: { effort: "medium" }` by default**, where Opus 5 sends `"high"`. `low|medium|high|xhigh|max` all remain legal (`effort`, `max_effort`, `xhigh_effort` are all present on the entry, and `L_`/`K$`/`y6` resolve to true through the catalog path).

### Per-turn control — new wire shape

Two betas (**chunk-zq6v8njb.js line 5213**):
```js
var TL     = v19("per_message_effort", "per-turn-control-2026-07-01");
var var_10 = v19("per_turn_timing",    "timing-2026-09-09");      // imported as _F / var_3 / var_7
```
Attached in the **per-model** beta table `Tw` (**chunk-266evs5w.js line 9233**):
```js
var Tw = [
  { beta: TL,     when: (v32) => v32.perTurnTiming || SCt(v32.model, v32.canonical) },
  { beta: var_3,  when: (v32) => v32.perTurnTiming },
  { beta: F_,     when: (v32) => Z7t() && kde(v32.model) },
  { beta: U_,     when: (v32) => Z7t() && kde(v32.model) && AMn() },
];
```
Gates (**chunk-266evs5w.js lines 4673 / 4679**):
```js
function SCt(v32, v33) {                                  // per_turn_effort
    if (!Fg() || !pM(ic(v32))) return false;              // first-party betas + 1P-ish provider
    if (Lm(v33, "per_turn_effort", v32) === false) return false;
    if (yxt(v33, "per_turn_effort", v32) !== true && ip?.(v33, v32) !== true) return false;
    return el?.() !== true;                               // sticky "server rejected it" latch
}
function TMn(v32, v33) {                                  // per_turn_timing
    if (!Mn.CLAUDE_CODE_PER_TURN_TIMING || !Fg() || !pM(ic(v32))) return false;
    let v34 = lwr(v33, "per_turn_timing");
    return v34 === undefined ? SCt(v32, v33) : v34 && el?.() !== true;
}
```
Note `yxt` here is the *gated* path, so per-turn **effort** additionally needs statsig `tengu_per_turn_effort` **or** the registered client-data resolver `ip` (`Qlo(v20)` in chunk-qxp553c4.js line 63: `mq("per_turn_effort", model, ctx)` for the current main-loop model). Per-turn **timing** additionally needs env **`CLAUDE_CODE_PER_TURN_TIMING`** to be set.

Wire carrier: an `api_system` message. **chunk-1xqpf2j8.js line 78899** builds it:
```js
function cCt(v51, v54) {                 // interleave per-turn output_config before each user turn
    let { levels: v55, times: v56 } = Odr(v51, v54);
    ...
    v57 = v61 === undefined && v60 === undefined ? undefined : {
        ...v61 !== undefined && { effort: v61 },
        ...v60 !== undefined && { timing: { type: "now", now: v60 } }
    };
    ...
    if (v58.type === "api_system") v52.push({ ...v58, outputConfig: v57 });
    else v52.push(lCt(v57));             // lCt = empty role:"system" message carrying outputConfig
}
```
and **line 86099** serialises it:
```js
if (De.type === "api_system") {
    ...
    return { role: "system",
             content: ...,
             ...De.outputConfig && { output_config: De.outputConfig } };
}
```
The timestamp is local-with-offset (**line 78981**):
```js
function uCt(v51){ ... return `${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}${±}${oh}:${om}`; }
// line 82462
let Xr = Ee.includes(var_7) ? uCt(new Date()) : undefined;       // perTurnNow
let Or = typeof lo === "string" && !(v59.type === "disabled" && v59.mechanical === true) ? ss : undefined; // perTurnEffort
```

**Exact per-turn JSON:**
```jsonc
{ "role": "system",
  "content": [],                                   // or [{type:"text",text:"...", ...}] when a reminder rides along
  "output_config": { "effort": "xhigh",
                     "timing": { "type": "now", "now": "2026-09-22T13:04:07-07:00" } } }
```
A single-block variant also exists where the config rides on the text block itself (`Uar`, chunk-1xqpf2j8.js):
`[{ "type": "text", "text": "<content>", "output_config": {...} }]`.

Error handling proves the field names: `kke(err)` matches HTTP 400 messages containing **`output_config.timing`**; `ZD(err)` matches `output_config` + `effort` + `extra inputs are not permitted`, and on such a 400 the client strips beta `TL`, logs `"[per-turn-control] server rejected the per-turn statements — resending without them, sticky-rejecting the beta until /clear or /compact"` and fires `tengu_mid_conv_system_fallback_retry { per_turn_effort: true }`.

---

## 3a. `mid_conv_system` and `mid_conv_tool_change`

```js
// chunk-266evs5w.js line 9105
function kw(v32) {                                   // mid-conversation system messages
    if (kp("hipaa")) return false;
    if (v16.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM) return true;
    let v33 = vde(v32, "mid_conversation_system"); if (v33 !== undefined) return v33;
    let v34 = Ge(v32);
    if (or(v34, "claude-opus-4-8")) return false;     // Ug order list; opus-5-5 not in it -> false
    let v35 = Lm(v34, "mid_conv_system", v32); if (v35 !== undefined) return v35;   // true from catalog
    if (v34 === "claude-mythos-5") return true;
    return pM(ic(v32));
}
// line 9096
function kde(v32) {                                  // mid-conversation tool changes
    if (!Fg() || !Ede(v32)) return false;             // requires mid_conv_system first
    if (v16.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM) return true;
    let v33 = Ge(v32);
    if (CIr(v33)) return false;                       // sticky per-model "server rejected tool changes" latch
    let v34 = Lm(v33, "mid_conv_tool_change", v32); if (v34 !== undefined) return v34;
    return v33 === "claude-mythos-5" || pc(Tx(v33)) === undefined;
}
```
`mid_conv_system` pushes beta `jC = mid-conversation-system-2026-04-07` (list `Cw`, chunk-266evs5w.js line 9180) and is what makes `{"role":"system", ...}` messages legal **inside** `messages[]` — the same carrier the per-turn `output_config` rides on, plus mid-conversation reminders with `"clear_at": "next_user_message"` (beta `W1 = mid-conversation-system-clear-at-2026-08-21`, emitted by `sRt()` at chunk-1xqpf2j8.js line ~78960).
`mid_conv_tool_change` pushes `F_ = mid-conversation-tool-changes-2026-07-01` (and `U_ = inline-tools-2026-09-15` when `AMn()`, i.e. statsig/`CLAUDE_CODE_INLINE_TOOLS`), which lets that system message carry `toolAdditions` / `toolRemovals` / `toolDefinitions` so late-loading MCP servers can be announced without restarting the conversation (`aZr(...)` builder, chunk-1xqpf2j8.js line 86099 ff.). On a 400 the client strips `jC, TL, F_, U_, W1` together and retries once, then latches off for the conversation (`"[mid-conv-system] server rejected role:\"system\" ..."`).

## 3b. `context_management`

```js
// chunk-266evs5w.js line 9063
function vw(v32) {
    let v33 = Ge(v32); let v34 = Lm(v33, "context_management", v32);
    if (v34 === false) return false;
    let v35 = ic(v32); if (v35 === "foundry") return true;
    if (pM(v35)) return !v33.includes("claude-3-");
    return v34 || v33 === "claude-mythos-5";
}
```
Pushes `sGe = context-management-2025-06-27`, and the body gains (`sit()`, chunk-1xqpf2j8.js line 42774):
```js
function sit(v51){ let { hasThinking: v52 = false } = v51 ?? {};
    if (v52) return { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    return; }
```
→ `"context_management": { "edits": [ { "type": "clear_thinking_20251015", "keep": "all" } ] }`, emitted only when thinking is active. For Opus 5.5 thinking is effectively always active (§2), so this key is essentially always present.

## 3c. `lean_prompt`

```js
// chunk-qxp553c4.js line 249
function te(v41) {                                   // "use the BIG system prompt"
    let v42 = Ge(v41);
    let v43 = Lm(v42, "lean_prompt", v41);
    if (v43 !== undefined) return !v43;              // capability true  -> te() === false
    if (Iue(v41) || v42 === "claude-mythos-5") return false;
    if (v42.includes("claude-3-") || v42.includes("haiku") || v42.includes("sonnet")
        || v42 === "claude-opus-4-0" || v42 === "claude-opus-4-1" || v42 === "claude-opus-4-5"
        || v42 === "claude-opus-4-6" || v42 === "claude-opus-4-7") return true;
    return !al();
}
function v11(v41) {                                  // simple/lean system prompt?
    if (!v41) return false;
    if (Me(v24.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) return true;
    if (ko(v24.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) return false;
    if (!te(v41)) return true;                       // <- lean_prompt models land here
    if (v39("tengu_velvet_tide", false)) return true;
    return v1("simple_system_prompt", Ge(v41));
}
```
`lean_prompt` is therefore a **hard opt-in to the short system prompt** (`leanPrompt` memo → `ZS({model, leanPrompt})`), which also swaps tool descriptions to their terse forms, e.g. `kfr()` returns the one-line Glob description
`"Fast file pattern matching. Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\". Returns matching file paths sorted by modification time."`
instead of the 4-bullet long form. Opus 5, Fable 5, Fable 5.1, Sonnet 5 and Opus 5.5 all carry it.


---

## 4. Prompt bundles — `opus_5_5_prompt_bundle` vs `opus_5_prompt_bundle` vs `fable_5_1_prompt_bundle`

*(analysis by worker `prompt-bundles`; full fragment also at `/tmp/v280/part-prompt-bundles.md`)*

### 4.1 The three bundle predicates

`chunk-qxp553c4.js:33-50` (bytes 0x0AE1-0x0C7A):

```js
var v31 = "tengu_fennel_godwit";
function lXt(v41) {                                   // isOpus5Bundle
    if (v41 === undefined) return false;
    if (Lm(Ge(v41), "opus_5_prompt_bundle", v41) !== true) return false;
    return !v39(v31, false);                          // growthbook kill-switch
}
function v27(v41) {                                   // isOpus55Bundle  (line 39, byte 0xB29)
    return !cqe() && Lm(v41, "opus_5_5_prompt_bundle") === true;
}
var v5  = new Set(["turn_updates","bash_output_audience_note","silent_turn_reminder","thinking_display_updates"]);  // line 42
var v6  = new Set(["bison_cairn","larch_cistern"]);                                                                // line 48
var v19 = new Set(["silent_turn_reminder","quizzical_shore"]);                                                     // line 49
```

`Hue` (isFable51Bundle), `chunk-7ecsxd13.js:57`:
```js
function Hue(v29) { return !cqe() && Lm(v29, "fable_5_1_prompt_bundle") === true; }
```

### 4.2 Sub-capability resolver `mq` — `chunk-qxp553c4.js:51` (byte 0xC7A), exported

```js
function mq(v44, v48, v49, v46) {        // mq(capability, canonicalModel, model, envOverride)
    if (v46 !== undefined) return v46;                       // env override wins
    let v50 = Lm(v48, v44, v49);
    if (v50 === false) return false;                         // explicit denial wins
    if (v50 === true
        || v5.has(v44)  && Hue(v48)                          // fable 5.1 bundle
        || v6.has(v44)  && lXt(v49)                          // opus 5 bundle
        || v19.has(v44) && v27(v48)) return true;            // opus 5.5 bundle  <-- NEW
    let v45 = QDn(v49);                                      // client-data capabilities
    if (v45?.data?.[v44] !== true) return false;
    ... telemetry "tengu_model_capability_from_client_data" ...
    return true;
}
```

**Implication matrix (what each bundle turns on for free):**

| capability | fable 5.1 (`Hue`) | opus 5 (`lXt`) | **opus 5.5 (`v27`)** |
|---|---|---|---|
| `turn_updates` | yes | no | **no** |
| `bash_output_audience_note` | yes | no | **no** |
| `silent_turn_reminder` | yes | no | **yes** |
| `thinking_display_updates` | yes | no | **no** |
| `bison_cairn` | no | yes | **no** |
| `larch_cistern` | no | yes | **no** |
| `quizzical_shore` | no | no | **yes** |

So the opus-5.5 bundle is the **narrowest** of the three: two sub-capabilities only.
Separately, `v27` is consulted directly (not via `mq`) in two more places — `thrifty_sonic`
and `cozy_teapot`, §4 below.

---

### 4.3 Every consumer of the bundle predicates and implied capability names

Exhaustive `mq(` call sites in the whole bundle (rg over all beautified chunks):

| call site | capability | env override | effect |
|---|---|---|---|
| `chunk-qxp553c4.js:80` | `per_turn_effort` | – | per-turn effort gating (not bundle-implied) |
| `chunk-qxp553c4.js:151` (`v0`) | `lucky_cerf` | – | delegation-costs-first Task description |
| `chunk-qxp553c4.js:204` (`aso`) | `amber_astrolabe` | `CLAUDE_CODE_AMBER_ASTROLABE` | autonomy system-prompt section |
| `chunk-qxp553c4.js:207` (`lso`) | `bison_cairn` | `CLAUDE_CODE_BISON_CAIRN` | `# Delivering work` section |
| `chunk-qxp553c4.js:210` (`cso`) | `larch_cistern` | `CLAUDE_CODE_LARCH_CISTERN` | `# Corrections` section |
| `chunk-z1yd38dd.js:1364` (`sgn`) | `quizzical_shore` | – | `narration_hint: "hidden"` in stream-json |
| `chunk-1xqpf2j8.js:58784` (`dmt`) | `bash_output_audience_note` | `CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE` | post-Bash attachment |
| `chunk-1xqpf2j8.js:59361` (`K2n`) | `turn_updates` | `CLAUDE_CODE_TURN_UPDATES` | replaces the whole communication section |
| `chunk-1xqpf2j8.js:124024` (`TUt`) | `silent_turn_reminder` | `CLAUDE_CODE_SILENT_TURN_REMINDER` | idle-turn `<system-reminder>` |

Direct (non-`mq`) uses of the predicates:

| call site | predicate | effect |
|---|---|---|
| `chunk-qxp553c4.js:167-174` (`v10`) | `Hue`, **`v27`** | `thrifty_sonic` → `"forced"` (bash-first) |
| `chunk-qxp553c4.js:190-195` (`ee`) | **`v27`** | `cozy_teapot` → `"relaxed"` bash-first steer |
| `chunk-qxp553c4.js:224` (`uso`) | `Hue`, `opus_5_prompt_bundle` | `willow_tern` → `# Writing for the user` |
| `chunk-1xqpf2j8.js:59654` | `lXt` | `xuo(... "no_nudges")` — model steer floor |
| `chunk-1xqpf2j8.js:59677` | `Hue \|\| lso` | `# Delivering work` section |
| `chunk-1xqpf2j8.js:59678` | `cso` | `# Corrections` section |
| `chunk-1xqpf2j8.js:59681` | `lXt` | `opus5_reduced_delegation` section |
| `chunk-1xqpf2j8.js:124744` | `sso()` | `bashFirstSteer` on the auto-mode attachment |

`thinking_display_updates` is declared in the capability enum and implied by the fable 5.1 bundle,
but has **no `mq()` call site in 2.1.280**. The only other occurrence of that string is the beta
descriptor `var Aoe = v19("thinking_display_updates", "thinking-display-updates-2026-08-18")`
(`chunk-zq6v8njb.js:5226`), whose emission is gated by `Axt(...) === "connector_text"` /
`CLAUDE_CODE_THINKING_DISPLAY_UPDATES` (`chunk-1xqpf2j8.js:78110-78118`), not by the capability.
Treat the capability as declared-but-unwired in this build.

---

### 4.4 The system prompt assembly, and exactly what opus-5.5 gets

Assembly function `Gv(tools, model, opts)` — `chunk-1xqpf2j8.js:59648` (byte 0x1DC670):

```js
let var_14 = [
    qd(`communication${v62}${he?":send_user_msg":""}`, () => K2n(v60)),
    qd("pronouns",           () => tVn),
    qd(`action_caution${v62}`,() => V2n(v60)),
    qd("task_continuity",    () => Y2n(v56)),
    qd(X2n,                  () => Z2n(v58)),          // "fable_identity"
    ...
    qd("act_dont_rederive",  () => kVn() ? bVn : null),
    qd("delivering_work_max",() => v34.CLAUDE_CODE_BISON_CAIRN ?? (Hue(v56) || lso(v60)) ? wVn : null),
    qd("overcorrection",     () => cso(v60) ? vVn : null),
    qd("subagent_steer_delegation", () => v51.has(mt) && yP() === "counter_steer" ? Huo : null),
    qd("opus5_reduced_delegation", () => {
        if (!lXt(v60)) return null;
        if (!v49("tengu_slate_bittern", true)) return null;
        let xe = xmt()?.value;
        if (xe?.includes(Emt) || xe?.includes(iVn)) return null;
        return Emt;
    }),
    qd("heron_brook",   () => rVn()),
    qd("brook_heron",   () => aVn(v60)),
    qd("willow_tern",   () => sVn(v60)),
    qd("autonomy_append", () => lVn(v56, v60)),
    ...
];
```

### 3.1 `communication` section — `K2n`, `chunk-1xqpf2j8.js:59359` (byte 0x1D45ED)

```js
var q2n = "Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own — what you found, what you did, and what's next — so a reader who only sees the last message has the full picture.";
function K2n(v51) {
    let v52 = Ge(v51);
    if (mq("turn_updates", v52, v51, v34.CLAUDE_CODE_TURN_UPDATES)) return q2n;          // fable 5.1 only
    if (z2n(v52, v51) || oso(v52)) { return `# Communicating with the user ...` }        // fable_5_mitigations / basalt_cove
    if (x2(v51)) return "Write code that reads like the surrounding code: match its comment density, naming, and idiom.";   // lean_prompt
    return `# Text output (does not apply to tool calls) ...`;                            // everyone else
}
```

- **fable-5.1 / mythos-5.1** → the one-paragraph `q2n` above.
- **fable-5 / mythos-5** (`fable_5_mitigations`) → the long `# Communicating with the user` block
  (line 59364 onward).
- **opus-5 AND opus-5-5** → both have `lean_prompt`, neither has `turn_updates` nor
  `fable_5_mitigations`, so both fall to the single line
  `"Write code that reads like the surrounding code: match its comment density, naming, and idiom."`
- **older models** (no `lean_prompt`) → the `# Text output (does not apply to tool calls)` block
  (line 59380).

**opus-5.5 gets the same communication section as opus-5. No change there.**

### 3.2 Sections opus-5 receives and opus-5.5 does NOT

Because `v19` implies only `silent_turn_reminder` + `quizzical_shore`, none of the opus-5 bundle
sections carry over to opus-5.5:

**(a) `delivering_work_max` — `wVn`, `chunk-1xqpf2j8.js:59638` (byte 0x1DB978).**
Gate: `CLAUDE_CODE_BISON_CAIRN ?? (Hue(model) || lso(model))`. `lso` = `mq("bison_cairn", …)`, in
`v6`, implied by `lXt` only.

> ```
> # Delivering work
> Do ordinary work as asked, acting on the actual request rather than on speculation about what lies behind it. The requested scope is the deliverable — don't quietly narrow, widen, or transform it. Interpret ambiguity the way a careful colleague would: make routine judgment calls yourself, and check in only when different readings would lead to materially different work. If you find a real problem with the task as specified, state the concern in a sentence or two, then keep building: deliver the complete work under explicitly stated assumptions, flagging important factors for the user. Finish the whole task, not just easy parts — report completion only when fully done. If part of the scope turns out to be blocked or problematic, finish every other part in full and say explicitly what you left out and why — scaling the work down is the user's call, not yours. Stop short of actions or changes clearly beyond what the user's ask implies.
>
> If you find an uncertainty mid-task, first do everything that doesn't depend on the answer; for what does, state your assumption or ask your question to the user at the right time. Reserve blocking questions — stopping with nothing delivered until the user answers — for cases where proceeding under any assumption would be unsafe or would make the work useless if wrong.
>
> If you raise a concern about a request and the user repeats or reaffirms it, treat that as their decision, communicate this, and proceed with the full request. Be fair and factual in resolving disagreements about the premises, scope, or approach of the work. Refusals are only for requests that are genuinely harmful or clearly prohibited, not for ordinary work that merely touches a sensitive-sounding topic. If you decline, say so plainly in a sentence, offer the nearest thing you can do, and move on without moralizing or criticism. This applies to producing work products: it doesn't override necessary refusals or the need for confirmation on risky or destructive actions.
> ```

**(b) `overcorrection` — `vVn`, `chunk-1xqpf2j8.js:59644` (byte 0x1DC180).** Gate: `cso` =
`mq("larch_cistern", …)`, in `v6`, `lXt` only.

> ```
> # Corrections
> Avoid unnecessary or excessive self-correction. Only correct an earlier statement in your user-facing text when the error would change the user's code, conclusions, or decisions. State corrections plainly and concisely, and continue the task; combine multiple corrections rather than enumerating them all. For slips that change nothing for the user, simply make the correction and move on - no need to note it explicitly. Don't add apologies or preambles, don't be overly self-critical, and don't ruminate or give a detailed account of the mistake or tally past errors. Sometimes, other agents will report incorrect or misleading results - don't always take them at face value immediately. If other agents correct your statements and they are right, then simply update your approach without narrating too much about the correction to the user. This instruction does not apply to thinking blocks.
>
> A follow-up question about your earlier work is not, by itself, a signal that you got something wrong — answer what was asked. A statement that was accurate needs no correction: don't re-audit how you phrased it, how you verified it, or limits you already stated. When the user does point to a real error, correct it plainly as above.
> ```

**(c) `opus5_reduced_delegation` — `Emt`, `chunk-1xqpf2j8.js:59453`.** Gate: `lXt` only.

> `Do not use the ${Task} tool, workflows, or deep-research unless the user, a CLAUDE.md file, or a skill asks for it`

**(d) `willow_tern` — `oVn`, `chunk-1xqpf2j8.js:59434`.** Gate `uso`
(`chunk-qxp553c4.js:224-232`): true for `Hue`, or `opus_5_prompt_bundle` + growthbook
`tengu_willow_tern`. Never reachable from the 5.5 bundle.

> ```
> # Writing for the user
> The user may not see your tool calls, tool results, or the text you write between them. Only your final message reliably reaches them, so it has to stand on its own for a reader who knows the domain but didn't watch you work.
>
> Rules for that message:
> - Lead with the answer or outcome. If something could not be verified, say so first. Keep it short by leaving things out, not by packing them in.
> - One idea per sentence, about 20 words, with a verb. Short does not mean clipped: a sentence beats a label with a colon. Start a new sentence instead of joining clauses with a semicolon.
> - No em-dashes, no parentheticals, no arrows.
> ...
> - Stop when the content stops. No closing offer, no restating what you did.
> ```

**(e) `no_nudges` model steer floor — `chunk-1xqpf2j8.js:59654`.**
`xuo((xe) => lXt(xe) ? "no_nudges" : undefined)` registers a **model-level floor** on the
subagent-steer mode (`chunk-266evs5w.js:3374 registerModelFloor`, resolver `jE` at 3383, reader
`yP` at 3413). Two prompt consequences, opus-5 only:

1. **Glob tool description** — `kfr`, `chunk-qxp553c4.js:330-336` (byte 0x2C79); the `yP()` test is on line 335:
   ```js
   return yP() === "default" ? se : v18;
   ```
   with
   ```js
   var v18 = `- Fast file pattern matching tool that works with any codebase size
   - Supports glob patterns like "**/*.js" or "src/**/*.ts"
   - Returns matching file paths sorted by modification time
   - Use this tool when you need to find files by name patterns`;
   var se = `${v18}
   - When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the ${Task} tool instead (if available)`;
   ```
   opus-5 loses the trailing Task-nudge bullet; **opus-5.5 keeps it** (`yP() === "default"`).
2. **Plan-mode tail** — `chunk-z1yd38dd.js:3310`:
   ```js
   function Z1t(v24) {
       if (!v24 || yP() !== "default") return "";
       return `\n\nIf this plan can be broken down into multiple independent tasks, consider spawning named teammates with the ${Task} tool (pass a \`name\`) to parallelize the work.`;
   }
   ```
   opus-5 loses this line; **opus-5.5 keeps it**.

Net: opus-5's bundle *suppresses* delegation; opus-5.5's bundle does not.

### 3.3 What opus-5.5 gains — `silent_turn_reminder`

Gate `TUt` — `chunk-1xqpf2j8.js:124022` (byte ≈0x3E5760):
```js
function TUt(v51) {
    let v52 = Ge(v51);
    return mq("silent_turn_reminder", v52, v51, v34.CLAUDE_CODE_SILENT_TURN_REMINDER);
}
```
Injection point — `chunk-1xqpf2j8.js:124360`:
```js
...ve && v54 === null && !v62?.isRegularUserPrompt && !Rre() && TUt(v58.options.mainLoopModel)
    ? [ja("silent_turn_reminder", () => Promise.resolve(O$r(v55 ?? [])))] : [],
```
(`Rre()` = focus/brief transcript view, `chunk-dnpy9qm8.js`; so the reminder is suppressed in focus mode.)

Emitter `O$r` — `chunk-1xqpf2j8.js:124627` (byte 0x3EB262):
```js
function O$r(v51) {
    let { turnsSinceLastReminder: v52, remindersInStretch: v53 } = I$r(v51);
    if (v53 >= wUt || v52 < EUt()) return [];      // wUt = 3 max reminders per silent stretch
    v33("silent_turn_reminder", { turns: v52 });
    return [{ type: "silent_turn_reminder", text: vUt() }];
}
```
Thresholds and text — `chunk-1xqpf2j8.js:124013-124035` (byte 0x3E571A for `bUt`):
```js
var kUt = 5;    // default turns of silence before the first reminder (growthbook "tengu_hushed_lark")
var wUt = 3;    // max reminders in one silent stretch
var bUt = "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.";
function vUt() {
    let v51 = v34.CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT;
    if (v51 !== undefined) return v51;
    let v52 = v49("tengu_hushed_lark_text", bUt);
    return typeof v52 === "string" && v52.trim() !== "" ? v52 : bUt;
}
```
Rendering — `chunk-1xqpf2j8.js:150959`:
```js
silent_turn_reminder: (v51) => [Ae({ content: Fa(v51.text), isMeta: true })],
```
(`Fa` is the `<system-reminder>` wrapper; the message is a meta user turn, not a system-prompt section.)

**Verbatim injected text (opus-5.5 and fable-5.1 only):**
> `The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.`

Counting rule (`I$r`, line 124582): assistant turns with no visible text and no user-facing tool
use (`M$r` = AskUserQuestion-class tools) count as "silent"; each already-emitted
`silent_turn_reminder` attachment increments `remindersInStretch`; the scan stops at the last real
(non-meta) user message.

### 3.4 What opus-5.5 gains — `quizzical_shore`

`chunk-z1yd38dd.js:1362-1375` (byte 0xA037):
```js
function sgn(v24) {
    if (typeof v24 === "string") {
        let v25 = Ge(v24);
        if (Lm(v25, "quizzical_shore", v24) === false) return false;
        if (mq("quizzical_shore", v25, v24)) return true;
    }
    return Boolean(v23("tengu_quizzical_shore", false));
}
function ign() { return Boolean(v23("tengu_lilac_dune", false)); }
function gr(v24) {
    let v25 = sgn(v24);
    if (ign()) return "faint";
    return v25 ? "hidden" : undefined;
}
```
Sole consumer — `Yt`, `chunk-z1yd38dd.js:1713` (byte 0xD22A):
```js
function Yt(v24, v26) {
    if (!Array.isArray(v24)) return {};
    let v25 = Y4r(v24);                                   // indexes of narration blocks
    if (v25.length === 0) return {};
    let v27 = sd() === "claude-vscode" ? gr(v26) : undefined;
    return { narration_block_indexes: v25, ...v27 !== undefined && { narration_hint: v27 } };
}
```
**`quizzical_shore` injects no prompt text.** It is a *rendering* hint carried on the assistant
message envelope (`narration_hint: "hidden"`), and it only applies when the entrypoint is
`claude-vscode`. For opus-5.5 the IDE is told to hide narration blocks.

### 3.5 `bash_output_audience_note` (fable 5.1 only, NOT opus 5.5)

Gate `dmt`, `chunk-1xqpf2j8.js:58781`; rendered text at `chunk-1xqpf2j8.js:150878` (byte 0x4BB8BE):
> `Only you see that command's output — the user's terminal shows at most a few lines of it. If the user needs to read any of it, put it in your reply.`

---

### 4.5 Two extra opus-5.5-only behaviours reached through `v27` directly

### 4.1 `thrifty_sonic` → bash-first is **forced** — `chunk-qxp553c4.js:167` (byte 0x1854)

```js
function v10() {
    let v41 = HJ(st());
    let v42 = Ge(v41);
    let v43 = Lm(v42, "thrifty_sonic", v41);
    if (v43 === false) return "none";
    if (Hue(v42) || v27(v42) || Tc()?.[v7] === true || v43) return "forced";   // v27 = opus 5.5
    return mCt(v41) ? "cohort" : "none";
}
```
`iAt()` (exported) then returns `true` unconditionally for opus-5.5 unless
`CLAUDE_CODE_THRIFTY_SONIC` is set. `iAt()` drives `bashFirst` on the auto-mode attachment
(`chunk-1xqpf2j8.js:124736`) and `chunk-1xqpf2j8.js:144305` (`auto` / `bypassPermissions` modes).

### 4.2 `cozy_teapot` → bash-first steer is **`"relaxed"`** — `chunk-qxp553c4.js:190` (byte 0x1AFE); `var v3 = "tengu_cozy_teapot"` at line 183

```js
var v3 = "tengu_cozy_teapot";
function ee() {
    return v13(Tc()?.[v3])
        ?? (v27(Ge(HJ(st()))) ? "relaxed" : undefined)     // opus 5.5 only
        ?? v13(Oa(v3, null))
        ?? "strict";
}
```
Consumed at `chunk-1xqpf2j8.js:124744` (`bashFirstSteer: v57 ? … : sso()`) and resolved into prompt
text at `chunk-1xqpf2j8.js:151601-151603` (byte 0x4C21A6):

```js
let v55 = `Do your work through the ${Bash} tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated ${Read}, ${Edit}, or ${Write} tools. Fall back to a dedicated tool only when ${Bash} genuinely cannot do the job.`;
let v58 = `You can do much of your work through the ${Bash} tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated ${Read}, ${Edit}, or ${Write} tools. The choice is yours: prefer ${Edit} or ${Write} when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.`;
let v57 = v51.bashFirstSteer === "relaxed" ? v58 : v55;
```

**strict (everyone else):**
> `Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.`

**relaxed (opus-5.5):**
> `You can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.`

This is the single most concrete opus-5.5-specific prompt text change in 2.1.280: bash-first is
turned on (`thrifty_sonic` forced) but immediately softened (`cozy_teapot` relaxed).

---

### 4.6 `cqe()` — what disables the 5.5 and fable-5.1 bundles

`chunk-pfvrcdfz.js:241` (byte 0x18A9):
```js
function cqe() {
    let v20 = v13();
    return v20.entrypoint !== undefined
        && (v17.has(v20.entrypoint) || v20.entrypoint === "local-agent" || v20.entrypoint === "local_agent")
        && !v20.childSession;
}
var v17 = new Set(["remote_cowork", "remote_cowork_trigger"]);   // chunk-pfvrcdfz.js:103
```
`v13()` reads the per-host session record (`chunk-pfvrcdfz.js:202`), whose `entrypoint` comes from
`CLAUDE_CODE_ENTRYPOINT`.

So `cqe()` is **"this is a top-level Cowork or local-agent session"**. In that case:
- `v27(...)` is forced false → the opus-5.5 bundle contributes nothing,
- `Hue(...)` is forced false → the fable-5.1 bundle contributes nothing.

Note the asymmetry: `lXt` (opus 5) is **not** gated by `cqe()`; it is gated by the growthbook
flag `tengu_fennel_godwit` instead. Child sessions (`childSession === true`) are exempt from
`cqe()`, so subagents spawned inside a Cowork session keep the bundles.

Per-capability escape hatches that also disable pieces of the bundle
(`mq`'s 4th arg short-circuits everything, including a catalog `true`):
`CLAUDE_CODE_SILENT_TURN_REMINDER`, `CLAUDE_CODE_TURN_UPDATES`,
`CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE`, `CLAUDE_CODE_BISON_CAIRN`,
`CLAUDE_CODE_LARCH_CISTERN`, `CLAUDE_CODE_AMBER_ASTROLABE`, plus
`CLAUDE_CODE_THRIFTY_SONIC`, `CLAUDE_CODE_COZY_TEAPOT`,
`CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT`, `CLAUDE_CODE_SILENT_TURN_REMINDER_TURNS`.
`quizzical_shore` has **no** env override — only the catalog/served capability or growthbook
`tengu_quizzical_shore`.

---

### 4.7 Diff against 2.1.278

Source: `/home/cole/SiteResearch/anthropic/v2.1.278/extracted`; capability/gating chunk there is
`chunk-8g7kba08.js` (= v280 `chunk-qxp553c4.js`), catalog is `chunk-nx23dqm4.js`
(= v280 `chunk-kx6bqsxn.js`), fable predicate in `chunk-phxn5x14.js` (= v280 `chunk-7ecsxd13.js`).

| string | in 2.1.278? |
|---|---|
| `opus_5_5_prompt_bundle` | **absent (0 hits in the whole tree)** |
| `claude-opus-5-5` / `Opus 5.5` | **absent** |
| `quizzical_shore` | present — `chunk-nx23dqm4.js` (capability enum) + `chunk-fw0qgtdx.js` (`sgn`/`gr`) |
| `tengu_quizzical_shore` | present |
| `opus_5_prompt_bundle`, `fable_5_1_prompt_bundle` | present |
| `silent_turn_reminder`, `turn_updates`, `bash_output_audience_note`, `thinking_display_updates` | present |
| `bison_cairn`, `larch_cistern`, `amber_astrolabe`, `lucky_cerf`, `thrifty_sonic`, `cozy_teapot` | present |

So **`quizzical_shore` already existed in 2.1.278**, but with no bundle wiring — it was reachable
only through a served/client-data capability or the `tengu_quizzical_shore` growthbook flag.
2.1.280 is the first build that hands it to a model by default.

Concrete code deltas in the gating chunk (beautified `/tmp/v278/chunk-8g7kba08.js`):

1. **No `v27`/isOpus55Bundle function at all.** v278 has only `_4t` (= `lXt`) and imported `wle`
   (= `Hue`).
2. **Implied sets, v278 lines 38-44:**
   ```js
   var v19 = new Set(["turn_updates","bash_output_audience_note","silent_turn_reminder","thinking_display_updates"]);
   var v6  = new Set(["bison_cairn","larch_cistern"]);
   ```
   Only two sets. v280 renumbers the fable set to `v5` and adds
   `var v19 = new Set(["silent_turn_reminder","quizzical_shore"])`.
3. **`mq` (v278 `func_1`, line 46-72)** has two implication clauses:
   ```js
   if (v50 === true || v19.has(v43) && wle(v47) || v6.has(v43) && _4t(v49)) return true;
   ```
   v280 adds `|| v19.has(v44) && v27(v48)`.
4. **`thrifty_sonic` (v278 `v14`, line 162-169):**
   ```js
   if (wle(v41) || xc()?.[v8] === true || v42) return "forced";
   ```
   v280 inserts `v27(v42)` → opus-5.5 forces bash-first.
5. **`cozy_teapot` (v278 `v16`, line 185-187):**
   ```js
   function v16() { return v17(xc()?.[v3]) ?? v17(ql(v3, null)) ?? "strict"; }
   ```
   v280 inserts the `v27(...) ? "relaxed" : undefined` term between client-data and growthbook.

Everything else in the bundle machinery (`cqe` gating of `Hue`, the `lXt` growthbook kill-switch,
the section texts `wVn`/`vVn`/`oVn`/`q2n`/`bUt`) is unchanged between the two builds.

---

### 4.8 Bottom line for `claude-opus-5-5`

Relative to `claude-opus-5`, the 5.5 prompt bundle **removes** four system-prompt sections and a
delegation suppressor, and **adds** one meta reminder, one IDE rendering hint, and a bash-first
posture:

| | opus-5 | opus-5-5 |
|---|---|---|
| `# Delivering work` (`wVn`) | yes | **no** |
| `# Corrections` (`vVn`) | yes | **no** |
| `Do not use the Task tool…` (`Emt`) | yes | **no** |
| `# Writing for the user` (`oVn`) | possible (growthbook) | **no** |
| Glob "use the Task tool instead" bullet | suppressed | **kept** |
| plan-mode "spawn named teammates" line | suppressed | **kept** |
| `<system-reminder>` silent-turn nudge | no | **yes** (after 5 silent turns, max 3) |
| `narration_hint: "hidden"` (claude-vscode) | no | **yes** |
| bash-first (`thrifty_sonic`) | cohort/off | **forced on** |
| bash-first steer (`cozy_teapot`) | `strict` | **`relaxed`** |
| communication section | one `lean_prompt` line | **identical** |

Both bundles are hard-disabled — for 5.5 via `cqe()` — in top-level `remote_cowork` /
`remote_cowork_trigger` / `local-agent` / `local_agent` sessions.



---

## 5. `refusal_fallback` and `fast_mode`

*(analysis by worker `refusal-fastmode`; full fragment also at `/tmp/v280/part-refusal-fastmode.md`)*

### 5.1 The v2.1.280 route map (equivalent of v272 `FYo`/`$Yo`/`BYo`/`UYo`)

**Chunk:** `chunk-8knzj4cj.js` · byte offset `0x7E91F` (518431) · beautified lines 23411–23443.

Verbatim (minified, as found at 0x7E91F):

```js
function U5t(e){return e==="cyber"||e==="bio"}
function Cj(e){return e==="frontier_llm"||e==="reasoning_extraction"}
function DX(e){return U5t(e)||Cj(e)?e:"other"}
var Oj=3,
    Pj={bio:"claude-opus-5",cyber:"claude-opus-4-8"},
    Dj={cyber:"claude-opus-4-8"},
    Mj={bio:"claude-opus-5",cyber:"claude-opus-4-8",frontier_llm:"claude-opus-5"},
    Ij={bio:"claude-opus-4-8",cyber:"claude-opus-4-8"};
function Lj(e){
  if(Hc(e))return Ij;
  if(e==="claude-opus-5-5"||e==="claude-opus-5-5[1m]")return Mj;
  if(e==="claude-opus-5"  ||e==="claude-opus-5[1m]")  return Dj;
  return Pj
}
var Nj=!1;
function Fj(){let e=process.env.CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL;if(ko(e))return!1;return Me(e)||Nj}
```

`Hc` is still a hard `return false` (beautified line 23408), so `Ij` is unreachable — same as
`k$e`/`BYo` in v272.

#### Symbol mapping v272 → v280

| v272 | v280 | value |
|---|---|---|
| `FYo` (default map)     | `Pj` | `{bio:"claude-opus-5", cyber:"claude-opus-4-8"}` |
| `$Yo` (opus-5 override) | `Dj` | `{cyber:"claude-opus-4-8"}` |
| *(new)*                 | `Mj` | `{bio:"claude-opus-5", cyber:"claude-opus-4-8", frontier_llm:"claude-opus-5"}` |
| `BYo` (dead branch)     | `Ij` | `{bio:"claude-opus-4-8", cyber:"claude-opus-4-8"}` |
| `UYo` (selector)        | `Lj` | selector, now with an `opus-5-5` arm |
| `k$e` (`false`)         | `Hc` | `function Hc(e){return false}` |
| chain cap `3`           | `Oj` | `3` |

v272 original for comparison (`chunk-b2hkftr9.js`):

```js
FYo={bio:"claude-opus-5",cyber:"claude-opus-4-8"},$Yo={cyber:"claude-opus-4-8"},
BYo={bio:"claude-opus-4-8",cyber:"claude-opus-4-8"};
function UYo(e){if(k$e(e))return BYo;if(e==="claude-opus-5"||e==="claude-opus-5[1m]")return $Yo;return FYo}
```

#### Resolver (unchanged shape from v272/v278)

`Bir` (beautified 23481–23512) — chains supported; each map value may be a `string` **or**
an array, truncated to `Oj = 3` entries by `Bj`:

```js
function Bj(v41){return (typeof v41==="string"?[v41]:v41).slice(0,Oj)}
function Bir(v41){
  let {originalModelCanonical:v43, apiRefusalCategory:v44}=v41;
  let v45 = v41.routesOverride ?? Lj(v43);
  let v42 = v44!=null && Object.hasOwn(v45,v44) ? v45[v44] : undefined;
  if (v42!==undefined) { ... matched:"category" ... }
  if (Fj() && !v41.armedTargetIsRefusingModel) return {matched:"catch_all", model:v41.armedFallbackModel};
  return {matched:"none", model:undefined, reason:"unmapped"};
}
```

Decline telemetry reasons: `unmapped`, `mapped_target_unresolvable`, `chain_entry_unresolvable`
(`Dg`/`XTn`/`JTn`, event `tengu_refusal_fallback_route_declined`).

Internal correlation headers (beautified 23843–23845):
`x-is-refusal-fallback` (`Kv`), `x-cc-fallback-latched-by` (`Vv`), `x-cc-fallback-from-model` (`Zir`).

---

### 5.2 `claude-opus-5-5` as refusal-fallback SOURCE / TARGET

**SOURCE: yes.** `Lj("claude-opus-5-5")` and `Lj("claude-opus-5-5[1m]")` → `Mj`:

| refusal category | opus-5-5 target |
|---|---|
| `bio` | **`claude-opus-5`** |
| `cyber` | **`claude-opus-4-8`** |
| `frontier_llm` | **`claude-opus-5`** ← new; no other model has a `frontier_llm` route |
| `reasoning_extraction` | *unmapped* → only the env-gated `catch_all` (`CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL`) |
| anything else | `DX()` folds to `"other"` → unmapped |

**TARGET: no.** `claude-opus-5-5` never appears as a value in `Pj`/`Dj`/`Mj`/`Ij`. Only
`claude-opus-5` and `claude-opus-4-8` are ever route targets. Nothing routes *to* opus-5-5.

**Client "armed fallback" model (the `/model` switch target and the `catch_all` model)** is a
separate mechanism, `Hv` + `Uv(..., "walk_down_opus_lineup")` (`chunk-8knzj4cj.js` 23544–23585),
resolved from the opus lineup in `chunk-kx6bqsxn.js` line 1318:

```js
var _xt = ["opus55","opus5","opus48","opus47","opus46","opus45"];
var JS = "opus5";
function Ld(){let v32 = al()?sv("opus"):undefined;
  return v32!==undefined && Fd.indexOf(v32) > _xt.indexOf(JS) ? v32 : JS}
function Uyr(){let v32=kc();return Fd.slice(Fd.indexOf(Ld())).map((v33)=>v32[v33])}
```
`Ld()` is pinned at `"opus5"` (an org override can only move it *down* the list, index must be
greater), so the armed/walk-down lineup starts at `claude-opus-5` and never at `opus-5-5`. This
agrees with the catalog field `fallback_3p:"claude-opus-5"` for opus-5-5.

Relevant catalog fields (`chunk-kx6bqsxn.js` 697–751):

```js
{ id:"claude-opus-5-5", family:"opus", display_name:"Opus 5.5",
  knowledge_cutoff:"June 2026",
  fallback_3p:"claude-opus-5",
  context:{window:1e6, native_1m:true, supports_1m_beta:true, supports_1m_suffix:true},
  max_output_tokens:{default:128e3, upper:128e3},
  pricing:"tier_4_20_cache_read_0_20",
  capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking",
    "rejects_disabled_thinking","mid_conv_system","mid_conv_tool_change",
    "per_turn_effort","per_turn_timing","context_management",
    "fast_mode","lean_prompt","refusal_fallback","opus_5_5_prompt_bundle"],
  default_effort:"medium", advisor_rank:4 }
```

Full v280 capability matrix (scanned from the baked catalog):

| model | `refusal_fallback` | `fast_mode` | `fallback_3p` | pricing |
|---|---|---|---|---|
| claude-opus-4-8 | – | **yes** | claude-opus-4-7 | tier_5_25 |
| claude-opus-5 | **yes** | **yes** | claude-opus-4-8 | tier_5_25 |
| **claude-opus-5-5** | **yes** | **yes** | claude-opus-5 | **tier_4_20_cache_read_0_20** |
| claude-fable-5 | **yes** | – | **claude-opus-5-5** | tier_10_50 |
| claude-fable-5-1 | **yes** | – | claude-fable-5 | tier_10_50_cache_read_0_25 |
| all others (sonnet-*, haiku-*, mythos-*, opus ≤4-7) | – | – | … | … |

Aliases (`chunk-kx6bqsxn.js` 957–993): `opus.default = "claude-opus-5-5"`,
`latest_per_family.opus = "claude-opus-5-5"`. So opus-5-5 is the new default opus.

**opus-5-5-specific refusal copy.** `zv` (beautified 23759) gates a message table on the model
being exactly `claude-opus-5-5`:

```js
function zv(v41,v42){
  if(v41==null||typeof v42!=="string"||Tx(Ge(v41,{identity:true}))!=="claude-opus-5-5")return;
  return Object.hasOwn(Mv,v42)?Mv[v42]:undefined
}
var Mv={
  cyber:(m)=>`You may be seeing this for the first time on an Opus model: ${m} is more capable and has stronger safeguards as a result, which can sometimes flag non-cybersecurity work. ...`,
  bio:(m)=>`... biology-research-adjacent work. ...`,
  frontier_llm:(m)=>`... We're improving these safeguards ...`
};
var Yj = new Set(["cyber","frontier_llm"]);   // beautified 23835
```

---

### 5.3 Betas and the `fallbacks` request field

#### Beta constants — `chunk-zq6v8njb.js` byte `0x25D00` (154880), beautified 5217–5219

```js
var sM = v19("server_side_fallback",          "server-side-fallback-2026-06-01");
var vy = v19("server_side_fallback_category", "server-side-fallback-2026-07-01");
var CL = v19("fallback_credit",               "fallback-credit-2026-06-01");
```

#### Emission — `chunk-1xqpf2j8.js` byte `0x1C89CE` (1870286), beautified 75490–75508

```js
function WEt(v51, v54, v55, v56, v52 = false, v53 = false) {
	let v58 = v51 !== undefined && !v53 && v54 === v51.forModel && Ba() && !Zf(v56, sM);
	let v57 = v58 && vy !== null && v51.mode === "default" && !Zf(v56, vy);
	if (v58) QL(v56, v57 && vy !== null ? vy : sM);
	for (let v59 of [sM, vy]) if (v59 !== null && uA(v56, v59) && !v52 && !v55.includes(v59)) v55.push(v59);
	if (!v58) return {};
	return v57 ? { fallbacks: "default" } : { fallbacks: [{ model: Xn(v51.model) }] };
}
function GEt(v51, v53, v54, v55 = false, v52) {           // fallback-credit beta
	if (v51 && !Zf(v54, CL)) QL(v54, CL);
	if (uA(v54, CL) && !v55 && !v53.includes(CL)) v53.push(CL);
	if (v52 && v53.includes(CL)) { /* bedrock: mirror into body.anthropic_beta */ }
}
```

Reading:
- `v55` is the outgoing beta array. **Both** `sM` (06-01) and `vy` (07-01) are pushed, each
  gated only by `uA(sticky, beta)` (beta currently believed-supported) and `!silentArm`.
  Confirms the v272-era conclusion: Claude Code sends the 06-01 **and** 07-01 betas together.
- `CL` (`fallback-credit-2026-06-01`) is a third, independent beta pushed by `GEt` when
  `fallbackCreditLaneArmed` / `fallbackCreditCode` is set.
- `Zf(sticky, beta)` = beta known-rejected; `QL` = mark attempted; `XEt` (75630) picks which
  single beta to blame when a 400 comes back.

#### Request body field

`chunk-1xqpf2j8.js` byte ~`0x1C3BD1` region, beautified 83038–83042 and 83211–83236:

```js
let vl = WEt(v56.serverRefusalFallback, er.model, Nr, ht, fl, Li);
I0 = vl.fallbacks !== undefined;
MK = vl.fallbacks === "default" ? "default" : I0 ? "explicit" : "none";
GEt(v56.fallbackCreditLaneArmed === true || v56.fallbackCreditCode !== undefined, Nr, ht, fl, ...);
...
let Au = {
  model: jH(v56.model), messages: ..., system: ..., tool_choice: Xh,
  ...pl && { betas: WC(Kl) },
  metadata: ..., max_tokens: Iv, thinking: yc,
  ...vl,                                            // <-- `fallbacks`
  ...Object.keys(fi).length > 0 && { output_config: fi },
  ...m_ !== undefined && { speed: m_ },             // <-- fast mode (see §4)
  ..._s !== null && { thread: _s.thread },
  ...dv && ... ? { diagnostics: { previous_message_id: he ?? null } } : {}
};
```

So the wire field is top-level **`fallbacks`**, two shapes:
- `"fallbacks": "default"` — server chooses (requires the 07-01 category beta and `mode==="default"`)
- `"fallbacks": [ { "model": "<canonical-id>" } ]` — explicit single target

Mode selection: `dwn()` (75647) builds the lane, `mode = YEt(...) ? "default" : "explicit"`;
`YEt` (75625) requires `vy !== null`, `Wir(primaryModel) !== undefined`, beta not stuck,
`fQr()` and `serverDefaultFallbacksEnabled()`.

#### Response handling

Streaming `content_block_start` with a `fallback` block — parser `nxe` (75533):

```json
{"type":"content_block_start","index":N,
 "content_block":{"type":"fallback",
                  "from":{"model":"claude-opus-5-5"},
                  "to":{"model":"claude-opus-4-8"},
                  "trigger":{"type":"refusal","category":"cyber"}}}
```
- `gee` requires `from.model` / `to.model` to be non-empty strings.
- `qEt` reads `trigger` only when `trigger.type === "refusal"`, `category` ≤ 64 chars.
- `VEt` (75566) flags a malformed `fallback` block (type matches but parse failed).
- `txe` (75514) emits the same shape locally: `{type:"fallback",from:{model},to:{model}}`.
- `ZEe` (75509) reads `fallback_credit_token` (string, ≤ 2048) off the response.

`usage.iterations[]` — parser `nVt` (75596):

```js
let v57 = { type: v58.type, model: ..., inputTokens: mee(v58.input_tokens),
            outputTokens: mee(v58.output_tokens),
            cacheReadInputTokens: mee(v58.cache_read_input_tokens),
            cacheCreationInputTokens: mee(v58.cache_creation_input_tokens) };
if (v58.type === "fallback_message" && v57.model !== undefined) v52 = v57.model;
return { servedFallbackModel: v52, entries: v55 };
```
Cost accumulation `rxe` (75575) sums every `fallback_message` iteration **except** the *last*
one when `reason === "refusal"` (a fallback message that itself refused is excluded), and adds a
zero-token base charge for the first fallback model.

400-error classification for this surface — `gke` (44181) buckets:
`category_beta_header`, `beta_header`, `default_unconfigured`
(`"has no default fallback configuration"`), `unsupported_primary`, `invalid_target`,
`param_shape`, `extra_forbidden`. `hke` (44199) buckets credit errors:
`credit_beta_header`, `credit_malformed`, `credit_wrong_org`, `credit_expired`.
Note `"\`fallback\` and \`fallbacks\` cannot both be set"` → the server also has a singular
`fallback` field that Claude Code never sends.

---

### 5.4 `fast_mode` — wire behaviour

**Capability check — `chunk-266evs5w.js` beautified 18145–18153:**

```js
function Qm(v32) {
	if (!to()) return false;
	let v34 = v32 ?? Sy();
	let v35 = kt(v34);
	let v36 = Lm(Ge(v35), "fast_mode", v35);
	if (v36 !== undefined) return v36;
	let v33 = v35.toLowerCase();
	return v33.includes("opus-4-8") || v33.includes("opus-5");
}
function to() {                                   // 18015
	if (Oe() !== "firstParty") return false;
	return !v16.CLAUDE_CODE_DISABLE_FAST_MODE;
}
function fE(v32) { if (!to()) return false; return Bq(v32) === null; }   // 18040 (no blocking reason)
function HSe() { return aCt().status === "cooldown"; }                   // 18330
```

`Ade` / `e_r` / `Mze` (`chunk-266evs5w.js` 9143–9165) are the **auto-mode / skill-model** gate,
not the wire gate:

```js
function ww(v32){return or(v32,"claude-opus-4-6")}
function Ade(v32){ let v33=Ge(v32);
  if (ww(v33)) return false;
  if (rQt() && (v33==="claude-opus-4-6"||v33==="claude-sonnet-4-6"||v33.includes("haiku"))) return false;
  return true }
function e_r({model:v32, fastMode:v33, disableFastMode:v34}) {
  let v35 = v34 && (v33||false);
  return { supported: Ade(v32) && !v35, disableFastModeBreakerFires: v35 } }
function Mze({skillModel:v32, mode:v34, fastMode:v35}) { /* warns and keeps session model */ }
```

**Wire gate — `chunk-1xqpf2j8.js` byte `0x1F30CF` (2044367):**

```js
if(to()&&y(()=>fE())&&!HSe()&&y(()=>Qm(Le))&&!!er.fastMode)m_="fast"
```
(beautified 83137–83138), consumed at byte `0x1F3ED1` (2047057):
```js
...m_!==void 0&&{speed:m_},
```

**Conclusion:** `fast_mode` is a plain top-level request-body field **`"speed": "fast"`**.
- No beta header. No `-fast` model-id suffix (the `/-fast(?![a-z0-9])/` test at
  `chunk-266evs5w.js:26710` is an input-parser *rejection* of user-typed `…-fast` ids, not an
  emitter).
- First-party only (`to()` → `Oe() === "firstParty"`), killable with
  `CLAUDE_CODE_DISABLE_FAST_MODE`; further env knobs `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK`,
  `CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS`.
- Response side: `usage.speed` comes back (`"fast"` / `"normal"` / `null`) and is used for
  pricing and the OTEL attribute `{...to() && n.speed==="fast" && {speed:"fast"}}`
  (byte `0x9FC23`, 654371).

**What opus-5-5 gets.** `fast_mode` is in its catalog capability list, so `Qm` returns `true`
from the catalog (not the substring heuristic, which would also match `"opus-5"`). Fast-mode
pricing is its own table (`chunk-266evs5w.js` 18485–18514):

```js
var Lh = {inputTokens:30, outputTokens:150, promptCacheWriteTokens:37.5, promptCacheWrite1hTokens:60, promptCacheReadTokens:3,  webSearchRequests:.01};
var xs = {inputTokens:10, outputTokens:50,  promptCacheWriteTokens:12.5, promptCacheWrite1hTokens:20, promptCacheReadTokens:1,  webSearchRequests:.01};
var Uh = {inputTokens:8,  outputTokens:40,  promptCacheWriteTokens:10,   promptCacheWrite1hTokens:16, promptCacheReadTokens:.4, webSearchRequests:.01};
function Tze(v32){
  if(!to()) return Zre[v32] ?? Btt;
  if(v32==="claude-opus-5-5") return Uh;
  if(v32==="claude-opus-4-8"||v32==="claude-opus-5") return xs;
  return Lh }
```
and the same three-way branch in `QOn` (18624–18628) when `opts.speed === "fast"`.

So: **opus-5-5 fast mode = `$8 / $40` per Mtok** (cache write `$10`, 1h cache write `$16`,
cache read `$0.40`) versus its normal `tier_4_20_cache_read_0_20`. opus-5 / opus-4-8 fast is
`$10/$50`; opus-4-6 / opus-4-7 fast is `$30/$150`.

Fast-mode rate limiting is separate from quota: `chunk-266evs5w.js` 874–885 handles
`fast-mode-limit` (600 000 ms cooldown) and `fast-mode-short-limit` (10 000 ms), both driven by
`anthropic-ratelimit-unified-status: rejected`.

---

### 5.5 v280 vs v278 diff (this area)

`v278` map lives in `chunk-xb8gq2xw.js` (beautified `/tmp/v278/chunk-xb8gq2xw.js` 51392–51490):

```js
function Hce(v51){return false}                       // == Hc
var cvr = 3;                                          // == Oj
var dvr = {bio:"claude-opus-5", cyber:"claude-opus-4-8"};   // == Pj
var uvr = {cyber:"claude-opus-4-8"};                        // == Dj
var fvr = {bio:"claude-opus-4-8", cyber:"claude-opus-4-8"}; // == Ij
function pvr(v51){
  if(Hce(v51))return fvr;
  if(v51==="claude-opus-5"||v51==="claude-opus-5[1m]")return uvr;
  return dvr }
```

| area | v278 | v280 |
|---|---|---|
| route maps | 3 maps (`dvr`,`uvr`,`fvr`) | **4** maps — new `Mj` for opus-5-5 |
| `frontier_llm` route | none (category recognized by `lvr`, never mapped) | **`frontier_llm → claude-opus-5` for opus-5-5 only** |
| selector arms | `opus-5`, dead-`Hce` | + `claude-opus-5-5` / `claude-opus-5-5[1m]` |
| resolver `Bir`/`M0e` | identical | identical (chains, `Oj/cvr = 3`, catch_all env) |
| categories | `cyber`,`bio`,`frontier_llm`,`reasoning_extraction` | identical |
| catalog | 19 models, no opus-5-5; `fable-5.fallback_3p = claude-opus-5`; opus alias default `claude-opus-5` | 20 models, **opus-5-5 added**; `fable-5.fallback_3p = claude-opus-5-5`; opus alias default + `latest_per_family.opus` = `claude-opus-5-5` |
| opus lineup `_xt` | starts at `opus5` | **`["opus55","opus5","opus48",…]`** (opus55 prepended; `Ld()` still pins the walk-down base at `opus5`) |
| refusal copy | generic | new opus-5-5-gated `Mv` table (`zv`) + `Yj = {cyber, frontier_llm}` |
| betas | `sM`/`vy`/`CL` all present, both fallback betas pushed | identical constants and identical `WEt` logic |
| fast mode gate | `if(Zr()&&y(()=>jv())&&!Zye()&&y(()=>_g(De))&&!!Bn.fastMode)db="fast"` @ 104644, emitted `...db!==void 0&&{speed:db}` @ 104736 | byte-identical logic, renamed (`to/fE/HSe/Qm`, `m_`) |
| fast-mode pricing | 2 tiers (`$10/$50` for opus-4-8/opus-5, `$30/$150` otherwise) | **3 tiers** — new `Uh = $8/$40` for opus-5-5 |
| `fast_mode` capability holders | opus-4-8, opus-5 | + **opus-5-5** |

Net: the refusal-fallback *machinery* is unchanged between v278 and v280. The only functional
deltas are (a) the new `Mj` map giving opus-5-5 a `frontier_llm` route, (b) the catalog entry
and lineup/alias promotion of opus-5-5, and (c) a cheaper third fast-mode pricing tier.

---

### 5.6 Impact notes for `anthropic-auth`

1. `packages/core/src/models.ts` `resolveRefusalFallbackModel` must gain an `opus-5-5` arm:
   `bio → claude-opus-5`, `cyber → claude-opus-4-8`, `frontier_llm → claude-opus-5`.
   Today's catch-all `claude-opus-4-8` would send a `bio`/`frontier_llm` refusal one step too far down.
2. `frontier_llm` (and `reasoning_extraction`) must be accepted as refusal categories; only
   `frontier_llm` is routable, and only from opus-5-5.
3. Both betas (`server-side-fallback-2026-06-01`, `server-side-fallback-2026-07-01`) are already
   sent base-first; that matches v280. A third beta, `fallback-credit-2026-06-01`, exists but is
   org-credit-gated and is not required for fallback.
4. `fast_mode` is wire-level `body.speed = "fast"`, first-party only, no beta. opus-5-5 is
   eligible; its fast tier is `$8/$40` per Mtok with `$0.40` cache read.
5. opus-5-5 normal pricing tier is `tier_4_20_cache_read_0_20` — a new tier id; anything that
   maps `claude-opus-5-` prefixes to opus-5 pricing (`tier_5_25`) will overcharge.



---

## 6. Answers, condensed

**Q1 — `opus_5_5_prompt_bundle`.** Predicate `v27(model) = !cqe() && Lm(model,"opus_5_5_prompt_bundle") === true` (chunk-qxp553c4.js:39). It implies exactly two sub-capabilities, `{silent_turn_reminder, quizzical_shore}` (set `v19`, line 49). Net effect vs `opus_5_prompt_bundle`: Opus 5.5 **loses** the `# Delivering work` (`wVn`), `# Corrections` (`vVn`), `# Writing for the user` (`oVn`) sections and the `"Do not use the Task tool, workflows, or deep-research unless the user, a CLAUDE.md file, or a skill asks for it"` line (`Emt`), and it **keeps** the delegation hints Opus 5 suppresses. It **gains** the silent-turn `<system-reminder>` (`"The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell - a finding, a change of plan."`), a `narration_hint: "hidden"` render hint (claude-vscode only), forced bash-first (`thrifty_sonic`), and the `"relaxed"` bash-first steer text. `fable_5_1_prompt_bundle` implies a different four-capability set and is the only one that changes the communication section.

**Q2 — `rejects_disabled_thinking`.** The `thinking` key is **omitted entirely** when the user turns thinking off; `{"type":"disabled"}` is never sent. `aoe()` also pads `max_tokens` by **2048** on mechanical/side queries. The client then treats an absent `thinking` as thinking-on and demotes `tool_choice:{type:"tool"}` to `{type:"auto"}`. `budget_tokens` is unreachable for this model (adaptive only).

**Q3 — `per_turn_effort` / `per_turn_timing`.** New wire carrier: a `{"role":"system"}` message with a top-level `output_config` — `{"effort":"<level>","timing":{"type":"now","now":"2026-09-22T13:04:07-07:00"}}` — interleaved before user turns. Betas `per-turn-control-2026-07-01` (effort) and `timing-2026-09-09` (timing). Timing additionally requires env `CLAUDE_CODE_PER_TURN_TIMING`; effort additionally requires the `tengu_per_turn_effort` gate or client-data.

**Q4 — `refusal_fallback`.** v280 adds a fourth route map `Mj` selected only for `claude-opus-5-5`/`claude-opus-5-5[1m]`: `{bio:"claude-opus-5", cyber:"claude-opus-4-8", frontier_llm:"claude-opus-5"}` — the first `frontier_llm` route to ship. Opus 5.5 is a **source only**, never a target. Both `server-side-fallback-2026-06-01` and `-2026-07-01` betas are sent; the request field is top-level `fallbacks`.

**Q5 — effort/thinking shape for Opus 5.5.** `output_config: {"effort":"medium"}` by default (catalog `default_effort`), `thinking: {"type":"adaptive", "display": ...}` normally, `thinking` absent when disabled, `budget_tokens` never sent, `speed:"fast"` when fast mode is on, `context_management.edits[0] = {"type":"clear_thinking_20251015","keep":"all"}` whenever thinking is active. **No `min_cli_version` and no picker gating** — Opus 5.5 is visible to every 2.1.280 client, and it is the new `opus` alias target on first-party/bedrock/vertex/mantle (`foundry` stays 4.6, `gateway` stays 4.7).

### Impact for this repo (`anthropic-auth`)

1. `packages/core/src/models.ts` — add `claude-opus-5-5`: adaptive thinking yes, max/xhigh yes, **`rejects_disabled_thinking` yes** (never emit `thinking:{type:"disabled"}`; omit the key), `default_effort: "medium"`, 1M context, 128k max output, pricing **`tier_4_20_cache_read_0_20`** (`$4/$20`, cache read `$0.20`). A prefix match of `claude-opus-5-` onto `tier_5_25` would overcharge by 25 % and 2.5x on cache reads — the same class of bug as the fable-5.1 pricing defect.
2. `resolveRefusalFallbackModel` — add an opus-5-5 arm: `bio → claude-opus-5`, `frontier_llm → claude-opus-5`, `cyber → claude-opus-4-8`. The current catch-all `claude-opus-4-8` over-demotes bio/frontier_llm refusals.
3. Fast mode is the body field `speed: "fast"` (first-party only), not a beta and not a model suffix.
4. If per-turn control is ever mirrored, note that it rides as `role:"system"` messages carrying `output_config` and needs `mid-conversation-system-2026-04-07` to be accepted at all.
