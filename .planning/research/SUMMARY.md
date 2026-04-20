# Research Summary

**Project:** Free Offers Monitor
**Synthesized:** 2026-04-20

---

## Key Findings

### Stack

- **Monorepo foundation**: pnpm 10.33.0 workspaces + Turborepo 2.9.6 with remote cache; Node.js 22 LTS on the worker (native fetch, `--env-file`, `crypto.hash()`), Next.js 16 App Router on the dashboard.
- **Database layer**: Supabase JS 2.104.0 is the sole data client — pgvector (`vector(1024)`) for semantic dedup, pgmq for Postgres-native queuing, pg_cron for validation scheduling. All three extensions must be `CREATE EXTENSION`-ed manually before any migration runs.
- **AI**: `@anthropic-ai/sdk` 0.90.0 directly — Haiku for Tier 1, Sonnet for Tier 2 with `tool_choice: { type: 'tool' }` forced. No LangChain, no Vercel AI SDK. Every call logs to `ai_calls` with tokens, cost, latency, and git-hash prompt version.
- **Embeddings**: Voyage AI (`voyageai` 0.2.1) produces 1024-dim vectors; the pgvector column is hard-typed to `vector(1024)`. Do not mix providers — a migration is required to change dimensions.
- **Prohibited libraries**: LangChain, Vercel AI SDK, Prisma, Drizzle, BullMQ, node-cron, next-auth, OpenAI SDK — all excluded by explicit project policy.

### Table Stakes Features

**Ingestion**
- Reddit polling via snoowrap with OAuth (100 req/min); cursor stored as `sources.last_polled_at`
- Comment extraction: top-level + one reply deep only; skip AutoModerator, bot accounts, deleted/removed content
- Rate limit logging to Axiom when snoowrap backoff fires

**Classification Pipeline**
- Tier 0: inline keyword filter before any queue enqueue; rejects stored with `tier0_passed=false`; never auto-modified
- Tier 1: pgmq consumer, Haiku binary classifier, result written as JSONB to `posts.tier1_result`; every call logged to `ai_calls`
- Tier 2: pgmq consumer, Sonnet structured extractor with forced tool use; exclusion checks (no coupons, no services, non-zero shipping, no trials, no sweepstakes); confidence < 0.7 routes to `human_review_queue`

**Deduplication**
- URL hash dedup: normalize (strip UTM) + follow one redirect level + sha256 hash → exact match on `offers.destination_url_hash`
- Embedding dedup: Voyage 1024-dim cosine similarity via pgvector `<=>`, threshold 0.85; only runs when URL hash misses
- pgvector session must set `SET ivfflat.probes = 10` before cosine queries

**Offer Management**
- Status tracking: `active | expired | unverified | review_pending`
- URL liveness checks (HEAD with GET fallback) + dead signal detection (Cheerio keyword scan)
- Daily pg_cron validation; requires two consecutive failed checks before auto-expiry

**Dashboard**
- Supabase Auth email allowlist (enforced at auth hook level, not app code)
- Offer list with filtering/sorting via URL search params
- Human review queue: approve → `active`, reject → `expired`, with reviewer identity and timestamp
- AI call log viewer (cost, latency, prompt version)

**Logging**
- Every Tier 1/2 AI call writes to `ai_calls` (model, prompt_version git hash, input/output tokens, cost, latency ms, post_id) — hard requirement with no exceptions

### Architecture

**Component boundaries:**
- `apps/worker` (Railway) owns the entire pipeline — ingestion, all tiers, dedup, validation cron, `ai_calls` logging. No HTTP endpoints in production.
- `apps/dashboard` (Vercel) is read-heavy; writes only for human review approve/reject actions. No pipeline logic, no direct Voyage/Anthropic calls.
- `packages/db` (`@repo/db`) is the shared data layer: `schema.sql`, generated `types.ts`, `client.ts` exporting `createClient()`. No application logic lives here.

**Data flow:**
1. Ingestion loop polls Reddit → writes `posts` table → Tier 0 inline filter
2. Tier 0 pass → enqueue `tier1_queue` → Haiku classify → enqueue `tier2_queue`
3. Tier 2 → exclusion check → dedup (URL hash → cosine fallback) → write `offers` + `post_offers`, or link to existing offer
4. Low-confidence Tier 2 → `human_review_queue` instead of `offers`
5. pg_cron daily → validation worker → URL liveness + dead signals → update `offers.status` + `verification_log`

**pgmq message lifecycle:** `archive()` must be called in a `finally` block after every message is processed (success or structured failure). Unarchived messages re-deliver after the visibility timeout.

**Build order:** `packages/db` → worker ingestion + Tier 0 → Tier 1 → Tier 2 + dedup → validation cron → dashboard (can parallel with validation once schema is stable) → evals + hardening.

### Critical Pitfalls

