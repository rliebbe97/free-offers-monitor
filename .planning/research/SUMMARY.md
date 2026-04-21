# Project Research Summary

**Project:** Free Offers Monitor
**Domain:** Forum scraping adapter infrastructure
**Researched:** 2026-04-21
**Confidence:** HIGH

## Executive Summary

The v1.1 milestone adds TheBump forum as a second ingestion source alongside Reddit, requiring a new Cheerio-based HTML scraping adapter and shared adapter infrastructure to support future forum sources. The research confirms that the existing pipeline — Tier 0 through Tier 2, dedup, pgmq queue, validation cron, and dashboard — remains entirely unchanged. All work is scoped to `apps/worker/src/ingestion/` and a minor two-line modification to `ingest.ts` that makes source dispatch type-agnostic.

TheBump forums run on Vanilla Forums (server-rendered HTML), making Cheerio sufficient without Playwright. The only new production dependency is `p-throttle` for time-windowed rate limiting; `playwright` may be added as an optional dev dependency for a future Cloudflare fallback path that is not yet needed. The shared adapter infrastructure (`BaseForumAdapter` abstract class + `scraping-utils.ts`) is a one-time investment that makes adding BabyCenter, WhatToExpect, or any server-rendered forum in future milestones a matter of implementing one class rather than building from scratch.

The critical implementation risk is not the scraping itself — TheBump's HTML is stable, publicly accessible, and not currently WAF-protected — but the correctness of six specific behaviors: selector assertions that fail loudly rather than silently returning null, numeric-only `external_id` extraction from URLs (not the mutable slug), three-condition pagination termination, `<time datetime="">` first date parsing, `.text()` body extraction (never `.html()`), and Cloudflare challenge page detection. Each of these is a "looks done but isn't" trap that causes the pipeline to appear healthy while silently producing bad data or no data.

## Key Findings

### Recommended Stack

The existing stack requires no core runtime changes. All new adapter code runs inside the existing Node.js 22 / TypeScript strict / pnpm worker.

**New production dependency:**
- `p-throttle` 8.1.0 — time-windowed rate limiting (1 req/2s for TheBump); fills the orthogonal gap left by the already-installed `p-limit` (concurrency) and `p-retry` (retries). ESM-only, Node 18+ compatible.

**Optional dev dependency:**
- `playwright` 1.59.1 — headless browser fallback; add as dev/optional now so the conditional code path exists, but do NOT activate for TheBump pages which are currently server-rendered. Only activate if a Cloudflare IUAM challenge page is detected.

**Already covered by existing stack:**
- `cheerio` ^1.0.0 — HTML parsing (already installed)
- `p-retry` 8.0.0 — fetch retry with backoff (already installed)
- `p-limit` 7.3.0 — concurrency cap (already installed)
- `@axiomhq/js` — structured logging (already installed)
- `@anthropic-ai/sdk` — no changes to AI tier

**Explicitly rejected:** `got`, `axios`, `puppeteer`, `node-html-parser`, `tough-cookie`, `bottleneck`, `https-proxy-agent` — all redundant with existing capabilities.

### Expected Features

**Must have (P0 — v1.1 launch):**
1. `scraping-utils.ts` — `fetchWithRetry()` + `respectfulDelay()` + User-Agent constant; stateless pure utilities, unit-testable in isolation
2. `BaseForumAdapter` abstract class — `fetchPage(url): Promise<CheerioAPI>`, `shouldSkipPost(body): boolean`; `RedditAdapter` does NOT extend this
3. `TheBumpAdapter extends BaseForumAdapter` — subforum thread list scraping, per-thread body scraping, date parsing, pagination with three termination conditions, challenge page detection
4. `ingest.ts` source type dispatch — remove `.eq('type', 'reddit')` filter; add `createAdapterForSource(source)` factory switching on `source.type`
5. `index.ts` rename — `runRedditIngestionLoop` → `runIngestionLoop`
6. `sources` DB rows — seed TheBump freebies and deals subforums with `type='bump'`, `identifier`, and `config` JSONB
7. Polite crawl delay — 1–3s random jitter between page fetches

**Should have (P1 — v1.x after validation):**
- Config-driven CSS selectors stored in `sources.config` JSONB (vs hard-coded in adapter class)
- Thread pre-dedup by `external_id` before body fetch (reduces HTTP requests on re-polls)
- Subforum-scoped error isolation (loop over subforums with individual try/catch)
- `p-limit` concurrency cap explicitly set to 1 for TheBump domain

