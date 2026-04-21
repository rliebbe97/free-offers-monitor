# Feature Research

**Domain:** Forum scraping adapter infrastructure
**Researched:** 2026-04-21
**Confidence:** HIGH

---

## Feature Landscape

### Table Stakes (Users Expect These)

These are baseline behaviors any HTML forum adapter must have to function correctly and integrate with the existing pipeline.

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| `SourceAdapter` interface implementation | Existing contract: every ingestion source must implement `fetchNewPosts(since: Date): Promise<RawPost[]>`. Pipeline integration depends on it. | Low | Interface is defined in `source-adapter.ts`. TheBump adapter must return `RawPost[]` with `external_id`, `url`, `title`, `body`, `author`, `posted_at`. |
| Thread listing scrape (forum index page) | TheBump community forums have a thread index per subforum. To find new posts, the adapter must fetch the thread list and filter by post date. | Medium | Target subforums: freebies and deals sections. Use Cheerio to parse the HTML thread listing. |
| Per-thread body scrape | Thread titles alone carry insufficient signal for Tier 0. The adapter must fetch and parse individual thread pages to extract the full body text. | Medium | Cheerio fetch + CSS selector extraction. Include OP post body only (not replies) for the `body` field, or concatenate top-level replies if needed for signal richness. |
| Date-based `since` filtering | The existing pipeline passes a `since: Date` and expects only posts newer than that timestamp. The adapter must parse post timestamps from the HTML and apply the filter. | Medium | TheBump timestamps are in rendered HTML. Parse with Cheerio. Handle relative time strings ("2 hours ago") and absolute timestamps consistently. |
| Stable `external_id` per thread | `posts` table uses `UNIQUE(source_id, external_id)` to prevent duplicate ingestion on re-poll. The adapter must derive a stable identifier from each thread (thread ID from URL slug or URL path segment). | Low | Extract numeric thread ID from thread URL, e.g. `/community/freebies/12345-title` → `12345`. |
| Upsert safety (idempotent re-poll) | Re-polling the same window must not insert duplicate posts. The external_id UNIQUE constraint handles this at DB level, but the adapter must not fail on duplicate UUIDs. | Low | Already handled by `ingest.ts` upsert pattern with `onConflict: 'source_id,external_id'`. Adapter just needs to return stable external IDs. |
| `User-Agent` header on all requests | Many forums block requests without a recognizable User-Agent. Scraping without a header risks 403s or bot detection. | Low | Set `User-Agent` to something generic but descriptive. Do not spoof a browser verbatim — use a project-identified agent string. |
| Graceful HTTP error handling | Network errors, 4xx, 5xx must not crash the ingestion loop. A single subforum failing should log and continue, not abort the whole cycle. | Low | Match existing Reddit adapter error isolation: try/catch per source, log with Axiom, `continue` to next source. |
| Rate limiting / polite crawl delay | TheBump does not publish a public API rate limit but aggressive scraping risks IP blocks. The adapter must enforce a minimum delay between requests. | Low | Add a configurable `SCRAPE_DELAY_MS` (default: 1000ms). Simple `await sleep(delay)` between page fetches is sufficient for v1. |
| Source registration in `sources` table | The `sources` table drives which adapters run and when (`last_polled_at` cursor). TheBump subforums must be registered as sources with `type: 'thebump'` and `identifier` = subforum URL or slug. | Low | Insert rows into `sources` for each target subforum. The `config` JSONB field can hold subforum-specific config (base URL, selectors). |
| Source type dispatch in `ingest.ts` | `runIngestionCycle` currently hard-codes `type === 'reddit'` and calls `createRedditAdapter`. It must dispatch to the TheBump adapter for `type === 'thebump'` sources. | Low | Extend the dispatch block in `ingest.ts`. This is the primary integration point with the existing pipeline. |
| Logging to Axiom (structured events) | All adapters must log fetch start, fetch complete (with count), and errors in the same structured format as the Reddit adapter. | Low | Use existing `logger` from `../logger.js`. Event names: `thebump_fetch_start`, `thebump_fetch_complete`, `thebump_fetch_error`. |

---

### Differentiators (Competitive Advantage)

