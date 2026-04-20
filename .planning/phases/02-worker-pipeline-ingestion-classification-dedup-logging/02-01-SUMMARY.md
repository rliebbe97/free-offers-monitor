---
phase: 2
plan: 1
status: complete
subsystem: ingestion
tags: [reddit, tier0, snoowrap, pgmq]
key-files:
  created:
    - apps/worker/src/ingestion/source-adapter.ts
    - apps/worker/src/ingestion/reddit-adapter.ts
    - apps/worker/src/ingestion/ingest.ts
    - apps/worker/src/tiers/tier0-keywords.ts
    - apps/worker/src/tiers/tier0.ts
    - apps/worker/src/queue/producer.ts
    - apps/worker/src/config.ts
    - apps/worker/src/logger.ts
    - apps/worker/src/index.ts
    - apps/worker/tsconfig.json
    - packages/db/tsconfig.json
  modified:
    - apps/worker/package.json
    - packages/db/src/types.ts
    - turbo.json
    - .env.example
metrics:
  tasks: 9/9
  commits: 10
  files_created: 11
  files_modified: 4
---

# Plan 02-01: Ingestion & Tier 0 — Summary

## What Was Built

Implemented the Reddit ingestion pipeline from scratch: a `SourceAdapter` interface with `RawPost` type, a `RedditAdapter` class using snoowrap OAuth with top-level comments + one reply deep traversal and full bot/deleted guard (`shouldSkipAuthor`), a Tier 0 keyword filter (`passesKeywordFilter`) over 25 hand-maintained terms, a pgmq producer for `tier1_queue`/`tier2_queue`, and an ingestion orchestrator (`runIngestionCycle`) that upserts posts with `UNIQUE(source_id, external_id)` conflict handling and sets `tier0_passed`/`pipeline_status` on every post. Supporting modules include a typed Axiom logger with graceful console-only fallback, a config module with pinned model strings and pricing constants, and the worker `package.json` updated with all Phase 2 dependencies.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 34c065b | update worker package.json with all Phase 2 dependencies |
| 2 | 0bc5f10 | create Axiom logger module with graceful degradation |
| 3 | ad6c641 | create worker config module with model constants and env validation |
| 4 | 82ee853 | create SourceAdapter interface and RawPost type |
| 5 | 00814f4 | create Reddit adapter with snoowrap OAuth, comment traversal, and bot guards |
| 6 | 723df23 | create Tier 0 keyword list and passesKeywordFilter function |
| 7 | 8a18f1d | create pgmq producer functions for tier1 and tier2 queues |
| 8 | 9eda472 | create ingestion orchestrator with Tier 0 inline filter and pgmq enqueue |
| 9 | 2f93c70 | fix SUPABASE_SERVICE_ROLE_KEY mismatch and add Axiom/PORT vars to .env.example |
| infra | 1710eca | add tsconfigs, stub index.ts, Relationships fields to DB types for supabase-js compat |

## Deviations

- Added `Relationships: []` field to all tables in `packages/db/src/types.ts` — required by `@supabase/postgrest-js@2.104` which defines `GenericTable` with a mandatory `Relationships` array. Without this, `.from('posts').upsert(...)` resolves the Insert type as `never`. This is consistent with what `pnpm db:generate` would produce from the live schema.
- Added pgmq RPC function types (`pgmq_send`, `pgmq_read`, `pgmq_archive`, `find_similar_offer`) to `packages/db/src/types.ts` — required for typed `db.rpc()` calls in producer.ts and future consumer/dedup files.
- Added `packages/db/tsconfig.json` to the worktree — it was present in the main repo but was an untracked file, so it was missing from the worktree at HEAD.
- Added a stub `apps/worker/src/index.ts` (empty re-export) so the tsup build target is valid; full implementation is in Plan 02-03.
- Added `dist/**` to turbo.json build outputs to correctly cache worker build artifacts.

## Self-Check

PASSED

- `pnpm --filter @repo/db build` succeeds
- `pnpm --filter worker check-types` passes with zero errors
- `pnpm --filter worker build` succeeds (produces dist/index.js)
- All 7 grep-verifiable success criteria from the plan confirmed:
  1. `fetchNewPosts` exported from reddit-adapter.ts ✓
  2. `passesKeywordFilter` exported from tier0.ts; ingestion sets `tier0_passed` on every post ✓
  3. `enqueueTier1` calls `pgmq_send` with `queue_name: 'tier1_queue'` ✓
  4. `.env.example` uses `SUPABASE_SERVICE_ROLE_KEY` ✓
  5. `logger.ts` imports from `@axiomhq/js` and exports `logger` object ✓
  6. `package.json` contains `"zod": "4.3.6"` and `"@axiomhq/js": "1.6.0"` ✓
  7. `ingest.ts` uses `.upsert()` with `onConflict: 'source_id,external_id'` ✓
