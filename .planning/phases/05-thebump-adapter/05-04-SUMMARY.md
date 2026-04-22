---
phase: 5
plan: 04
subsystem: worker/ingestion
tags: [adapter, thebump, scraping, cheerio]
key-files:
  created:
    - apps/worker/src/ingestion/thebump-adapter.ts
    - apps/worker/src/ingestion/__fixtures__/thebump-post-list-page.html
    - apps/worker/src/ingestion/__fixtures__/thebump-challenge-page.html
    - apps/worker/src/ingestion/__fixtures__/thebump-empty-page.html
  modified: []
metrics:
  tasks_completed: 2
  tasks_total: 2
  deviations: 1
---

# Plan 05-04 Summary: TheBump Adapter + HTML Fixtures

## What Was Built

Created the concrete `TheBumpAdapter` class extending `BaseForumAdapter`, along with three synthetic HTML fixture files that mirror Vanilla Forums structure for unit testing.

**Fixtures (`apps/worker/src/ingestion/__fixtures__/`):**
- `thebump-post-list-page.html` — 3 discussion items (2 normal, 1 sticky+admin), `time[datetime]` elements, `a.NextPage[rel="next"]` pagination link, `/discussion/{id}/slug` URLs
- `thebump-challenge-page.html` — Cloudflare WAF simulation with `<title>Just a moment...</title>`
- `thebump-empty-page.html` — Valid page with empty `.DataList.Discussions` container

**Adapter (`apps/worker/src/ingestion/thebump-adapter.ts`):**
- Extends `BaseForumAdapter`, satisfying `SourceAdapter` interface via template method pattern
- `extractPostsFromPage`: Vanilla Forums `li.ItemDiscussion` selectors, skips `.isSticky` and `.RoleBadge` posts inline (D-09), extracts external_id via imported `extractExternalId`, body via `.text()` with HTML-leak validation (`/<|>/.test(body)`), date via `parsePostDate` (datetime attribute first, relative-date fallback, null on failure)
- `getNextPageUrl`: `a.NextPage, a[rel="next"]` selectors with THEBUMP_BASE_URL guard
- `parsePostDate` + `parseRelativeDate`: handles ISO 8601 and English relative strings (2 days ago, 3 hours ago, etc.)
- `createTheBumpAdapter` factory function exported (matches `createRedditAdapter` pattern)
- TypeScript strict mode, no `any`, named exports only, `.js` import extensions throughout

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 3a6a5d9 | feat(worker/ingestion): add TheBump HTML fixture files for unit tests |
| 2 | 6b3d905 | feat(worker/ingestion): implement TheBumpAdapter as BaseForumAdapter subclass |

## Deviations

**Deviation 1 (minor):** The plan's verify command checks `grep -c '.html()' | grep '^0$'` but the file contains one instance of `.html()` inside a comment (`// Extract body text — .text() only, never .html() (BUMP-06)`). No actual `.html()` call exists on body elements — all body extraction uses `.text()`. The acceptance criterion (BUMP-06 compliance) is fully satisfied; the grep check is a false positive on the comment text.

## Self-Check

PASSED — All success criteria met:
- 3 HTML fixture files in `__fixtures__/`
- `TheBumpAdapter extends BaseForumAdapter`
- `extractPostsFromPage` + `getNextPageUrl` implemented
- Date parsing with `time[datetime]` priority, relative-date fallback
- Body extraction via `.text()` with HTML-leak validation
- `extractExternalId` imported from `scraping-utils.js`
- `createTheBumpAdapter` factory function exported
- Sticky (`isSticky`) + admin (`.RoleBadge`) detection inline in `extractPostsFromPage`
- `pnpm --filter worker exec tsc --noEmit` passes with zero errors
