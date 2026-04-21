# Roadmap: Free Offers Monitor

**Created:** 2026-04-20
**Granularity:** Coarse
**Phases:** 4
**Requirements:** 33

## Phase 1: DB Foundation & Shared Package

**Goal:** Stand up the Supabase database with all extensions, tables, indexes, and queues, and export a typed shared client that all other packages depend on.
**Requirements:** DB-01, DB-02, DB-03, DB-04
**Depends on:** None
**UI hint:** no

### Success Criteria

1. Running `pnpm db:generate` produces fresh TypeScript types that match the live schema with no manual edits needed.
2. Worker startup (even a bare health-check script) exits 0 and logs confirmation that pgvector, pgmq, and pg_cron extensions are present.
3. Both pgmq queues (`tier1_queue`, `tier2_queue`) exist and can receive and archive a test message without error.

### Plans

1. DB Setup — enable extensions, apply schema.sql with all 7 tables and indexes, create pgmq queues, export typed `createClient()` from `@repo/db`

---

## Phase 2: Worker Pipeline — Ingestion, Classification, Dedup & Logging

**Goal:** Implement the full end-to-end worker pipeline from Reddit ingestion through Tier 0 keyword filtering, Tier 1 Haiku classification, Tier 2 Sonnet extraction with deduplication, and AI call logging.
**Requirements:** ING-01, ING-02, ING-03, ING-04, ING-05, CLS-01, CLS-02, CLS-03, CLS-04, CLS-05, CLS-06, DDP-01, DDP-02, DDP-03, DDP-04, LOG-01, LOG-02, WRK-01, WRK-02, WRK-03
**Depends on:** Phase 1
**UI hint:** no

### Success Criteria

1. Pointing the worker at a live subreddit populates the `posts` table within one poll cycle, with `tier0_passed` correctly set and rate-limit events appearing in logs when backoff fires.
2. A post that passes Tier 0 produces a row in `ai_calls` for the Haiku call and, if it passes Tier 1, a second row for the Sonnet call — both with non-null `input_tokens`, `cost`, `latency_ms`, and `prompt_version`.
3. Submitting a duplicate URL through the pipeline does not create a second offer row — it links to the existing one via URL hash match or cosine similarity fallback.
4. A Tier 2 result with `confidence < 0.7` appears in `human_review_queue` and does not appear in the `offers` table.
5. Killing and restarting the worker does not re-process already-archived pgmq messages.

### Plans

1. Ingestion & Tier 0 — `SourceAdapter` interface, Reddit adapter (snoowrap OAuth), comment extraction, bot/deleted guards, posts table write, Tier 0 inline keyword filter, enqueue to `tier1_queue`
2. Tier 1 — pgmq consumer scaffold (read + archive pattern), Haiku binary classifier, `posts.tier1_result` JSONB write, `ai_calls` logging, enqueue passes to `tier2_queue`
3. Tier 2, Dedup & Logging — Sonnet structured extractor with forced tool use, Zod validation, exclusion checks, URL normalization + hash dedup, Voyage embedding cosine dedup, `offers`/`post_offers` writes, low-confidence routing, DLQ and error handling, prompt versioning via git hash

---

## Phase 3: Offer Validation Cron

**Goal:** Implement the daily pg_cron validation job that checks active offer URL liveness and dead signals, requiring two consecutive failures before auto-expiring.
**Requirements:** VAL-01, VAL-02, VAL-03, VAL-04, VAL-05
**Depends on:** Phase 2
**UI hint:** no

### Success Criteria

1. An active offer with a dead URL transitions to `expired` only after two consecutive failed checks at least 24 hours apart — a single failure leaves it in an intermediate `check_failed` state.
2. A URL returning 403 or 429 is marked `check_failed`, not expired, and is retried on the next scheduled cycle.
3. All validation results — including successful liveness checks — produce rows in `verification_log` with timestamps and outcomes.

### Plans

1. Validation Cron — pg_cron daily trigger, HEAD/GET liveness check with WAF-safe 403/429 handling, Cheerio dead signal scan, two-check expiry rule, `verification_log` writes

---

## Phase 4: Dashboard

**Goal:** Build the auth-gated Next.js dashboard with offer list, human review queue, and AI call log viewer.
**Requirements:** DSH-01, DSH-02, DSH-03, DSH-04
**Depends on:** Phase 1, Phase 2
**UI hint:** yes

### Success Criteria

1. Visiting the dashboard without a session redirects to the login page; logging in with an email not on the allowlist is rejected.
2. The offer list renders paginated results and responds correctly to status filter and sort parameter changes via URL search params.
3. Approving a pending review item in the human review queue immediately moves it out of the queue and into the offer list as `active`; rejecting sets it to `expired`.
4. The AI call log viewer displays cost, latency, and prompt version for each logged call with no raw data errors.

### Plans

- [ ] 04-01-PLAN.md — Auth infrastructure, Supabase client factories, proxy.ts, login page, dashboard layout shell with sidebar and header
- [ ] 04-02-PLAN.md — Offer list (pagination/filter/sort), review queue (approve/reject server actions), AI call log viewer (sortable columns)

---

## Coverage

| Requirement | Phase |
|-------------|-------|
| DB-01 | 1 |
| DB-02 | 1 |
| DB-03 | 1 |
| DB-04 | 1 |
| ING-01 | 2 |
| ING-02 | 2 |
| ING-03 | 2 |
| ING-04 | 2 |
| ING-05 | 2 |
| CLS-01 | 2 |
| CLS-02 | 2 |
| CLS-03 | 2 |
| CLS-04 | 2 |
| CLS-05 | 2 |
| CLS-06 | 2 |
| DDP-01 | 2 |
| DDP-02 | 2 |
| DDP-03 | 2 |
| DDP-04 | 2 |
| VAL-01 | 3 |
| VAL-02 | 3 |
| VAL-03 | 3 |
| VAL-04 | 3 |
| VAL-05 | 3 |
| LOG-01 | 2 |
| LOG-02 | 2 |
| DSH-01 | 4 |
| DSH-02 | 4 |
| DSH-03 | 4 |
| DSH-04 | 4 |
| WRK-01 | 2 |
| WRK-02 | 2 |
| WRK-03 | 2 |

**Coverage:** 33/33 ✓
