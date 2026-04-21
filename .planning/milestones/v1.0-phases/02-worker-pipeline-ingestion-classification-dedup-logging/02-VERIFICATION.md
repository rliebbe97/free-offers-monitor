---
status: passed
phase: 02
verified: 2026-04-20
score: 20/20
---

# Phase 2: Worker Pipeline — Verification

## Must-Haves Check

| # | Must-Have | Status | Evidence |
|---|----------|--------|----------|
| 1 | SourceAdapter interface with `fetchNewPosts(since: Date): Promise<RawPost[]>` | ✓ | `apps/worker/src/ingestion/source-adapter.ts` lines 5–19: interface exported with exact signature |
| 2 | snoowrap OAuth polling with rate limit logging | ✓ | `reddit-adapter.ts` lines 33–58: `createRedditClient()` with refresh token OAuth; rate limit log when `ratelimitRemaining < 10` |
| 3 | Top-level comments + one reply deep, skip AutoModerator/bots | ✓ | `reddit-adapter.ts` lines 71–205: two-level comment traversal; `shouldSkipAuthor` applied at each level; MoreComments stubs skipped by `constructor.name` check |
| 4 | Deleted/removed detection via `shouldSkipAuthor` | ✓ | `reddit-adapter.ts` lines 18–31: `shouldSkipAuthor` checks null author, bot name patterns, `[deleted]`/`[removed]` body, `distinguished === 'moderator'` |
| 5 | Posts written with UNIQUE(source_id, external_id) upsert | ✓ | `ingest.ts` line 81: `.upsert(..., { onConflict: 'source_id,external_id' })` |
| 6 | Tier 0 keyword filter inline during ingestion; rejected posts stored with `tier0_passed=false` | ✓ | `ingest.ts` lines 105–130: `passesKeywordFilter` called after upsert; sets `tier0_passed=true/false` and `pipeline_status='tier0_passed'/'tier0_rejected'` |
| 7 | Tier 1 pgmq consumer with Haiku; result stored as JSONB `{decision, confidence, reason, prompt_version}` | ✓ | `tier1.ts` lines 128–286: calls Haiku, stores `tier1_result` JSONB with all four fields; `Tier1ResultSchema` includes `prompt_version: z.string()` |
| 8 | Every AI call logged to `ai_calls` (success and failure) | ✓ | `tier1.ts`: `logAiCall` on 4 code paths; `tier2.ts`: equivalent `logAiCall` on all paths including API error, stop_reason failure, Zod failure, success |
| 9 | Prompts read from `prompts/` dir at startup, versioned with git hash | ✓ | `index.ts` lines 170–181: `readFileSync` at startup; `computePromptVersion()` tries `RAILWAY_GIT_COMMIT_SHA` then `git rev-parse --short HEAD` |
| 10 | Tier 2 Sonnet with forced tool use (`tool_choice: { type: 'tool', name: 'extract_offer' }`) | ✓ | `tier2.ts` line 196: `tool_choice: { type: 'tool', name: 'extract_offer' }`; line 246 asserts `stop_reason === 'tool_use'` |
| 11 | Exclusion checks (coupons, services, shipping, trials, sweepstakes) | ✓ | `tier2.ts` lines 389–428: `is_excluded === true` OR `shipping_cost > 0` → `tier2_excluded`; `tier1-classify.md` lists all exclusion types |
| 12 | Tier 2 confidence < 0.7 routes to `human_review_queue`, not auto-published | ✓ | `tier2.ts` line 428: `if (extraction.confidence < 0.7)` inserts into `human_review_queue` and sets `pipeline_status='review_queued'` |
| 13 | Zod validation of tool output before any DB insert | ✓ | `tier2.ts` line 290: `OfferExtractionSchema.safeParse(toolBlock.input)` before any write |
| 14 | URL normalization strips UTM + follows one redirect + SHA-256 hash | ✓ | `url-hash.ts`: `followOneRedirect` with 5s timeout; `normalizeUrl` with `removeQueryParameters: [/^utm_/i, ...]`; `createHash('sha256')` |
| 15 | Hash match checks `offers.destination_url_hash` before creating new offer | ✓ | `dedup/index.ts` line 62: `findExistingOfferByHash` called first; embedding check only on hash miss (line 74+) |
| 16 | Voyage embedding cosine >= 0.85 via pgvector; 1024-dim assertion | ✓ | `embedding-dedup.ts` lines 32–33: asserts `embedding.length !== 1024`; threshold defaults to `EMBEDDING_SIMILARITY_THRESHOLD` (0.85) |
| 17 | `ivfflat.probes = 10` set in `find_similar_offer` SQL function | ✓ | `schema.sql` line 185: `PERFORM set_config('ivfflat.probes', '10', true)` inside function |
| 18 | pgmq `archive()` called in `finally` blocks on all code paths | ✓ | `consumer.ts` lines 110–139: `shouldArchive` flag pattern; `pgmq_archive` RPC called in `finally` when `shouldArchive === true` |
| 19 | Worker startup asserts required extensions (vector, pgmq, pg_cron) | ✓ | `index.ts` lines 44–64: `assertRequiredExtensions()` calls `check_required_extensions` RPC and throws if `vector`, `pgmq`, or `pg_cron` missing |
| 20 | DLQ routing for messages exceeding retry threshold; worker restart doesn't re-process archived messages | ✓ | `consumer.ts` line 116: `if (msg.read_ct >= DLQ_RETRY_THRESHOLD)` → `sendToDlq` then archive; archived messages are not re-delivered by pgmq |

