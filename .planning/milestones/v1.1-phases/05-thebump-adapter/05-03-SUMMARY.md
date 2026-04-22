---
phase: 5
plan: 03
subsystem: worker/ingestion
tags: [adapter, base-class, pagination, scraping]
key-files:
  created: [apps/worker/src/ingestion/base-forum-adapter.ts]
  modified: []
metrics:
  tasks_completed: 1
  tasks_total: 1
  deviations: 0
---

# Plan 05-03 Summary: BaseForumAdapter Abstract Class

## What Was Built

`BaseForumAdapter` is an abstract class implementing the `SourceAdapter` interface via a template-method pagination loop. Subclasses provide `startUrl`, `extractPostsFromPage`, and `getNextPageUrl`; the base class owns the crawl lifecycle including:

- Three termination conditions: `no_next_link`, `oldest_before_since`, `max_pages` (hard cap via `SCRAPING_MAX_PAGES`)
- `thebump_pagination_stop` log emitted on every crawl with the `reason` field
- `fetchPage` method that detects Cloudflare challenge pages and throws `ScrapeError('CHALLENGE', ...)`
- Default `shouldSkipPost` filtering bodies shorter than 20 characters
- `respectfulDelay()` (1–3s jitter) between page fetches per BUMP-08
- Fetch-error recovery: logs and breaks, returning all posts collected so far (D-06)
- Next-URL validation: rejects non-http(s) schemes before following
- Re-exports `CheerioAPI` type for subclass convenience

TypeScript compiles with zero errors (`pnpm --filter worker exec tsc --noEmit`).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 90c19c3 | feat(ingestion): add BaseForumAdapter abstract class with template-method pagination |

## Deviations

None

## Self-Check

PASSED — all acceptance criteria verified:
- `export abstract class BaseForumAdapter implements SourceAdapter` present
- `protected abstract readonly startUrl: string` present
- `async fetchNewPosts(since: Date): Promise<RawPost[]>` present
- `protected async fetchPage(url: string): Promise<CheerioAPI>` present
- `protected shouldSkipPost(post: RawPost): boolean` present
- Both abstract methods `extractPostsFromPage` and `getNextPageUrl` present
- `thebump_pagination_stop` log with `reason` field present
- Challenge detection via `title.includes('just a moment')` present
- `logger.warn('thebump_challenge_detected',` present
- `throw new ScrapeError('CHALLENGE',` present
- `await respectfulDelay()` inside pagination loop present
- `pageCount < SCRAPING_MAX_PAGES` in while condition present
- All three stop reasons present: `no_next_link`, `oldest_before_since`, `max_pages`
- No `export default` in the file (verified: grep count = 0)
- All local imports use `.js` extension
