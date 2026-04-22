# Plan 06-03 Summary: Eval Runner Dedup Cosine Reporting

**Executed:** 2026-04-21
**Status:** Complete

## What Was Built

Extended `evals/run-eval.ts` with a dedup cosine score validation section that:

1. Reads `cross_source_pair_id` from `labeled-posts.json` entries (via the new optional field on `LabeledPost`)
2. Groups entries by `cross_source_pair_id` and filters to pairs with exactly 2 members
3. Embeds each pair member's title+body text via Voyage AI (`voyage-2`, 1024-dim) using the new `embedTextForEval` helper
4. Computes cosine similarity between each pair using the new `cosineSimilarity` helper (with full normalization — Voyage embeddings are not pre-normalized)
5. Prints a per-pair table with pair ID, source A, source B, cosine score, threshold, and ABOVE/BELOW result
6. Prints a dedup summary block with total pairs, above/below counts, and threshold value
7. Warns if any pairs score below the threshold (advisory only — does not affect exit code)
8. Gracefully skips the entire section with a SKIP warning if `VOYAGE_API_KEY` is not set

The `DEDUP_THRESHOLD` (0.85) is inlined with a comment referencing `EMBEDDING_SIMILARITY_THRESHOLD` in `apps/worker/src/config.ts` — config.ts was not imported to avoid `getEnvOrThrow` side effects at module load time.

The Tier 2 deferral NOTE comment was also updated to reflect that the eval runner now handles both Tier 1 classification and dedup cosine validation.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | ff7f2b6 | feat(06-03): add cross_source_pair_id to LabeledPost interface |
| 2 | 126fcda | feat(06-03): add cosineSimilarity and embedTextForEval helper functions |
| 3 | a1aaa06 | feat(06-03): add dedup cosine score reporting section to eval runner |

## Self-Check

PASSED

- `cross_source_pair_id?: string` present in `LabeledPost` interface
- `cosineSimilarity` and `embedTextForEval` functions defined and used
- Dedup section inserts between confusion matrix output and accuracy threshold gate
- `DEDUP_THRESHOLD = 0.85` inlined with comment referencing config.ts
- `VOYAGE_API_KEY` absence handled with SKIP warning (no crash)
- Exit code unchanged — dedup section is advisory only
- `process.exit` count is 4, unchanged from the original file (the plan's criteria of 3 omitted the pre-existing `main().catch` handler; no new `process.exit` calls were added)
- NOTE comment updated from Phase 6 deferral to current state

## Deviations

The plan's acceptance criterion `grep -c "process.exit" evals/run-eval.ts` expects `3`, but the original file already had `4` (ANTHROPIC_API_KEY guard, accuracy fail, accuracy pass, plus the `main().catch` handler). No new `process.exit` calls were introduced — the count is identical to the pre-task baseline. This is a counting discrepancy in the plan specification, not a deviation from intent.