## Requirements Traceability

| REQ-ID | Description | Status | Evidence |
|--------|-------------|--------|----------|
| ING-01 | SourceAdapter interface with `fetchNewPosts` | ✓ | `apps/worker/src/ingestion/source-adapter.ts` — interface and RawPost type exported |
| ING-02 | snoowrap OAuth polling with rate limit logging | ✓ | `reddit-adapter.ts` — refresh token OAuth; rate limit warn at `ratelimitRemaining < 10` |
| ING-03 | Top-level comments + one reply deep, skip AutoModerator + bots | ✓ | `reddit-adapter.ts` — two-level traversal with `shouldSkipAuthor` guard and MoreComments skip |
| ING-04 | Deleted/removed detection and exclusion | ✓ | `shouldSkipAuthor` checks `[deleted]`/`[removed]`/null author at adapter boundary |
| ING-05 | `posts` table written with `UNIQUE(source_id, external_id)` | ✓ | `ingest.ts` — `.upsert(..., { onConflict: 'source_id,external_id' })` |
| CLS-01 | Tier 0 keyword filter inline; rejects stored with `tier0_passed=false` | ✓ | `tier0.ts` exports `passesKeywordFilter`; `ingest.ts` sets `tier0_passed` + `pipeline_status` on every post |
| CLS-02 | Tier 1 Haiku consumer; result JSONB `{decision, confidence, reason, prompt_version}` | ✓ | `tier1.ts` + `schemas.ts` `Tier1ResultSchema` with `prompt_version: z.string()` |
| CLS-03 | Tier 2 Sonnet with forced `tool_choice: { type: 'tool' }` | ✓ | `tier2.ts` line 196: `tool_choice: { type: 'tool', name: 'extract_offer' }` |
| CLS-04 | Tier 2 exclusion checks (coupons, services, shipping, trials, sweepstakes) | ✓ | `tier2.ts` lines 389–410: `is_excluded` and `shipping_cost > 0` checks; exclusions listed in `tier2-extract.md` |
| CLS-05 | Confidence < 0.7 routes to `human_review_queue` | ✓ | `tier2.ts` line 428: explicit confidence threshold check → `human_review_queue` insert |
| CLS-06 | Tier 2 tool output validated with Zod before DB insert | ✓ | `tier2.ts` line 290: `OfferExtractionSchema.safeParse(toolBlock.input)` |
| DDP-01 | URL normalization strips UTM, follows one redirect, SHA-256 hash | ✓ | `url-hash.ts`: `followOneRedirect` + `normalizeUrl` + `createHash('sha256')` |
| DDP-02 | Hash match checks `offers.destination_url_hash` first | ✓ | `dedup/index.ts` line 62: `findExistingOfferByHash` runs before embedding lookup |
| DDP-03 | Voyage embedding cosine >= 0.85 via pgvector as fallback | ✓ | `embedding-dedup.ts`: 1024-dim assertion, `EMBEDDING_SIMILARITY_THRESHOLD = 0.85`; only runs on hash miss |
| DDP-04 | `ivfflat.probes = 10` set in session for pgvector queries | ✓ | `schema.sql`: `set_config('ivfflat.probes', '10', true)` inside `find_similar_offer` function |
| LOG-01 | Every Tier 1 and Tier 2 call logs to `ai_calls` with model, prompt_version, tokens, cost, latency | ✓ | `tier1.ts` + `tier2.ts`: `logAiCall` called on all code paths (success, API error, parse error, Zod failure) |
| LOG-02 | Prompts in `prompts/` versioned with git hash at startup | ✓ | `index.ts`: `readFileSync` at startup; git hash from `RAILWAY_GIT_COMMIT_SHA` or `git rev-parse` |
| WRK-01 | pgmq consumers `archive()` in `finally` blocks | ✓ | `consumer.ts`: `shouldArchive` flag + `finally` block pattern |
| WRK-02 | Startup asserts required Postgres extensions | ✓ | `index.ts`: `assertRequiredExtensions()` validates `vector`, `pgmq`, `pg_cron` |
| WRK-03 | DLQ for messages exceeding retry threshold | ✓ | `consumer.ts`: `DLQ_RETRY_THRESHOLD = 3`; DLQ send before archive |

