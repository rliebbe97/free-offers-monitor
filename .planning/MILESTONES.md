# Milestones

## v1.0 — MVP

**Shipped:** 2026-04-21
**Phases:** 4 | **Plans:** 7
**Commits:** 95 | **Files:** 172 changed | **LOC:** ~27,365 TypeScript
**Timeline:** 2026-04-20 → 2026-04-21

### Delivered

Full end-to-end pipeline for scanning Reddit for genuinely free physical goods, classifying through a three-tier AI system (keyword filter, Haiku classifier, Sonnet extractor), deduplicating via URL hashing and Voyage embeddings, validating offer liveness, and surfacing results through an auth-gated Next.js dashboard.

### Key Accomplishments

1. Supabase DB foundation with pgvector, pgmq, pg_cron extensions and 7 tables with typed shared client
2. Reddit ingestion pipeline with snoowrap OAuth, bot/deleted guards, and 25-keyword Tier 0 filter
3. Three-tier AI classification: Haiku binary classifier + Sonnet forced-tool-use extractor with exclusion checks
4. Dedup pipeline: URL normalization with redirect follow + SHA-256 hash, Voyage 1024-dim embeddings with pgvector cosine >= 0.85
5. Offer validation cron: HEAD/GET liveness, Cheerio dead signal detection, two-consecutive-failure expiry state machine with 13 Vitest tests
6. Auth-gated Next.js dashboard: offer list (pagination/filter/sort), review queue (approve/reject), AI call log viewer (sortable, 8 columns)

### Known Deferred Items

- Phase 04 human verification: 9 live-environment tests requiring running Supabase instance (code verified 12/12)
- Known deferred items at close: 1 (see STATE.md Deferred Items)

### Archive

- [Roadmap Archive](milestones/v1.0-ROADMAP.md)
- [Requirements Archive](milestones/v1.0-REQUIREMENTS.md)

---

## v1.1 — Forum Adapters

**Shipped:** 2026-04-22
**Phases:** 2 | **Plans:** 10
**Commits:** 52 | **Files:** 62 changed | **LOC:** +10,324 / -1,173
**Timeline:** 2026-04-21 → 2026-04-22

### Delivered

Expanded ingestion beyond Reddit with a TheBump community adapter (Cheerio scraping, 3-termination pagination, Cloudflare detection) and migrated the production pipeline to a type-agnostic source dispatch factory. Built reusable BaseForumAdapter infrastructure, 41 unit tests, and an eval system with 21 labeled posts and cross-source dedup validation.

### Key Accomplishments

1. Shared scraping utilities (fetchWithRetry, respectfulDelay, p-throttle rate limiting) and BaseForumAdapter abstract class with template-method pagination
2. TheBumpAdapter with Cheerio scraping: numeric external_id extraction, `<time datetime>` date parsing with relative-date fallback, Cloudflare challenge detection, .text()-only body extraction
3. Type-agnostic source dispatch factory (createAdapterForSource) replacing hardcoded Reddit-only pipeline — both adapters run through unified runIngestionCycle
4. 41 unit tests covering complete ingestion layer (scraping-utils, base adapter, TheBump adapter, factory)
5. Eval system with 21 labeled posts (10 cross-source Reddit+TheBump pairs) and Tier 1 classifier + dedup cosine scoring
6. DB seed migration for TheBump source rows with idempotent ON CONFLICT guards

### Known Deferred Items

- Phase 05 verification: human_needed — live TheBump scrape, pnpm eval with API key, DB migration application
- Phase 06: live cosine eval with VOYAGE_API_KEY, live worker run with bump source
- Known deferred items at close: 1 (see STATE.md Deferred Items)

### Archive

- [Roadmap Archive](milestones/v1.1-ROADMAP.md)
- [Requirements Archive](milestones/v1.1-REQUIREMENTS.md)