**Defer (P2 — v2+):**
- Additional HTML forum adapters (BabyCenter, WhatToExpect) inheriting `BaseForumAdapter`
- Adapter health dashboard panel (posts per source per day, error rate per adapter)
- Subforum selector staleness detection tooling

**Anti-features (do not build):**
- Full comment scraping (all replies) — 10–50x HTTP request multiplication for marginal signal
- Playwright for TheBump ingestion — pages are server-rendered; Playwright adds 2–5s latency per page
- Authenticated/cookie-based scraping — target subforums are public; ToS and complexity risk not justified
- Auto-discovery of new freebies subforums — scope creep risk; manual registration is explicit and auditable

### Architecture Approach

**Major components (all in `apps/worker/src/ingestion/`):**

| File | Status | Role |
|------|--------|------|
| `scraping-utils.ts` | NEW | `fetchWithRetry`, `respectfulDelay`, User-Agent — pure utilities |
| `base-forum-adapter.ts` | NEW | Abstract base for HTTP/Cheerio adapters; `RedditAdapter` ignores it |
| `thebump-adapter.ts` | NEW | TheBump-specific selectors, URL patterns, pagination, date parsing |
| `ingest.ts` | MODIFIED | Remove Reddit-only filter; add `createAdapterForSource()` factory |
| `index.ts` | MODIFIED | Rename `runRedditIngestionLoop` → `runIngestionLoop` |
| `config.ts` | MODIFIED | Add `SCRAPING_REQUEST_TIMEOUT_MS`, optional `THEBUMP_BASE_URL` override |
| Everything else | UNCHANGED | Tiers, dedup, queue, validation, dashboard — source-agnostic |

**Integration points:**
- `SourceAdapter` interface: unchanged — `fetchNewPosts(since: Date): Promise<RawPost[]>` is the only contract
- `sources` DB table: no schema change; `type` column accepts any string; TheBump rows use `type='bump'`
- `RawPost` type: unchanged — source type is invisible after the adapter boundary
- All downstream (Tier 0–2, dedup, validation, dashboard): unchanged

**Data flow:** `TheBumpAdapter.fetchNewPosts()` → `RawPost[]` → same `runIngestionCycle` upsert + Tier 0 + pgmq enqueue path as Reddit. Source type is opaque to every downstream component.

**Build order:** scraping-utils → BaseForumAdapter → TheBumpAdapter → ingest.ts dispatch → config.ts → index.ts rename → DB source rows → end-to-end smoke test.

**Key invariants:**
- `external_id` for TheBump = numeric ID from URL only (e.g., `4829183` from `/community/posts/free-diapers-sample-4829183`)
- `posted_at` parsed from `<time datetime="">` attribute first; fall back to English relative-date parser; `null` on failure = include in cycle (never skip)
- Body always via `.text()`, never `.html()`, then `.trim()` and whitespace collapse
- Challenge page detection: check `<title>` for "Just a moment" / "Checking your browser" before assuming no posts

### Critical Pitfalls

**Pitfall 1: TheBump DOM selector fragility (Phase 1)**
CSS class names on Vanilla Forums include build-hash suffixes (`PostListItem_title__3xQzM`) that regenerate on every TheBump deploy. Silently returns null with no exception.
Prevention: target semantic attributes (`[data-testid]`, `<time datetime>`, `<article>`) over generated class names; assert non-null/non-empty after each selector; emit `thebump_scrape_zero_results` warn log; add weekly selector smoke-test in CI.

**Pitfall 2: Breaking Reddit adapter during SourceAdapter refactor (Phase 2)**
Touching `ingest.ts`, `source-adapter.ts`, and `reddit-adapter.ts` simultaneously creates high regression surface. TypeScript catches shape mismatches but not behavioral regressions (e.g., `since` semantics).
Prevention: keep `SourceAdapter` interface signature identical; add a Vitest integration test running the full Reddit ingestion cycle path before and after refactor; make the Reddit migration atomic — remove old `createRedditAdapter` direct call in the same PR that adds the factory.

**Pitfall 3: Unstable `external_id` causing duplicate posts (Phase 1)**
TheBump post URLs include a mutable title slug. Using the full slug as `external_id` creates a new DB row when a post title is edited.
Prevention: extract only the numeric suffix; validate format matches `/^\d+$/` before returning `RawPost[]`; throw `ScrapeError` if extraction fails.

