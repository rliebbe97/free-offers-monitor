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