These features go beyond bare minimum correctness and make the adapter more robust, maintainable, or extensible.

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| Shared `BaseHTMLAdapter` abstract class | Extracts common Cheerio fetch + retry + delay logic into a reusable base. Future forum adapters (BabyCenter, WhatToExpect) inherit instead of copying boilerplate. | Medium | Define abstract methods: `parseThreadList(html: string): ParsedThread[]` and `parseThreadBody(html: string): string \| null`. Common implementation: `protected async fetchPage(url: string): Promise<string>` with retry + delay. |
| Config-driven source registration | Subforum targets and CSS selectors stored in `sources.config` JSONB rather than hard-coded. Enables adding new TheBump subforums via DB row insert without code changes. | Medium | Schema: `config: { baseUrl: string, subforumPath: string, threadListSelector: string, threadBodySelector: string, dateSelector: string }`. Fall back to adapter defaults if selectors are absent. |
| Shared `fetchWithRetry` utility | HTTP fetch with exponential backoff, configurable retries, and User-Agent injection — extracted to a shared utility that both TheBump and future adapters use. | Low | Place in `apps/worker/src/ingestion/http-utils.ts`. Used by `BaseHTMLAdapter.fetchPage()`. Prevents copy-paste drift between adapters. |
| Selector versioning via `sources.config` | CSS selectors for TheBump stored in DB `config` JSONB. When TheBump redesigns the DOM, update the selector in the DB without a code deploy. | Low | Natural consequence of config-driven approach. Document selector fields in the sources table comment block. |
| Thread dedup by URL hash before fetch | Before fetching each thread body, check if `external_id` already exists in `posts` for this source. Skip the HTTP fetch entirely if the post was already ingested. | Medium | Reduces unnecessary HTTP requests on re-polls. Requires a pre-fetch DB query for the batch of thread IDs. Worth it if polling interval is short (< 15 min). |
| Subforum-scoped error isolation | If one subforum page fetch fails (403, timeout), the adapter continues with other subforums for the same source. Error is logged per-subforum, not per-source. | Low | Implement as a loop over subforum URLs within the adapter, each in its own try/catch. |
| Robots.txt compliance check at startup | Check `thebump.com/robots.txt` once at worker startup and warn (not throw) if the community subforum path is disallowed. | Low | Protects against Terms of Service violation. Non-blocking: log a warning, do not abort. Human decides whether to proceed. |

---

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| Full thread comment scraping (all replies) | More text = more signal for Tier 0 and Tier 1 classification. Reddit adapter goes one reply deep. | TheBump forum threads can have 50–200 replies. Fetching all replies multiplies HTTP requests per thread by 10–50x. Rate limit risk and latency explosion in the ingestion loop. | Scrape OP post body only. If signal is insufficient, add one-page pagination (first reply page only) — controlled expansion, not unbounded. |
| JavaScript rendering via Playwright | Some forum content is JS-rendered and Cheerio can't parse it. | TheBump community forums are server-rendered HTML. Playwright is a heavy dependency for a problem that doesn't exist here. If TheBump ever migrates to SPA, revisit — until then, Cheerio is sufficient. Project stack explicitly notes "Playwright only if JS rendering required." | Use Cheerio. If specific pages are later found to require JS, add Playwright selectively for those paths only. |
| Full-text search of TheBump via their internal API | If TheBump exposes a search API, it's more efficient than scraping thread listings. | TheBump does not publish a public API. Any undocumented internal API is subject to change without notice, breaking the adapter silently. ToS typically prohibits automated API access. | Scrape the forum subforum listing pages. Slower but stable and within normal browser behavior patterns. |
| Auto-discovery of new freebies subforums | Automatically crawl TheBump's subforum index to find new deals/freebies sections without manual registration. | Crawler scope creep: auto-discovery can accidentally index unrelated subforums (pregnancy forums, loss support groups). Incorrect posts in the pipeline erode Tier 0 and Tier 1 accuracy. | Register subforums manually via `sources` table rows. Keeps ingestion scope explicit and auditable. |
| Cookie/session-based authenticated scraping | Some forum content may be behind a login wall. Use stored session cookies to access member-only threads. | Cookie management adds significant complexity: session expiry, CSRF tokens, login flow automation. Risk of account banning. ToS violation in most cases. | Target only publicly accessible subforums. If valuable content is login-gated, re-evaluate the source choice, not the authentication approach. |
| Concurrent subforum fetches (high parallelism) | Fetch multiple subforum pages in parallel to reduce wall-clock ingestion time. | Parallel requests to a single domain trigger bot detection and IP blocks faster than sequential requests. TheBump has no API rate limit documentation, meaning there is no safe parallelism guarantee. | Sequential fetch with a polite delay (1000ms minimum between requests). Use `p-limit` with `concurrency: 1` for the TheBump domain to be explicit. |
| Real-time webhook / change detection | Instead of polling, subscribe to TheBump RSS or a change-notification mechanism for instant ingestion. | TheBump community forums do not publish RSS feeds or webhook endpoints for subforum activity. Any "real-time" approach would require continuous polling anyway. | Poll on a schedule (every 15–30 min). The existing `last_polled_at` cursor pattern handles this correctly. |