**Pitfall 4: Pagination infinite loop or incomplete coverage (Phase 1)**
Fetching all pages on every poll is slow and triggers anti-scraping. Missing the termination condition loses posts from large polling windows.
Prevention: three termination conditions — (1) no Next link, (2) oldest post on page older than `since`, (3) hard `MAX_PAGES = 10` cap; log `thebump_pagination_stop` with `reason` and `page_count` on every crawl.

**Pitfall 5: Cloudflare challenge page silently returning empty (Phase 1)**
Without WAF detection, a blocked response looks identical to "no new posts" — adapter appears healthy while ingesting nothing.
Prevention: detect challenge pages by `<title>` content and response length; emit `thebump_challenge_detected` warn; return `[]` without throwing; add 1–3s random jitter between requests; cap TheBump poll frequency at 10 minutes minimum.

**Top 5 additional pitfalls to address:**
- **Pitfall 6** (Date parsing): Use `<time datetime="">` attribute first; implement English relative-date parser for all formats; never use `new Date(text)` on relative strings.
- **Pitfall 7** (HTML body corruption): Always `.text()` not `.html()`; validate no `<` or `>` in stored body.
- **Pitfall 8** (ingest.ts hard-coding): First change before any adapter code — remove `.eq('type', 'reddit')` filter from `fetchActiveSources`.
- **Pitfall 9** (adapter registration divergence): Atomic Reddit migration; delete old direct `createRedditAdapter` call from production code in same PR.
- **Pitfall 10** (embedding dedup cross-source mismatch): Add 10+ Reddit+TheBump cross-source offer pairs to `evals/labeled-posts.json`; run `pnpm eval` before shipping; log cosine scores to Axiom for post-launch threshold tuning.

## Implications for Roadmap

### Suggested Phase Structure

**Phase 1: TheBump Adapter (core deliverable)**
- Build `scraping-utils.ts`, `BaseForumAdapter`, `TheBumpAdapter` in dependency order
- Include selector assertions, external_id validation, date parser unit tests, challenge page detection, and pagination termination from day one — not as follow-up hardening
- Extend `evals/labeled-posts.json` with TheBump posts and cross-source pairs
- Seed `sources` DB rows for TheBump freebies and deals subforums
- End-to-end smoke test: TheBump posts appearing in DB, progressing through Tier 0, landing in tier1_queue
- Pitfalls addressed: 1, 3, 4, 5, 6, 7 (all Phase 1 pitfalls)

**Phase 2: Shared Adapter Infrastructure + Reddit Migration**
- Update `fetchActiveSources` to return all source types (Pitfall 8 — do this first)
- Replace direct `createRedditAdapter` call with `createAdapterForSource()` factory (atomic migration, Pitfall 9)
- Rename `runRedditIngestionLoop` → `runIngestionLoop` in `index.ts`
- Add `config.ts` scraping constants
- Run `pnpm eval` with cross-source pairs; validate 0.85 dedup threshold or adjust (Pitfall 10)
- Pitfalls addressed: 2, 8, 9, 10

**Phase 3 (future): Second Forum Adapter + Base Class Validation**
- Add BabyCenter or WhatToExpect adapter extending `BaseForumAdapter`
- Proves the base class abstraction is genuinely reusable (two adapters existing is the threshold)
- Consider config-driven CSS selectors in `sources.config` JSONB at this point

### Phase Ordering Rationale

Phase 1 before Phase 2 because the TheBump adapter can be built and tested against the DB in isolation (with a temporary direct call in `ingest.ts`) before making the shared infrastructure change that touches the Reddit adapter's production code path. This sequencing means Reddit ingestion is never at risk while TheBump is being developed — the `runIngestionCycle` refactor only happens once TheBump is already producing valid posts and the test suite has confirmed correct behavior.

Phase 2 addresses Pitfall 8 (ingest.ts hard-coding) as its first step rather than a separate mini-phase, because the fix is two lines and it is the prerequisite for TheBump sources ever being fetched — it should gate Phase 2 but not block Phase 1 development (Phase 1 adapter can be built and unit-tested without the DB integration).

### Research Flags

**Phase 1 needs deeper investigation during planning:**
- Confirmed TheBump HTML selectors for the 5 target discussion threads — the STACK.md research verified the thread IDs and URL patterns but CSS selectors were inferred from Vanilla Forums conventions, not live DOM inspection. Pull actual HTML fixture before writing selectors.
- `<time datetime="">` presence — the research indicates this is the canonical timestamp source on modern forum software, but should be confirmed against a live TheBump thread page before coding the date parser.
- TheBump thread-level CSS selectors for: post body container, author username, comment ID anchor — these require a live page snapshot.

