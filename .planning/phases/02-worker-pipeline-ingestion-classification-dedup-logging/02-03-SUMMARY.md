---
phase: 2
plan: 3
status: complete
subsystem: tier2-dedup
tags: [sonnet, voyage, pgvector, dedup, tool-use]
key-files:
  created:
    - apps/worker/src/tiers/tier2.ts
    - apps/worker/src/dedup/url-hash.ts
    - apps/worker/src/dedup/embedding-dedup.ts
    - apps/worker/src/dedup/index.ts
    - prompts/tier2-extract.md
  modified:
    - packages/db/src/schema.sql
    - apps/worker/src/index.ts
    - apps/worker/package.json
metrics:
  tasks: 7/7
  commits: 8
  files_created: 5
  files_modified: 3
---

# Plan 02-03: Tier 2 Extraction, Dedup & Full Pipeline — Summary

## What Was Built

Tier 2 Sonnet extraction with forced `tool_choice: { type: 'tool', name: 'extract_offer' }`, Zod validation of tool output, exclusion checks (coupons, services, trials, sweepstakes, paid shipping), and low-confidence routing to `human_review_queue` at threshold < 0.7. The deduplication pipeline runs URL normalization (one-level redirect follow, Amazon ASIN canonicalization, normalize-url with UTM stripping, SHA-256 hash) as a first O(1) check, falling back to Voyage AI 1024-dim embeddings with pgvector cosine similarity >= 0.85 via the `find_similar_offer` PL/pgSQL function (which sets `ivfflat.probes = 10` internally). The worker entry point now runs three concurrent loops — Reddit ingestion, Tier 1 Haiku classifier, and Tier 2 Sonnet extractor — completing the end-to-end pipeline.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | e9652db | feat(02-03): write tier2-extract prompt for Sonnet extraction |
| Task 2 | 1351825 | feat(02-03): create Tier 2 Sonnet extraction handler with forced tool use and exclusion checks |
| Task 3 | 483ded4 | feat(02-03): create URL normalization and hash dedup module with Amazon canonicalization |
| Task 4 | 73368a6 | feat(02-03): create embedding dedup module using Voyage AI native fetch with 1024-dim assertion |
| Task 5 | 0b4b744 | feat(02-03): create dedup orchestrator with hash-first then embedding fallback and race-safe offer insert |
| Task 6 | 7279e85 | feat(02-03): add find_similar_offer SQL function with ivfflat.probes=10 to schema |
| Task 7 | d55f29b | feat(02-03): wire Tier 2 consumer into worker entry point completing three-loop pipeline |
| Fix   | 0dc4ca5 | fix(02-03): add missing dependencies to worker package.json and fix TypeScript type errors |

## Deviations

- **`EXTRACT_OFFER_TOOL as unknown as Anthropic.Tool`**: The `as const` on the tool definition makes `input_schema.required` a `readonly` tuple, which is incompatible with the SDK's mutable `string[]` type. Used `as unknown as Anthropic.Tool` cast to bridge the type gap. The runtime value is correct.
- **`@types/snoowrap` not installed**: The RESEARCH.md listed `@types/snoowrap@1.9.11` but that version does not exist on npm. Per CLAUDE.md, `@types/snoowrap` is a deprecated stub — snoowrap ships its own types — so it was intentionally omitted.
- **`packages/db` rebuild required**: The `dist/index.d.ts` was stale (missing `Relationships: []` on table types), causing supabase-js to type all `.from()` results as `never`. Fixed by running `pnpm build --filter @repo/db` to regenerate the dist.
- **Embedding failure non-blocking**: Per the threat model, Voyage API errors during embedding dedup are logged and caught, allowing the pipeline to continue to offer creation with a null embedding rather than failing the message.

## Self-Check

PASSED

All 9 grep-verifiable success criteria confirmed:
1. `tool_choice: { type: 'tool', name: 'extract_offer' }` and `stop_reason !== 'tool_use'` assertion present in tier2.ts
2. `extraction.confidence < 0.7` routes to `human_review_queue` in tier2.ts
3. `normalizeAndHash` exports `createHash('sha256')` in url-hash.ts
4. `findExistingOfferByHash` queries `destination_url_hash` in url-hash.ts
5. `embedding.length !== 1024` assertion and `EMBEDDING_SIMILARITY_THRESHOLD` (0.85) in embedding-dedup.ts
6. `findExistingOfferByHash` called before `embedText` in dedup/index.ts (lines 62 vs 80)
7. `find_similar_offer` function with `set_config('ivfflat.probes', '10', true)` in schema.sql
8. Conflict detection and re-query fallback pattern in dedup/index.ts
9. Three entries in `Promise.all` — Reddit, Tier 1, Tier 2 — in index.ts

Build verification:
- `pnpm check-types --filter worker` — PASSED (2 successful)
- `pnpm build --filter worker` — PASSED (42.89 KB ESM bundle)
- `pnpm build` (full monorepo) — PASSED (3 successful, FULL TURBO)
