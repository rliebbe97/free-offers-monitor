# Requirements: Free Offers Monitor

**Defined:** 2026-04-21
**Core Value:** Reliably surface genuinely free physical goods from noisy forum data — false negatives cost missed offers, false positives erode trust.

## v1.1 Requirements

Requirements for milestone v1.1: Forum Adapters. Each maps to roadmap phases.

### Ingestion Infrastructure

- [ ] **INGEST-01**: Shared scraping utilities (fetchWithRetry, respectfulDelay, User-Agent constant) available for all HTML adapters
- [ ] **INGEST-02**: BaseForumAdapter abstract class provides shared fetchPage and shouldSkipPost methods for Cheerio-based adapters
- [ ] **INGEST-03**: Source dispatch factory routes ingestion by source.type instead of hardcoded Reddit-only filter
- [ ] **INGEST-04**: Reddit adapter migrated atomically to use source dispatch factory (same commit as INGEST-03)
- [ ] **INGEST-05**: Scraping config constants (request timeout, optional TheBump base URL override) in worker config

### TheBump Adapter

- [ ] **BUMP-01**: TheBump adapter scrapes freebies/deals subforums and returns RawPost[] through existing pipeline
- [ ] **BUMP-02**: Adapter extracts stable numeric external_id from post URLs (not mutable title slug)
- [ ] **BUMP-03**: Adapter paginates with three termination conditions (no next link, oldest post > since, MAX_PAGES hard cap)
- [ ] **BUMP-04**: Adapter parses dates from `<time datetime="">` first, falls back to English relative-date parser
- [ ] **BUMP-05**: Adapter detects Cloudflare challenge pages by `<title>` content instead of silently returning empty
- [ ] **BUMP-06**: Adapter uses .text() body extraction (never .html()) with whitespace collapse
- [ ] **BUMP-07**: TheBump source rows seeded in sources table with type='bump' and config JSONB
- [ ] **BUMP-08**: Polite crawl delay (1-3s random jitter) between page fetches

### Quality & Validation

- [ ] **QUAL-01**: TheBump posts added to evals/labeled-posts.json for Tier 1/2 eval coverage
- [ ] **QUAL-02**: Cross-source Reddit+TheBump offer pairs in eval dataset for dedup threshold validation

## Future Requirements

Deferred to future milestones. Tracked but not in current roadmap.

### Additional Forum Adapters

- **FORUM-01**: BabyCenter community adapter extending BaseForumAdapter
- **FORUM-02**: WhatToExpect community adapter extending BaseForumAdapter
- **FORUM-03**: Config-driven CSS selectors stored in sources.config JSONB (vs hard-coded in adapter class)

### Dashboard & Operations

- **DASH-01**: Email digest of new verified offers
- **DASH-02**: Pipeline throughput metrics dashboard
- **DASH-03**: AI cost tracking with daily/weekly aggregates
- **DASH-04**: Bulk approve/reject in review queue
- **DASH-05**: Offer edit capability for correcting extracted data
- **DASH-06**: Adapter health dashboard panel (posts per source per day, error rate per adapter)

### Developer Experience

- **DX-01**: CLI adapter builder flow for scaffolding new adapters

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Full comment scraping (all replies) | 10-50x HTTP request multiplication for marginal signal |
| Playwright for TheBump ingestion | Pages are server-rendered; Playwright adds 2-5s latency per page |
| Authenticated/cookie-based scraping | Target subforums are public; ToS and complexity risk not justified |
| Auto-discovery of new subforums | Scope creep risk; manual registration is explicit and auditable |
| TheBump internal API usage | Undocumented, ToS risk |
| High-concurrency parallel fetching | Bot detection risk |
| Real-time webhook/RSS ingestion | TheBump doesn't publish these |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INGEST-01 | — | Pending |
| INGEST-02 | — | Pending |
| INGEST-03 | — | Pending |
| INGEST-04 | — | Pending |
| INGEST-05 | — | Pending |
| BUMP-01 | — | Pending |
| BUMP-02 | — | Pending |
| BUMP-03 | — | Pending |
| BUMP-04 | — | Pending |
| BUMP-05 | — | Pending |
| BUMP-06 | — | Pending |
| BUMP-07 | — | Pending |
| BUMP-08 | — | Pending |
| QUAL-01 | — | Pending |
| QUAL-02 | — | Pending |

**Coverage:**
- v1.1 requirements: 15 total
- Mapped to phases: 0
- Unmapped: 15 ⚠️

---
*Requirements defined: 2026-04-21*
*Last updated: 2026-04-21 after initial definition*