**Phase 2 needs deeper investigation during planning:**
- Dedup threshold validation — the 0.85 threshold analysis is theoretical. Actual cross-source cosine score distribution requires running Voyage embeddings against the labeled-posts.json cross-source pairs added in Phase 1. Do not finalize threshold until that data exists.

## Confidence Assessment

| Area | Confidence | Rationale |
|------|-----------|-----------|
| Stack additions | HIGH | Only `p-throttle` is new; all other capabilities are already installed and proven |
| TheBump forum structure | HIGH | URL patterns, pagination, robots.txt, and rendering model verified from live site |
| SourceAdapter interface contract | HIGH | Existing code reviewed; interface is clean and extensible without modification |
| `ingest.ts` refactor scope | HIGH | Exact lines requiring change identified (filter at line 14, dispatch at line 38) |
| CSS selectors for TheBump | MEDIUM | Inferred from Vanilla Forums conventions; need live DOM fixture to confirm |
| Date format variants | MEDIUM | Common patterns documented; need live TheBump page to confirm `<time datetime="">` presence |
| Dedup threshold for cross-source | MEDIUM | Theoretical analysis only; requires empirical validation after TheBump produces posts |
| TheBump WAF/rate-limit behavior | MEDIUM | No challenge pages observed in research; behavior under sustained polling is unconfirmed |
| Future forum adapter reusability | MEDIUM | `BaseForumAdapter` design is sound but reusability claim requires a second adapter to prove |

### Gaps to Address

1. **Live TheBump HTML fixtures** — pull at least one thread page and one subforum listing page from each of the 5 target discussion IDs before writing selectors; store as Vitest fixture files
2. **`<time datetime="">` confirmation** — inspect live TheBump post HTML to confirm timestamp is in a `<time>` element's `datetime` attribute vs. a `<span>` with relative text
3. **Cheerio selector validation** — identify the exact CSS selectors for: post body wrapper, author, comment ID anchor, pagination "Next" link on TheBump's current Vanilla Forums build
4. **Cross-source dedup empirical baseline** — after Phase 1 ships and TheBump produces posts, run Voyage embeddings on 10+ known Reddit/TheBump duplicate pairs and measure actual cosine scores before deciding on threshold adjustment
5. **TheBump sustained polling behavior** — monitor for 403/429 responses during first 48 hours after Phase 1 goes live; adjust inter-request jitter if challenge pages appear

## Sources

**From STACK.md:**
- npm registry: cheerio 1.2.0 — https://registry.npmjs.org/cheerio/latest
- npm registry: p-throttle 8.1.0 — https://registry.npmjs.org/p-throttle/latest
- npm registry: playwright 1.59.1 — https://registry.npmjs.org/playwright/latest
- TheBump forum categories — https://forums.thebump.com/categories
- TheBump freebies threads verified live — https://forums.thebump.com/discussion/12727626/steals-deals-freebies-coups
- TheBump robots.txt — https://forums.thebump.com/robots.txt
- Vanilla Forums technology — https://success.vanillaforums.com/kb/articles/138-vanilla-technology-stack

**From FEATURES.md:**
- Existing codebase: `apps/worker/src/ingestion/source-adapter.ts`, `reddit-adapter.ts`, `ingest.ts`
- Existing codebase: `packages/db/src/types.ts` — `sources` table schema
- Existing codebase: `apps/worker/src/tiers/tier0.ts`
- Project planning: `.planning/PROJECT.md` — v1.1 milestone goals

**From ARCHITECTURE.md:**
- `/apps/worker/src/ingestion/source-adapter.ts` — existing `SourceAdapter` interface and `RawPost` type
- `/apps/worker/src/ingestion/reddit-adapter.ts` — existing adapter pattern
- `/apps/worker/src/ingestion/ingest.ts` — hardcoded Reddit filter at lines 14 and 38
- `/apps/worker/src/index.ts` — 4-loop `Promise.all` structure
- `/packages/db/src/schema.sql` — `sources.type` column, `UNIQUE(source_id, external_id)` constraint

**From PITFALLS.md:**
- Existing codebase: `/apps/worker/src/dedup/url-hash.ts`, `embedding-dedup.ts`
- Existing codebase: `/apps/worker/src/config.ts`, `/packages/db/src/types.ts`
- Project context: `/.planning/PROJECT.md` (v1.1 milestone, current state)