1. **pgmq re-delivery**: Forgetting `archive()` on any code path (including error paths) causes duplicate AI calls and duplicate offers. Use `finally` blocks; log `msg_id` in every tier call.
2. **pgvector extension order**: `CREATE EXTENSION vector` must run before any migration referencing the `vector` type. Add a worker startup assertion checking `pg_extension` for all three required extensions.
3. **normalize-url does not follow redirects**: Link shorteners (`bit.ly`, `amzn.to`) and affiliate URLs will produce different hashes for the same destination. Always perform a one-level HEAD redirect follow before hashing; normalize Amazon URLs to canonical ASIN form.
4. **Forced tool use on Tier 2**: Set `tool_choice: { type: 'tool', name: 'extract_offer' }` — never rely on `auto`. Assert `stop_reason === 'tool_use'` before accessing the response; validate tool arguments with Zod before any DB insert.
5. **snoowrap incomplete types + silent auth failures**: Pin to exact snoowrap version (no `^`); define `RawRedditPost`/`RawRedditComment` types in `@repo/db` and cast once at the adapter boundary. Hook `r.on('tokenRefreshed', ...)` and call `r.getMe()` at startup to detect silent credential failures.
6. **ivfflat probes default**: `probes=1` (default) dramatically cuts recall. Always `SET ivfflat.probes = 10` in the session before running cosine dedup queries. Rebuild index with `ANALYZE offers` after bulk inserts.
7. **Validation WAF blocks masking live offers**: 403/429 responses from brand CDNs must not trigger offer expiry. Mark as `check_failed` and retry in 6 hours; require two consecutive failures 24 hours apart before marking `dead`.

---

## Recommended Build Order

1. **Phase 1 — DB foundation** (`packages/db`): Run `CREATE EXTENSION` for vector, pgmq, pg_cron; apply `schema.sql`; create pgmq queues; export `createClient()` and TypeScript types. Nothing else can start without this.
2. **Phase 2 — Worker ingestion + Tier 0**: `SourceAdapter` interface, Reddit adapter (snoowrap), Tier 0 inline keyword filter, write `posts` table, enqueue to `tier1_queue`. Include bot/deleted-post guards and rate-limit logging.
3. **Phase 3 — Tier 1 (Haiku classifier)**: pgmq consumer scaffolding (read + archive pattern), Haiku binary classification, write `posts.tier1_result`, log to `ai_calls`, enqueue Tier 1 passes to `tier2_queue`.
4. **Phase 4 — Tier 2 + dedup (Sonnet extractor)**: Sonnet structured extractor with forced tool use, exclusion checks, Zod validation of tool output, URL normalization + hash dedup, Voyage embedding + pgvector cosine dedup, write `offers`/`post_offers`, route low-confidence to `human_review_queue`.
5. **Phase 5 — Validation cron**: pg_cron trigger, URL liveness (HEAD/GET), Cheerio dead signal scan, jitter-based scheduling, two-check rule before expiry, `verification_log` writes.
6. **Phase 6 — Dashboard**: Supabase Auth gate, offer list (paginated, filterable), human review queue (approve/reject), AI call log viewer, keyword suggestion surface (read-only).
7. **Phase 7 — Evals + hardening**: `evals/labeled-posts.json`, `pnpm eval` script, prompt versioning wired to git hash, Axiom structured logging, Railway + Vercel environment wiring, DLQ depth monitoring.

---

## Risk Matrix

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| pgmq message re-delivery causing duplicate AI calls and offers | HIGH | HIGH (easy to miss in error paths) | `archive()` in `finally`; idempotency check on `posts.pipeline_status` before processing |
| pgvector `CREATE EXTENSION` not run before migration | HIGH | MEDIUM (fresh environments only) | Worker startup assertion; schema.sql preamble comment; `IF NOT EXISTS` guard |
| normalize-url missing redirect → URL hash dedup fails for short links | HIGH | HIGH (very common in Reddit posts) | One-level HEAD redirect follow before normalizing; Amazon ASIN canonicalization |
| Tier 2 tool use not forced → free-text response breaks parser | HIGH | MEDIUM (model-dependent) | `tool_choice: { type: 'tool' }`; assert `stop_reason`; Zod schema validation before DB insert |
| Voyage embedding dimension mismatch crashing inserts | HIGH | LOW (only if model changes) | Pin `voyage-2` explicitly; assert `embedding.length === 1024` in TypeScript before insert |
| Validation WAF blocks incorrectly expiring live offers | MEDIUM | MEDIUM (common on brand sites) | Never expire on 403/429; two-check rule 24h apart; `check_failed` intermediate status |
| snoowrap OAuth token refresh silently failing | MEDIUM | MEDIUM (happens after ~1 hour) | `r.on('tokenRefreshed')` hook; `r.getMe()` health check at startup; store refresh token in Vault |
| Cosine threshold 0.85 too loose/tight → false dedup or duplicates flooding dashboard | MEDIUM | MEDIUM (requires labeled data to tune) | Validate against `evals/labeled-posts.json` before launch; log every cosine decision with score |
| DLQ accumulation with no alerting → pipeline looks healthy but produces no offers | MEDIUM | LOW (requires a parsing regression) | pg_cron DLQ depth check every 15 min; alert threshold at 500 rows; expose on dashboard |
| Prompt drift after edit → `ai_calls.prompt_version` inconsistent | MEDIUM | MEDIUM (common during iteration) | Compute git hash once at worker startup; cache prompts in memory; eval gate before merging prompt changes |

---

## Research Confidence

| Dimension | Confidence | Notes |
|-----------|------------|-------|
| Stack | HIGH | Already decided by project owner; versions pinned and verified |
| Features | HIGH | Well-defined in project spec; anti-features explicitly scoped out |
| Architecture | HIGH | Standard patterns for this domain; component boundaries and DB schema fully specified |
| Pitfalls | MEDIUM | Domain-specific; several (cosine threshold, WAF behavior, snoowrap edge cases) require runtime validation against real data to fully characterize |
