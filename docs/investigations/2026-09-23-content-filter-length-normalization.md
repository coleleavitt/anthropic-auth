# Content-filter length normalization: measured against real refusals (2026-09-23)

## Question

`scoreText` in `packages/core/src/content-filter.ts` divides each category
score by `sqrt(max(1, len / 1000))`. The concern: large contexts get
under-scored, while Anthropic's pre-inference gate appears to react to
accumulated context. Should the normalization change?

## Method

`scripts/eval-content-filter.ts` joins request dumps
(`$TMPDIR/opencode-anthropic-auth-dumps`) to `~/.prime/agent/refusal-events.jsonl`.
A dump is labelled refused when a refusal for the same session and model
follows it within 15 minutes. Contrast set: every other dump from the same
sessions. The script reports ROC AUC pooled and within-session. Within-session
is the fair test, because six sessions hold all refusals.

Run on 2026-09-23: 798 requests, 6 sessions, 24 refused.

| Feature | Pooled AUC | Within-session AUC |
|---|---|---|
| shipped sqrt normalization | 0.485 | 0.221 |
| no normalization | 0.485 | 0.227 |
| log normalization | 0.493 | 0.243 |
| per-block max (what the filter acts on) | 0.612 | 0.414 |
| summed per-block raw totals | 0.514 | 0.260 |
| body length | 0.659 | 0.766 |

A second analysis used only the dump *tail* (the bytes changed since the
previous request in the session). For small tails (under 5 KB, 219 requests,
12 refused), refused tails were *shorter* than accepted ones (AUC 0.26). Their
vocabulary was only weakly elevated (bio terms AUC 0.61, all terms 0.58).

## Findings

1. No normalization choice gives a useful signal. Sqrt, none, and log differ
   by at most 0.02 AUC. Within one session, all three rank refused requests
   *below* accepted ones.
2. Body length is the strongest single predictor (0.77 within-session).
   Refusals come late in long sessions.
3. Refusals often follow a tiny new tail on a prefix that was accepted one
   turn earlier. So the gate reacts to the accumulated context, or it has a
   random element near its threshold. Usually the new content is not the
   trigger.
4. Caveat: dumps are recorded after the filter. The scores measure what was
   sent, not what the host wanted to send. `content-filter-outcomes.jsonl`
   (added with this change) records pre-filter scores for every request. Use
   it to repeat this analysis without that bias.

## Decision

Keep the shipped normalization. Changing it is not supported by the data. It
would also change which history blocks get rewritten. That changes their
bytes and invalidates the prompt cache for every long session on the turn the
change ships. The filter stays block-local and deterministic.

Accumulation is tracked instead of acted on: `ContentFilterSummary.rawTotals`
(per-category sums before normalization, across all blocks) and
`charsScanned` are now in every outcome record. `scripts/refusal-ingest.ts
--report` shows refusal rate by filter action and score band. Revisit once
the outcome log holds a few hundred refusals.

## Reproduce

```sh
bun scripts/eval-content-filter.ts          # AUC table
bun scripts/refusal-ingest.ts --report      # ingest + efficacy + learned candidates
```
