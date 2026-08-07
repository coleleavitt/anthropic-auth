# Anthropic server-side safety fallbacks

Date: 2026-08-07

## Sources

- Anthropic, [Improving Fable 5's biology safeguards](https://www.anthropic.com/news/improving-fable-5-s-biology-safeguards)
- Anthropic, [Introducing Claude Opus 5](https://www.anthropic.com/news/claude-opus-5)
- Anthropic Platform, [Stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons#server-side-fallback)
- Live Anthropic Models and Messages APIs queried with the `server-side-fallback-2026-07-01` beta on 2026-08-07

## Findings

Anthropic's safety fallback is not a universal model ladder. Routing is conditioned on the classifier category and source model:

- A Fable 5 request flagged by the biology safeguard is routed to Opus 5 in Anthropic's first-party products, including Claude Code.
- An Opus 5 request flagged by the cybersecurity safeguard is routed to Opus 4.8 in Anthropic's first-party products.
- The API supports the same mechanism as an opt-in beta by sending `fallbacks: "default"` with `anthropic-beta: server-side-fallback-2026-07-01`.
- Anthropic recommends `default` routing because the category-specific routes can change. The default route table is not a stable public mapping that clients should duplicate.
- Each request is evaluated independently. This is not equivalent to pinning a conversation to a fallback model for a fixed number of later turns.

The live Models API currently reports:

| Requested model | Allowed fallback models |
| --- | --- |
| `claude-fable-5` | `claude-opus-4-8`, `claude-opus-5` |
| `claude-opus-5` | `claude-opus-4-8` |
| `claude-opus-4-8` | none |

This confirms a routing graph rather than a fixed Fable → Opus 5 → Opus 4.8 chain. Fable can legally route to either Opus model; Anthropic chooses the target according to the safety category. The two launch articles publicly identify Fable-biology → Opus 5 and Opus-5-cybersecurity → Opus 4.8.

A live OAuth Messages request to `claude-fable-5` with `fallbacks: "default"` and the beta header returned HTTP 200. The non-refused response stayed on Fable 5 and exposed the beta response additions `stop_details: null` and `usage.iterations`. This proves that the OAuth Messages path accepts the beta request shape; it does not yet prove the on-wire shape of an actual fallback response.

## Current plugin behavior

The OpenCode plugin does not opt into Anthropic's server-side fallback beta. Its local recovery path instead:

1. Detects any `stop_reason: "refusal"` from Fable 5 or Opus 5 without reading a refusal category.
2. Rewrites both source models to `claude-opus-4-8`.
3. Keeps the session on Opus 4.8 for ten successful responses before probing the source model again.

That behavior predates the documented Fable 5 → Opus 5 biology route. It is now demonstrably wrong for a Fable biology refusal and does not match Anthropic's per-request, category-aware design.

## Recommended direction

Do not merely change the local constant from Opus 4.8 to Opus 5. That would make Fable biology refusals correct while remaining wrong for Fable categories whose allowed/default target is Opus 4.8, and it would retain the unsupported ten-turn pinning heuristic.

The durable implementation is to adopt Anthropic's server-side `fallbacks: "default"` behavior and normalize its response protocol for the host:

1. Add the server-side fallback beta and request field for supported OAuth model requests.
2. Handle the API's `fallback` content block, preserving the original refusal metadata and exposing the nested fallback assistant content to OpenCode.
3. Preserve tool-name rewriting, streaming, usage accounting (including fallback iterations), and continuation semantics.
4. Remove the local ten-turn recovery state, source-model prewarm chain, standby bridge, and transition notices once the server-side path is proven end to end.

OpenCode's current Anthropic protocol implementation does not define a `fallback` content block or `stop_details`, so passing the beta response through unchanged is not sufficient. The plugin must either normalize the stream into the host's existing Anthropic event shape or wait for native host support. This protocol compatibility should be proven with a real refusal response before replacing the existing recovery path.