---

## Feature Dependencies

```
Existing pipeline (v1.0)
  └── sources table (type, identifier, config, last_polled_at)
  └── posts table (UNIQUE source_id + external_id)
  └── ingest.ts (runIngestionCycle, fetchActiveSources)
  └── SourceAdapter interface (fetchNewPosts)
  └── Tier 0 → pgmq → Tier 1 → Tier 2 pipeline (unchanged)

New features (v1.1) dependency order:

[1] shared http utility (fetchWithRetry)
      └── no upstream dependency
      └── used by: BaseHTMLAdapter, TheBumpAdapter

[2] BaseHTMLAdapter abstract class
      └── depends on: [1] fetchWithRetry
      └── used by: TheBumpAdapter, future forum adapters

[3] TheBumpAdapter implements SourceAdapter
      └── depends on: [2] BaseHTMLAdapter
      └── depends on: existing SourceAdapter interface
      └── depends on: existing RawPost type
      └── used by: [4] ingest.ts dispatch

[4] ingest.ts source type dispatch
      └── depends on: [3] TheBumpAdapter
      └── depends on: existing fetchActiveSources (type filter must include 'thebump')
      └── feeds into: existing Tier 0 → pgmq chain (unchanged)

[5] sources table rows (TheBump subforums)
      └── depends on: [4] dispatch being in place
      └── DB rows: INSERT INTO sources (type='thebump', identifier, config)
      └── no code change required; data migration / seed script
```

Cheerio is already in the stack. No new package dependencies are required beyond what is already installed.

---

## MVP Definition

### Launch With (v1.1)

These features are the minimum to have TheBump ingesting into the existing pipeline end-to-end:

1. `fetchWithRetry` shared HTTP utility (`apps/worker/src/ingestion/http-utils.ts`)
   - `fetch` with retry (max 3, exponential backoff), configurable delay, User-Agent header
   - Returns response body as string or throws after max retries

2. `TheBumpAdapter` implementing `SourceAdapter`
   - Fetches target subforum thread listing pages (freebies, deals)
   - Parses thread titles, URLs, authors, dates with Cheerio
   - Fetches each thread's OP body (first post only)
   - Filters threads by `since` date
   - Returns `RawPost[]` with stable `external_id` (thread ID from URL)
   - Logs `thebump_fetch_start`, `thebump_fetch_complete`, `thebump_fetch_error` to Axiom

3. Source type dispatch in `ingest.ts`
   - Extend `fetchActiveSources` to include `type = 'thebump'`
   - Add dispatch block to `runIngestionCycle` that creates a `TheBumpAdapter` for `thebump` sources

4. Seed `sources` rows for TheBump freebies and deals subforums
   - `type: 'thebump'`, `identifier`: subforum URL path, `config`: base URL + CSS selectors

5. `BaseHTMLAdapter` abstract class (minimal)
   - Abstract methods: `parseThreadList(html: string): ParsedThread[]`, `parseThreadBody(html: string): string | null`
   - Protected method: `fetchPage(url: string): Promise<string>` (wraps fetchWithRetry + delay)
   - `TheBumpAdapter` extends this

