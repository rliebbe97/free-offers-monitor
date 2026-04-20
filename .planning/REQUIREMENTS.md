# Requirements: Free Offers Monitor

**Defined:** 2026-04-20
**Core Value:** Reliably surface genuinely free physical goods from noisy forum data — false negatives cost missed offers, false positives erode trust.

## v1 Requirements

### Database & Infrastructure

- [ ] **DB-01**: Supabase Postgres with pgvector, pgmq, and pg_cron extensions enabled and verified at startup
- [ ] **DB-02**: Schema deployed with all 7 tables (sources, posts, offers, post_offers, verification_log, human_review_queue, ai_calls) and prescribed indexes
- [ ] **DB-03**: Shared `@repo/db` package exports typed Supabase client, generated types, and schema SQL
- [ ] **DB-04**: pgmq queues created (tier1_queue, tier2_queue) with appropriate visibility timeouts

### Ingestion

- [ ] **ING-01**: Reddit adapter implements `SourceAdapter` interface with `fetchNewPosts(since: Date): Promise<RawPost[]>`
- [ ] **ING-02**: snoowrap polls configured subreddits via OAuth with rate limit logging when backoff triggers
- [ ] **ING-03**: Ingestion extracts top-level comments and one reply deep, skipping AutoModerator and bot accounts
- [ ] **ING-04**: Deleted/removed posts and comments are detected and excluded before enqueuing
- [ ] **ING-05**: Ingestion writes to `posts` table with `UNIQUE(source_id, external_id)` enforced

### Classification

- [ ] **CLS-01**: Tier 0 keyword filter runs inline during ingestion with hand-maintained keyword list; rejects stored with `tier0_passed=false`
- [ ] **CLS-02**: Tier 1 pgmq consumer classifies posts using Haiku binary classifier; result stored as JSONB `{decision, confidence, reason, prompt_version}`
- [ ] **CLS-03**: Tier 2 pgmq consumer extracts structured offer entity using Sonnet with forced tool use (`tool_choice: { type: 'tool' }`)
- [ ] **CLS-04**: Tier 2 runs exclusion checks rejecting coupons, services, non-zero shipping, trials, and sweepstakes
- [ ] **CLS-05**: Tier 2 confidence < 0.7 routes to `human_review_queue` instead of auto-publishing
- [ ] **CLS-06**: Tier 2 tool output validated with Zod schema before any database insert

### Deduplication

- [ ] **DDP-01**: URL normalization strips UTM params and follows one redirect level before hashing with sha256
- [ ] **DDP-02**: Exact URL hash match checks `offers.destination_url_hash` before creating new offer
- [ ] **DDP-03**: When URL hash misses, Voyage embedding cosine similarity >= 0.85 via pgvector links to existing offer
- [ ] **DDP-04**: pgvector queries run with `ivfflat.probes = 10` set in session

### Validation

- [ ] **VAL-01**: pg_cron triggers daily validation checking each active offer weekly
- [ ] **VAL-02**: URL liveness check via HEAD with GET fallback; 403/429 responses treated as `check_failed`, not dead
- [ ] **VAL-03**: Cheerio-based dead signal detection scans page text for expiry indicators
- [ ] **VAL-04**: Two consecutive failed checks 24 hours apart required before auto-expiring an offer
- [ ] **VAL-05**: All validation results written to `verification_log`

### AI Logging

- [ ] **LOG-01**: Every Tier 1 and Tier 2 AI call logs to `ai_calls` table with model, prompt_version (git hash), input/output tokens, cost, latency_ms, and post_id
- [ ] **LOG-02**: Prompts live in `prompts/` as markdown files, versioned with git hash computed at worker startup

### Dashboard

- [ ] **DSH-01**: Supabase Auth with email allowlist gates all dashboard access
- [ ] **DSH-02**: Offer list page with pagination, filtering by status, and sorting
- [ ] **DSH-03**: Human review queue page showing pending offers with approve/reject actions that update offer status
- [ ] **DSH-04**: AI call log viewer showing cost, latency, and prompt version per call

### Worker Infrastructure

- [ ] **WRK-01**: pgmq consumers call `archive()` in `finally` blocks on all code paths
- [ ] **WRK-02**: Worker startup asserts all required Postgres extensions are enabled
- [ ] **WRK-03**: Structured error handling with dead letter queue for messages exceeding retry threshold

## v2 Requirements

### Extended Sources

- **SRC-01**: Discourse forum adapter implementing `SourceAdapter` interface
- **SRC-02**: Additional Reddit subreddit configuration via dashboard UI

### Notifications

- **NTF-01**: Email digest of new verified offers (daily/weekly configurable)
- **NTF-02**: Dashboard notification badge for new offers since last visit

### Analytics

- **ANL-01**: Pipeline throughput metrics (posts/hour, offers/hour, rejection rate by tier)
- **ANL-02**: AI cost tracking dashboard with daily/weekly aggregates
- **ANL-03**: Keyword suggestion engine surfacing candidate Tier 0 terms from Tier 1/2 data

### Moderation

- **MOD-01**: Bulk approve/reject in human review queue
- **MOD-02**: Offer edit capability for correcting extracted data

## Out of Scope

| Feature | Reason |
|---------|--------|
| Discourse/forum adapters | Deferred to v2 — Reddit is the primary source for v1 |
| Mobile app | Web dashboard sufficient for internal use |
| Public-facing UI | Internal tool with email allowlist auth |
| Auto-modifying Tier 0 keyword list | Project policy — human decides, system only suggests |
| Real-time notifications | Polling dashboard is sufficient for v1 review cadence |
| LangChain / Vercel AI SDK / AI wrappers | Project constraint — use @anthropic-ai/sdk directly |
| Auto-publishing low-confidence offers | Safety rule — < 0.7 confidence always routes to human review |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DB-01 | — | Pending |
| DB-02 | — | Pending |
| DB-03 | — | Pending |
| DB-04 | — | Pending |
| ING-01 | — | Pending |
| ING-02 | — | Pending |
| ING-03 | — | Pending |
| ING-04 | — | Pending |
| ING-05 | — | Pending |
| CLS-01 | — | Pending |
| CLS-02 | — | Pending |
| CLS-03 | — | Pending |
| CLS-04 | — | Pending |
| CLS-05 | — | Pending |
| CLS-06 | — | Pending |
| DDP-01 | — | Pending |
| DDP-02 | — | Pending |
| DDP-03 | — | Pending |
| DDP-04 | — | Pending |
| VAL-01 | — | Pending |
| VAL-02 | — | Pending |
| VAL-03 | — | Pending |
| VAL-04 | — | Pending |
| VAL-05 | — | Pending |
| LOG-01 | — | Pending |
| LOG-02 | — | Pending |
| DSH-01 | — | Pending |
| DSH-02 | — | Pending |
| DSH-03 | — | Pending |
| DSH-04 | — | Pending |
| WRK-01 | — | Pending |
| WRK-02 | — | Pending |
| WRK-03 | — | Pending |

**Coverage:**
- v1 requirements: 33 total
- Mapped to phases: 0
- Unmapped: 33

---
*Requirements defined: 2026-04-20*
*Last updated: 2026-04-20 after initial definition*
