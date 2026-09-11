# Final Report: Pi Refusal and Cancellation Fix

## Completion status

The Anthropic refusal and cancellation investigation is complete. The implementation, regression tests, trace reconstruction, Claude Code artifact provenance, and validation evidence are committed and pushed to `fork/feat/shared-account-store-live-model-catalog`.

## Implemented fixes

Implementation commit: `6a3d441e2b179d1fe819880348546df2610d8abf`

- Pi opts eligible OAuth Fable 5 and Opus 5 requests into Anthropic server-side fallback with `fallbacks: "default"` and `server-side-fallback-2026-07-01`.
- Pi preserves and restores recognized fallback model boundaries.
- Terminal refusals preserve raw stop fields and emit `provider_stream_failure` with `details.kind: "refusal"`.
- Refusal text correctly states that preceding thinking/output is billed.
- A completed tool call followed by refusal terminates as `toolUse`, preserving the call instead of replaying it.
- Persistent WebSocket relay propagates `AbortSignal`, aborts without HTTP/direct fallback, closes fail-closed after dispatch, and identity-fences stale socket events.

OpenCode test-isolation commit: `8eae24c4a5db4d5fd45f3151c746884e4e00f9b0`

- `add-account-flows.test.ts` isolates both sidecar and canonical shared-store paths.
- The formerly failing full OpenCode suite now passes 1,254/1,254.

## Explicit refusal and tool-call regression gate

The final implementation includes and passes these focused cases:

1. refusal stop reason is surfaced with actionable billing text;
2. incident-shaped signed thinking plus nonzero-output refusal preserves usage and structured diagnostics;
3. server fallback boundary is persisted and restored on the next request;
4. a completed tool call followed by refusal is preserved and finishes as `toolUse`.

Command:

```bash
bun test packages/pi/src/tests/stream.test.ts \
  --test-name-pattern 'refusal|refuses|server fallback boundary'
```

Final result: **4 passed, 0 failed, 25 assertions**.

## Trace conclusion

Incident trace: `d2885faa3cb4f54c0e978dca367a6518`.

- Four HTTP-200 streams ended in `stop_reason: refusal`.
- The request used Opus 5 with a recognized 1M context window and the `context-1m-2025-08-07` beta.
- The 369, 404, and 194 billed output tokens in the final refusal chain were persisted as thinking, with no user-visible answer text.
- `Retry cancelled` came from Prime's local retry-delay abort path. Daemon request `worker_89` explicitly invoked `abort_retry` during the final 8-second delay.
- Model calls immediately after cancellation were not a revived retry. Their span topology and timing place them on the refinement/RAVO path.

Full trace table and span evidence: [`docs/investigations/2026-09-11-pi-refusal-retry-cancellation.md`](docs/investigations/2026-09-11-pi-refusal-retry-cancellation.md).

## Claude Code 2.1.268 provenance

Extracted artifact directory: `~/SiteResearch/anthropic/binaries/v268/`.

| Artifact | SHA-256 |
|---|---|
| npm tarball | `b423e6647c6843fcd802759440c5b3932f52aa04548abe427f3dc928c61a5485` |
| native binary | `9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653` |
| extracted raw CLI | `28334c28427ea288c2d681205c6a5a4cf90ea49597b2f405b1b4d801fa15ab6f` |
| deobfuscated CLI | `7c4f4fcb5484ae2cf15b709bb517d3b0c792d7cca61b1143f850479985bdadaf` |

The extracted binary establishes that:

- refusal is terminal unless explicit fallback policy is armed;
- refusal is not generic HTTP retry;
- default category fallback uses `fallbacks: "default"`;
- the category fallback beta is `server-side-fallback-2026-07-01`;
- `context-1m-2025-08-07` is a separate long-context feature;
- cancellation is separate abort control flow.

Exact chunks and byte offsets are recorded in the detailed investigation report.

## Final validation

The full post-implementation acceptance gate passed:

- Core: **414 passed, 0 failed**
- OpenCode: **1,254 passed, 0 failed**
- Pi: **130 passed, 0 failed**
- Explicit refusal/tool-call regressions: **4 passed, 0 failed**
- Workspace typecheck: passed
- Full build: passed
- Biome: passed
- `git diff --check`: passed
- Claude Code 2.1.268 SHA-256 checks: **4/4 passed**

Retained command summary: [`docs/investigations/2026-09-11-pi-refusal-validation.txt`](docs/investigations/2026-09-11-pi-refusal-validation.txt).
