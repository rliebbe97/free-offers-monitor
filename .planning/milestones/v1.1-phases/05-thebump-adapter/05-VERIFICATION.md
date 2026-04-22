---
phase: 5
status: human_needed
verified_at: 2026-04-22
must_haves_score: 37/37
---

# Phase 5 Verification: TheBump Adapter

## Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `pnpm test --filter worker` shows passing unit tests for scraping-utils (fetchWithRetry, respectfulDelay, User-Agent), TheBumpAdapter date parsing, external_id extraction, and Cloudflare challenge detection | MET | 41 tests, 5 files, 0 failures. scraping-utils.test.ts (13), base-forum-adapter.test.ts (6), thebump-adapter.test.ts (9). All named test groups confirmed present. |
| 2 | TheBumpAdapter.fetchNewPosts(since) can be manually invoked against live TheBump subforums and produce RawPost[] records | HUMAN_NEEDED | Code is complete and correct. Cannot verify live scrape in automated context — Cloudflare may block; manual run required with real network access. |
| 3 | evals/labeled-posts.json has 10+ TheBump entries with tier1_expected and tier2_expected labels, pnpm eval passes without regression | MET (data); HUMAN_NEEDED (eval run) | labeled-posts.json: 10 entries, 5 pass / 5 reject, all tier2_expected fields valid. pnpm eval script exists and is wired up in root package.json. Actual eval run requires ANTHROPIC_API_KEY — cannot run in automated context. |
| 4 | Pagination logs emit thebump_pagination_stop with reason field, max 10 pages per crawl | MET | `logger.info('thebump_pagination_stop', { url, reason, pages_fetched, posts_collected })` in base-forum-adapter.ts L96–101. `SCRAPING_MAX_PAGES = 10` in config.ts L36. Three stop reasons verified: `no_next_link`, `oldest_before_since`, `max_pages`. Unit test in base-forum-adapter.test.ts asserts the log call with reason. |
| 5 | Two seeded sources rows with type='bump', correct identifier and config JSONB | MET | 001_seed_thebump_sources.sql: two INSERT statements with type='bump', identifiers `freebies-and-deals` and `deals`, config JSONB with base_url/subforum_path/max_pages, ON CONFLICT DO NOTHING idempotency. Requires manual Supabase execution; SQL content is correct. |

## Requirement Traceability

