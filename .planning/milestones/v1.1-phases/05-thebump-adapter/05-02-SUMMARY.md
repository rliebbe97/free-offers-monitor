---
phase: 5
plan: 02
subsystem: worker/ingestion
tags: [scraping, utilities, error-handling]
key-files:
  created: [apps/worker/src/ingestion/scraping-utils.ts]
  modified: [apps/worker/src/config.ts, apps/worker/package.json]
metrics:
  tasks_completed: 1
  tasks_total: 1
  deviations: 1
---

# Plan 05-02 Summary: Scraping Utilities

## What Was Built

Created `apps/worker/src/ingestion/scraping-utils.ts` — the shared scraping infrastructure layer for TheBump and future forum adapters.

Exports:
- `SCRAPING_USER_AGENT` — consistent User-Agent string for all HTTP requests
- `ScrapeError` class — typed error with `code: 'NETWORK' | 'PARSE' | 'CHALLENGE' | 'TIMEOUT'` and optional `url` field
- `fetchWithRetry` — wraps `p-retry` with exponential backoff (1s base, 2x factor, randomized); aborts immediately on 404/410; logs retries via `logger.warn`
- `respectfulDelay` — async delay of 1–3 seconds (random jitter) for polite crawl pacing
- `fetchWithRateLimit` — `p-throttle` wrapper enforcing 1 request per 2s floor
- `extractExternalId` — pure function parsing TheBump discussion/comment URLs with regex `/\/discussion\/(?:comment\/)?(\d+)/`; throws `ScrapeError('PARSE', ...)` on invalid input

Supporting changes:
- Added `SCRAPING_REQUEST_TIMEOUT_MS = 15_000`, `SCRAPING_MAX_RETRIES = 3`, and `SCRAPING_MAX_PAGES = 10` to `apps/worker/src/config.ts`
- Added `p-throttle@6.1.0` to `apps/worker/package.json` dependencies

## Commits
| Task | Commit | Description |
|------|--------|-------------|
| 1 | (pending) | feat(worker/ingestion): add scraping-utils.ts with retry, throttle, and URL parsing utilities |

## Deviations

One deviation: `SCRAPING_MAX_PAGES` constant was added to `config.ts` alongside the two required constants (`SCRAPING_REQUEST_TIMEOUT_MS`, `SCRAPING_MAX_RETRIES`). This constant is referenced in the threat model (SCRAPING_MAX_PAGES caps total requests) and will be needed by the TheBump adapter in plan 05-03. Adding it here avoids a config.ts edit in the next plan.

## Self-Check

PASSED

All acceptance criteria verified:
- `export default` count: 0
- All 6 named exports present: SCRAPING_USER_AGENT, ScrapeError, fetchWithRetry, respectfulDelay, fetchWithRateLimit, extractExternalId
- All local imports use `.js` extension (`../logger.js`, `../config.js`)
- No `any` types in file
- `extractExternalId` regex matches `/\/discussion\/(?:comment\/)?(\d+)/`
- `ScrapeError` has `readonly code: ScrapeErrorCode` with union type
