# Anthropic server-side safety fallbacks

Date: 2026-08-07

## Sources

- Anthropic, [Improving Fable 5's biology safeguards](https://www.anthropic.com/news/improving-fable-5-s-biology-safeguards)
- Anthropic, [Introducing Claude Opus 5](https://www.anthropic.com/news/claude-opus-5)
- Anthropic Platform, [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- Live Anthropic Models and Messages APIs queried with the `server-side-fallback-2026-07-01` beta on 2026-08-07

## Findings

Anthropic's safety fallback is not a universal model ladder. Routing is conditioned on the classifier category and source model:

- A Fable 5 request flagged by the biology safeguard is routed to Opus 5 in Anthropic's first-party products, including Claude Code.
- An Opus 5 request flagged by the cybersecurity safeguard is routed to Opus 4.8 in Anthropic's first-party products.
- The API supports the same mechanism as an opt-in beta by sending `fallbacks: "default"` with `anthropic-beta: server-side-fallback-2026-07-01`.
- Anthropic recommends `default` routing because the category-specific routes can change. The default route table is not a stable public mapping that clients should duplicate.
- Classifier routing is category-aware, but server-side fallback also uses best-effort sticky routing: after a fallback serves a conversation, later requests containing `fallbacks` can go directly to that model for approximately one hour without trying the requested model again.

The live Models API currently reports:

| Requested model | Allowed fallback models |
| --- | --- |
| `claude-fable-5` | `claude-opus-4-8`, `claude-opus-5` |
| `claude-opus-5` | `claude-opus-4-8` |
| `claude-opus-4-8` | none |

This confirms a routing graph rather than a fixed Fable → Opus 5 → Opus 4.8 chain. Fable can legally route to either Opus model; Anthropic chooses the target according to the safety category. The two launch articles publicly identify Fable-biology → Opus 5 and Opus-5-cybersecurity → Opus 4.8.

A live OAuth Messages request to `claude-fable-5` with `fallbacks: "default"` and the beta header returned HTTP 200. The non-refused response stayed on Fable 5 and exposed the beta response additions `stop_details: null` and `usage.iterations`. This proves that the OAuth Messages path accepts the beta request shape. Anthropic's protocol documentation specifies the fallback stream shape: the top-level `model` identifies the serving model, an ordinary `fallback` content block marks an actual handoff, and final `usage.iterations` records requested-model attempts as `message` and fallback-served attempts as `fallback_message`.

Sticky-served follow-up turns have no `fallback` boundary because no new refusal occurred. They remain distinguishable: the top-level model is the fallback model and `usage.iterations` contains `fallback_message` without a requested-model `message` attempt. A return to the selected model is likewise observable when the top-level model matches the requested model and no `fallback_message` served the response.

## Current plugin behavior

The OpenCode plugin does not opt into Anthropic's server-side fallback beta. Its local recovery path instead:

1. Detects any `stop_reason: "refusal"` from Fable 5 or Opus 5 without reading a refusal category.
2. Rewrites both source models to `claude-opus-4-8`.
3. Keeps the session on Opus 4.8 for ten successful responses before probing the source model again.

That behavior predates the documented Fable 5 → Opus 5 biology route. It is now demonstrably wrong for a Fable biology refusal and does not match Anthropic's category-aware routing. Its deterministic ten-successful-response recovery window also differs from Anthropic's best-effort, approximately one-hour sticky route.

## Recommended direction

Do not merely change the local constant from Opus 4.8 to Opus 5. That would make Fable biology refusals correct while remaining wrong for Fable categories whose allowed/default target is Opus 4.8, and it would retain the unsupported ten-turn pinning heuristic.

The durable implementation is to adopt Anthropic's server-side `fallbacks: "default"` behavior and normalize its response protocol for the host:

1. Add the server-side fallback beta and request field for supported OAuth model requests.
2. Handle the API's `fallback` content block while preserving its exact position in assistant history, as required for later thinking-block validation.
3. Preserve tool-name rewriting, streaming, usage accounting (including fallback iterations), and continuation semantics.
4. Drive sidebar and Desktop state from the serving model and final `usage.iterations`, distinguishing a new handoff, a sticky-served turn, a return to the selected model, and a final refusal.
5. Keep the local ten-turn recovery implementation behind an explicit rollback mode until the server-side path is proven end to end.

OpenCode's current Anthropic protocol implementation does not define a `fallback` content block or `stop_details`, so passing the beta response through unchanged is not sufficient. The plugin must normalize the stream into a host-supported representation that round-trips the boundary back to Anthropic at the same content position. Merely dropping the block is invalid, particularly when thinking blocks occur on both sides of a mid-output handoff.