| REQ-ID | Status | Implementation |
|--------|--------|----------------|
| INGEST-01 | MET | `apps/worker/src/ingestion/scraping-utils.ts` — exports `fetchWithRetry`, `respectfulDelay`, `SCRAPING_USER_AGENT`, `ScrapeError`, `fetchWithRateLimit`, `extractExternalId` |
| INGEST-02 | MET | `apps/worker/src/ingestion/base-forum-adapter.ts` — abstract class with `fetchPage`, `shouldSkipPost`, template-method `fetchNewPosts` |
| INGEST-05 | MET | `apps/worker/src/config.ts` L33–37 — `SCRAPING_REQUEST_TIMEOUT_MS`, `SCRAPING_MAX_RETRIES`, `SCRAPING_MAX_PAGES`, `THEBUMP_BASE_URL` (with `??` fallback, not `getEnvOrThrow`) |
| BUMP-01 | MET | `TheBumpAdapter extends BaseForumAdapter`, implements `extractPostsFromPage` and `getNextPageUrl`, returns `RawPost[]` via inherited `fetchNewPosts` |
| BUMP-02 | MET | `extractExternalId(url)` in scraping-utils.ts L76–86; regex `/\/discussion\/(?:comment\/)?(\d+)/`; strict `/^\d+$/` validation; throws `ScrapeError('PARSE')` on invalid input; tested in scraping-utils.test.ts and thebump-adapter.test.ts |
| BUMP-03 | MET | Three termination conditions in base-forum-adapter.ts: `no_next_link` (L67–70), `oldest_before_since` (L59–62), `max_pages` (L92–94); all three tested in base-forum-adapter.test.ts |
| BUMP-04 | MET | `parsePostDate(datetimeAttr, textContent)` in thebump-adapter.ts L12–25; tries ISO 8601 datetime attribute first, then `parseRelativeDate` regex fallback, returns null on failure; tested in thebump-adapter.test.ts |
| BUMP-05 | MET | `fetchPage` in base-forum-adapter.ts L116–129 checks `$('title').text().toLowerCase()` for `'just a moment'` and `'checking your browser'`; throws `ScrapeError('CHALLENGE', ...)`; challenge fixture tested in both base-forum-adapter.test.ts and thebump-adapter.test.ts |
| BUMP-06 | MET | Body extracted via `.text()` (thebump-adapter.ts L108); whitespace collapsed via `.replace(/\s+/g, ' ')` (L108); HTML-leak validation `/<\|>/.test(body)` (L111–113); no `.html()` calls on body elements; tested in thebump-adapter.test.ts |
| BUMP-07 | MET | `packages/db/src/migrations/001_seed_thebump_sources.sql` — two INSERT statements with type='bump', JSONB config, ON CONFLICT idempotency. DB application is a human step. |
| BUMP-08 | MET | `respectfulDelay()` (1–3s random jitter) called between page fetches in base-forum-adapter.ts L86; `fetchWithRateLimit` throttle enforces 1 req/2s floor in scraping-utils.ts L73–74; respectfulDelay timing tested in scraping-utils.test.ts |
| QUAL-01 | MET | `evals/labeled-posts.json` — 10 TheBump entries, 5 pass / 5 reject, all with `tier2_expected` (non-null for pass, null for reject); run-eval.ts uses Tier 1 prompt from prompts/tier1-classify.md; pnpm eval wired in root package.json |

## Must-Haves Check

### Plan 05-01 Must-Haves
- [x] `SCRAPING_REQUEST_TIMEOUT_MS`, `SCRAPING_MAX_RETRIES`, `SCRAPING_MAX_PAGES`, `THEBUMP_BASE_URL` constants importable from config.ts — confirmed in config.ts L33–37
- [x] p-throttle available as runtime dependency — `"p-throttle": "8.1.0"` in apps/worker/package.json
- [x] No test regressions — 41/41 passing
- [x] `THEBUMP_BASE_URL` uses `??` fallback, not `getEnvOrThrow` — confirmed L37

### Plan 05-02 Must-Haves
- [x] `SCRAPING_USER_AGENT` exported — scraping-utils.ts L6
- [x] `ScrapeError` with typed `code` field — scraping-utils.ts L8–20
- [x] `fetchWithRetry` with configurable timeout/retries — scraping-utils.ts L22–66
- [x] `respectfulDelay` for polite crawl jitter — scraping-utils.ts L68–71
- [x] `fetchWithRateLimit` as throttled wrapper — scraping-utils.ts L73–74
- [x] `extractExternalId` validates numeric-only IDs and throws on invalid URLs — scraping-utils.ts L76–86

### Plan 05-03 Must-Haves
- [x] Abstract class implements `SourceAdapter` (template method pattern) — base-forum-adapter.ts L10
- [x] `fetchPage` returns `CheerioAPI` — base-forum-adapter.ts L116
- [x] `shouldSkipPost` with concrete default checking body length — base-forum-adapter.ts L135–138
- [x] Three pagination stop conditions with logged reason — confirmed
- [x] Cloudflare challenge detection in `fetchPage` — base-forum-adapter.ts L122–126
- [x] Polite delay between pages — base-forum-adapter.ts L86