### Add After Validation (v1.x)

Once TheBump is producing posts and the 3-tier pipeline is classifying them, assess these additions:

- Config-driven CSS selectors stored in `sources.config` JSONB (vs. hard-coded in adapter)
  - Only valuable once selectors break due to a TheBump site update, or when adding more subforums
- Thread pre-dedup by `external_id` before body fetch (reduces HTTP requests on re-polls)
  - Add after measuring re-poll request volume; only worth the complexity if re-poll traffic is significant
- Robots.txt compliance check at adapter startup (non-blocking warn)
- `p-limit` concurrency cap (concurrency: 1) for TheBump domain — explicit, prevents accidental parallelism in future refactors

### Future Consideration (v2+)

- Additional HTML forum adapters (BabyCenter community, WhatToExpect forums) inheriting `BaseHTMLAdapter`
  - Each new adapter proves the base class abstraction; worth building only after 2+ adapters exist
- Adapter health metrics dashboard panel (posts per source per day, error rate per source)
- Subforum selector update tooling (detect CSS selector staleness, surface to dashboard)

---

## Feature Prioritization Matrix

| Feature | Value | Complexity | Risk | Priority |
|---|---|---|---|---|
| `fetchWithRetry` HTTP utility | High — all HTTP scraping depends on this | Low | Low | P0 — build first |
| `TheBumpAdapter` (thread list + body scrape) | High — core deliverable | Medium | Medium (DOM parsing fragile) | P0 — v1.1 launch |
| Source dispatch in `ingest.ts` | High — pipeline integration | Low | Low | P0 — v1.1 launch |
| `BaseHTMLAdapter` abstract base class | High — prevents copy-paste for future adapters | Medium | Low | P0 — v1.1 launch |
| Seed `sources` rows for TheBump subforums | High — nothing runs without source rows | Low | Low | P0 — v1.1 launch |
| Polite crawl delay (1000ms between requests) | High — prevents IP block | Low | Low | P0 — v1.1 launch |
| Config-driven CSS selectors in `sources.config` | Medium — reduces deploy frequency when DOM changes | Medium | Low | P1 — v1.x after validation |
| Thread pre-dedup (skip already-seen external IDs) | Medium — reduces HTTP traffic on re-poll | Medium | Low | P1 — v1.x after validation |
| Subforum-scoped error isolation | Medium — resilience | Low | Low | P1 — v1.x after validation |
| Robots.txt compliance check | Low — defensive hygiene | Low | Low | P2 — future |
| Additional forum adapters (BabyCenter, etc.) | Medium — source diversification | Medium per adapter | Medium | P2 — v2+ |
| Full comment scraping | Low — marginal signal gain | High | High | Anti-feature — do not build |
| Playwright for TheBump | None — pages are server-rendered | High | High | Anti-feature — do not build |
| Authenticated scraping | Low — target subforums are public | Very High | Very High | Anti-feature — do not build |

---

## Sources

- Existing codebase: `apps/worker/src/ingestion/source-adapter.ts`, `reddit-adapter.ts`, `ingest.ts` — interface contract and adapter patterns
- Existing codebase: `packages/db/src/types.ts` — `sources` table schema with `type`, `identifier`, `config` JSONB
- Existing codebase: `apps/worker/src/tiers/tier0.ts` — ingestion pipeline entry point, Tier 0 inline filter
- Project planning: `.planning/PROJECT.md` — v1.1 milestone goals, constraints, out-of-scope list
- Project planning: `.planning/research/STACK.md` — Cheerio confirmed in stack; Playwright conditional only
- Project planning: `.planning/research/PITFALLS.md` — rate limiting, WAF detection patterns from validation cron; URL normalization edge cases
- Project planning: `.planning/research/ARCHITECTURE.md` — `sources` table DDL, `ingest.ts` ingestion loop design, error handling strategy
- General forum scraping practice: HTML forum adapters using Cheerio are standard for server-rendered forum software (phpBB, vBulletin, custom stacks). TheBump community runs custom software with stable server-rendered HTML. Standard patterns: thread listing → date filter → body fetch → return normalized structs.
