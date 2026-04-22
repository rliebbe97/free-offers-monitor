---
phase: 5
plan: 06
subsystem: worker/ingestion
tags: [tests, vitest, scraping]
key-files:
  created:
    - apps/worker/src/ingestion/scraping-utils.test.ts
    - apps/worker/src/ingestion/base-forum-adapter.test.ts
    - apps/worker/src/ingestion/thebump-adapter.test.ts
  modified: []
metrics:
  tasks_completed: 3
  tasks_total: 3
  deviations: 1
  tests_passed: 41
---

# Plan 05-06 Summary: Unit Tests for Ingestion Layer

## What Was Built

Three test files covering the complete ingestion layer:

**scraping-utils.test.ts** (13 tests) — Tests `ScrapeError` construction (name, code, message, url, optional url), `extractExternalId` for valid discussion URLs in three formats and invalid URLs that throw `ScrapeError('PARSE', ...)`, `respectfulDelay` timing (1–3s with 4s test timeout), `fetchWithRetry` HTTP status handling (200 success, 404 no-retry abort, 500 retry-then-succeed, User-Agent header), and `SCRAPING_USER_AGENT` constant value.

**base-forum-adapter.test.ts** (6 tests) — Tests the abstract `BaseForumAdapter` via a concrete `TestForumAdapter` subclass. Covers single-page extraction, `SCRAPING_MAX_PAGES` stop with log assertion, oldest-post-before-since stop, Cloudflare challenge detection (via `thebump_challenge_detected` warn log), `shouldSkipPost` short-body filter, and partial results on second-page fetch error (D-06).

**thebump-adapter.test.ts** (9 tests) — Tests `TheBumpAdapter` against three real HTML fixtures loaded with `readFileSync`. Covers post extraction from fixture (non-sticky, non-admin posts only), numeric `external_id` (BUMP-02), HTML-free body text (BUMP-06), ISO 8601 date parsing from `time[datetime]` (BUMP-04), challenge page detection returning empty array (BUMP-05), empty page returning empty array, `thebump_pagination_stop` log emission, `createTheBumpAdapter` factory, and sticky/admin post title exclusion (D-09).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `17b3aea` | test(ingestion): add unit tests for scraping-utils |
| 2 | `ab597ae` | test(ingestion): add unit tests for BaseForumAdapter |
| 3 | `c642e7f` | test(ingestion): add unit tests for TheBumpAdapter using HTML fixtures |

## Deviations

**vi.resetAllMocks() instead of vi.clearAllMocks()** — The plan specified `vi.clearAllMocks()` in `beforeEach`, but Vitest 3.x `clearAllMocks` only clears call history and does not drain the `mockResolvedValueOnce` queue. This caused the challenge-detection test to receive HTML from the previous test's unconsumed mock. Fixed by using `vi.resetAllMocks()` (which clears the queue) and re-applying the `respectfulDelay` and `extractExternalId` implementations in each `beforeEach`. This is the correct pattern for Vitest 3 when tests share mocked modules.

## Self-Check

PASSED — 41 tests, 5 test files, 0 failures, 0 regressions.

```
 ✓ src/validation/validation-loop.test.ts    (6 tests)
 ✓ src/validation/liveness-check.test.ts    (7 tests)
 ✓ src/ingestion/base-forum-adapter.test.ts (6 tests)
 ✓ src/ingestion/thebump-adapter.test.ts    (9 tests)
 ✓ src/ingestion/scraping-utils.test.ts    (13 tests)

 Test Files  5 passed (5)
      Tests  41 passed (41)
```