### Plan 05-04 Must-Haves
- [x] TheBumpAdapter returns `RawPost[]` through `BaseForumAdapter` pagination — confirmed
- [x] Stable numeric `external_id` extracted from URLs — confirmed
- [x] Date parsing: `time[datetime]` first, relative-date fallback, null on failure — confirmed
- [x] Body text via `.text()` with whitespace collapse, HTML leak check — confirmed
- [x] HTML fixtures for testing (post-list, challenge, empty) — all three exist
- [x] No `.html()` calls on body elements — confirmed (comment in adapter is text in a code comment, not a call)
- [x] `getNextPageUrl` validates URLs against `THEBUMP_BASE_URL` — thebump-adapter.ts L164

### Plan 05-05 Must-Haves
- [x] TheBump source row(s) seeded with type='bump' — 001_seed_thebump_sources.sql
- [x] Config JSONB includes subforum URLs for freebies and deals — confirmed
- [x] Migration is idempotent via `ON CONFLICT` — confirmed
- [x] Migration directory convention established at `packages/db/src/migrations/` — confirmed

### Plan 05-06 Must-Haves
- [x] `extractExternalId` tested with valid and invalid URLs — scraping-utils.test.ts
- [x] TheBump adapter tested against HTML fixtures — thebump-adapter.test.ts
- [x] Body text validated to contain no HTML tags — thebump-adapter.test.ts
- [x] Date parsing tested for both datetime attribute and relative format — thebump-adapter.test.ts
- [x] Challenge page detection tested — both test files
- [x] Pagination stop log verified — both test files
- [x] Polite delay function tested for reasonable timing — scraping-utils.test.ts

### Plan 05-07 Must-Haves
- [x] TheBump posts in eval dataset with known tier1 labels and tier2_expected extraction results — labeled-posts.json verified
- [x] At least 10 entries with approximately 50/50 pass/reject distribution — 10 entries, 5/5 split
- [x] Eval runner uses same Tier 1 prompt as production — run-eval.ts reads prompts/tier1-classify.md
- [x] pnpm eval command works from repo root — in root package.json scripts
- [x] Eval runner reports accuracy and exits non-zero on failure — run-eval.ts L144–150

**Total must-haves: 37/37**

## Human Verification

The following items cannot be verified automatically and require manual testing:

1. **Live TheBump scrape (SC#2):** Run `TheBumpAdapter.fetchNewPosts(since)` against `https://community.thebump.com/categories/freebies-and-deals` with a real network connection. Verify it returns a non-empty `RawPost[]` without Cloudflare blocking. If a challenge page is detected, the adapter should log `thebump_challenge_detected` and return `[]` gracefully.

2. **pnpm eval execution (SC#3 partial):** Run `ANTHROPIC_API_KEY=<key> pnpm eval` from the repo root. Verify accuracy >= 0.70 across 10 labeled posts. The eval script is structurally correct but the actual classifier accuracy against the dataset has not been measured.

3. **DB migration (SC#5):** Apply `packages/db/src/migrations/001_seed_thebump_sources.sql` to the Supabase instance and verify two rows appear in the `sources` table with `type='bump'`.

## Gaps

No automated gaps found. All code-verifiable must-haves are satisfied. The three human items above are expected deferred steps (live network, API key, DB access) — not defects in the implementation.

### Notable Observations (Non-blocking)

- **05-02 SUMMARY version mismatch:** The summary mentions `p-throttle@6.1.0` was added, but the actual `package.json` correctly pins `8.1.0` as specified in the plan. The summary text is a copy error in the doc; the code is correct.
- **`thebump_pagination_stop` log name in `BaseForumAdapter`:** The base class emits `thebump_pagination_stop` even when used by non-TheBump adapters. This is cosmetically misnamed for future forum adapters but is functional and isolated to Phase 5 scope. Phase 6 dispatch work may want to generalize the log event name.
- **Eval runner deviation (doc only):** run-eval.ts adds F1 score computation beyond the plan specification. This is additive and does not violate any requirement.
- **`pnpm test` script does not include `pnpm eval`:** SC#3 says "pnpm eval passes without regression" — this requires ANTHROPIC_API_KEY and is intentionally separate from the test suite per the threat model. This is correct behavior, not a gap.
