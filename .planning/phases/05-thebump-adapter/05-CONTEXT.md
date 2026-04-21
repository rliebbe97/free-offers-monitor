# Phase 5: TheBump Adapter - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the TheBump Cheerio scraping adapter in isolation — scraping utilities, base class, adapter implementation, DB source rows, and eval coverage — without touching the Reddit production code path. TheBump can be unit-tested and DB-smoke-tested via direct adapter invocation without the dispatch factory (Phase 6 concern).

</domain>

<decisions>
## Implementation Decisions

### Base Class Design
- **D-01:** `BaseForumAdapter.fetchPage` returns a `CheerioAPI` object — base class owns HTTP fetch + Cheerio parsing, subclasses work directly with `$` selectors.
- **D-02:** Template method pattern — base class owns the `fetchNewPosts` loop (fetch page -> extract posts -> paginate -> apply skip filter). Subclasses implement abstract methods: `extractPostsFromPage($: CheerioAPI)` and `getNextPageUrl($: CheerioAPI)`.
- **D-03:** `shouldSkipPost` has a default implementation in the base class checking common signals (empty/deleted body, short body <20 chars). Subclasses override to add source-specific checks.
- **D-04:** `BaseForumAdapter` implements `SourceAdapter` directly — subclasses inherit interface compliance automatically. Single clean hierarchy.

### Error Handling
- **D-05:** Single `ScrapeError` class with a `code` field (`NETWORK`, `PARSE`, `CHALLENGE`, `TIMEOUT`). Flat error hierarchy matching the existing structured logging pattern.
- **D-06:** On page failure during multi-page crawl: log and stop pagination. Return all posts collected so far from earlier pages. Don't attempt further pages — avoids burning requests against persistent blocks.
- **D-07:** Cloudflare challenge detection emits `thebump_challenge_detected` warn-level log only. No in-code counter or escalation — Axiom handles alerting if configured.

### Skip-Post Criteria
- **D-08:** Base class `shouldSkipPost` checks: empty/deleted body, body shorter than 20 characters.
- **D-09:** TheBump-specific override adds: admin/staff post detection (via author role badges or known usernames) and sticky/pinned thread detection (via HTML attributes). These are platform-specific signals that vary across forums.

### Eval Data Strategy
- **D-10:** Eval entries sourced from real TheBump scrapes, manually labeled. No synthetic posts — test against actual HTML structure and real language patterns.
- **D-11:** Label distribution approximately 50/50 — half genuine free offers, half non-offers (coupons, services, trials, discussion posts). Tests both precision and recall equally.

### Claude's Discretion
- Exact CSS selectors for admin/staff/sticky detection on TheBump (determined during live fixture analysis)
- Internal structure of `ScrapeError` beyond the `code` field (message, metadata, etc.)
- Specific relative-date parsing library choice (or custom implementation)
- fetchWithRetry retry count and backoff strategy details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Ingestion Architecture
- `apps/worker/src/ingestion/source-adapter.ts` — Defines `SourceAdapter` interface and `RawPost` type that TheBump adapter must conform to
- `apps/worker/src/ingestion/reddit-adapter.ts` — Reference implementation showing adapter pattern, bot filtering, and factory function
- `apps/worker/src/ingestion/ingest.ts` — Ingestion cycle showing how adapters are invoked; note the `.eq('type', 'reddit')` filter that Phase 6 will remove

### Pipeline Integration
- `apps/worker/src/config.ts` — Existing constants pattern; new scraping constants (timeout, TheBump base URL) go here
- `apps/worker/src/tiers/tier0.ts` — Keyword filter that runs inline after ingestion; TheBump posts flow through this unchanged
- `apps/worker/src/queue/producer.ts` — `enqueueTier1` function that posts passing Tier 0 are enqueued to
- `apps/worker/src/logger.ts` — Axiom structured logging; all new log events must follow this pattern

### Worker Entry Point
- `apps/worker/src/index.ts` — Shows `runRedditIngestionLoop` and how loops run via `Promise.all`; TheBump loop not added here until Phase 6

### Requirements
- `.planning/REQUIREMENTS.md` — INGEST-01, INGEST-02, INGEST-05, BUMP-01 through BUMP-08, QUAL-01

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `cheerio` already in worker dependencies — no new scraping library needed
- `p-retry` 8.0.0 already available — fetchWithRetry can wrap it
- `p-limit` 7.3.0 already available — concurrency control if needed
- `normalize-url` 9.0.0 — URL normalization for dedup (used downstream, not in adapter)
- `logger` singleton from `../logger.js` — use directly for all scraping log events

### Established Patterns
- Class-based adapters implementing `SourceAdapter` interface (see `RedditAdapter`)
- Factory functions for adapter construction (`createRedditAdapter`)
- `getEnvOrThrow` for required env vars in `config.ts`
- Structured JSON logging with event name + fields object
- Vitest for testing with `pnpm test --filter worker`

### Integration Points
- New files go in `apps/worker/src/ingestion/` alongside existing adapter files
- Config constants go in `apps/worker/src/config.ts`
- DB seed migration for sources table (type='bump' rows)
- Eval entries go in `evals/labeled-posts.json` (directory needs creation)
- New dependency: `p-throttle` 8.1.0 for rate limiting (1 req/2s)

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches within the decisions above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 05-thebump-adapter*
*Context gathered: 2026-04-21*