## Success Criteria

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Worker polls a subreddit and populates posts table with `tier0_passed` set | ✓ | `ingest.ts` sets `tier0_passed` (true/false) on every upserted post |
| 2 | Posts passing Tier 0 produce `ai_calls` rows for Haiku; if passing Tier 1, a Sonnet row — with tokens, cost, latency, prompt_version | ✓ | `tier1.ts` and `tier2.ts` both call `logAiCall` with all required fields on every invocation |
| 3 | Duplicate URLs don't create second offer rows — linked via hash or cosine | ✓ | `dedup/index.ts`: hash check first, embedding fallback; race-safe via error message detection + re-query |
| 4 | Tier 2 confidence < 0.7 goes to `human_review_queue`, not `offers` | ✓ | `tier2.ts` line 428: routes to `human_review_queue` and returns before dedup/offer creation |
| 5 | Worker restart doesn't re-process archived pgmq messages | ✓ | pgmq `archive()` moves messages out of the queue; `shouldArchive` pattern ensures archive on final attempt |

## Human Verification Items

The following items require a live environment to fully verify — they cannot be confirmed by static analysis alone:

1. **Reddit API integration**: `RedditAdapter.fetchNewPosts()` requires valid `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_REFRESH_TOKEN` to confirm OAuth succeeds and posts are fetched correctly.
2. **pgmq archive behaviour**: Confirm that after `pgmq_archive` is called, restarting the worker does not re-deliver the archived message. Requires a running Supabase instance.
3. **Voyage AI embeddings**: Confirm that `embedText` returns a 1024-dim vector in production against the real Voyage API with a valid `VOYAGE_API_KEY`.
4. **find_similar_offer SQL function**: Confirm the function is deployed to the Supabase project (schema.sql is the source of truth but manual deployment is required).
5. **End-to-end pipeline smoke test**: Submit a post matching Tier 0 keywords and confirm it flows through Tier 1 → Tier 2 → dedup → offer creation with `ai_calls` rows logged.
6. **DLQ routing after 3 retries**: Confirm that a message that throws 3 times ends up in `tier1_dlq`/`tier2_dlq` and is not re-delivered.

## Gaps

**Gap 1 (Minor): Offer insert race safety uses error-message detection instead of SQL `ON CONFLICT DO NOTHING`**

`dedup/index.ts` handles concurrent insert races by inspecting the Supabase error message for keywords `'duplicate'`/`'unique'`/`'conflict'` rather than using a declarative `ON CONFLICT (destination_url_hash) DO NOTHING` clause. The plan specified the latter. The current implementation is functionally equivalent but relies on string-matching Postgres error messages, which could be fragile if Supabase error formatting changes. This is a low-risk deviation (the re-query fallback is correct) but differs from the plan's acceptance criterion. Recommend adding an explicit Postgres `unique` constraint on `destination_url_hash` and using `.upsert()` with `onConflict: 'destination_url_hash', ignoreDuplicates: true` in a follow-up.

**No other gaps found.** All 20 requirements verified present with correct implementation patterns. All prompt files exist with the required exclusion criteria. No default exports. No `any` types in production code paths. All internal imports use `.js` extension (ESM). `snoowrap` pinned at exact `1.23.0`. `@types/snoowrap` absent. Three-loop `Promise.all` architecture confirmed.
