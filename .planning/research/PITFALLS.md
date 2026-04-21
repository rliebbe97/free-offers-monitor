# Pitfalls Research

**Domain:** Forum scraping adapter infrastructure — adding TheBump HTML adapter and shared adapter abstraction to existing Reddit/API pipeline
**Researched:** 2026-04-21
**Confidence:** HIGH

---

## Critical Pitfalls

### Pitfall 1: TheBump DOM Structure Silently Changes Between Deploys

**What goes wrong:** Cheerio selectors hardcoded against TheBump's current HTML markup break silently the moment TheBump ships a CSS/template update. The adapter continues returning `RawPost` objects with `null` title, `null` body, and garbage `external_id` values — no exception is thrown. Posts get upserted to the DB, pass Tier 0 (empty string fails keyword filter, so most are dropped — but any keyword-free posts with `title` accidentally matching slip through), and the pipeline looks healthy in logs.

**Why it happens:** Cheerio scraping operates against raw HTML strings with no schema contract. TheBump is a React/Next.js forum rendered server-side; its class names follow a convention like `PostListItem_title__3xQzM` where the hash suffix is generated at build time. Any deployment on TheBump's side regenerates these hashes.

**How to avoid:**
- Target semantic HTML attributes over generated class names: prefer `[data-testid="post-title"]`, `<h1>`, `<article>`, `<time datetime="">` over `div.PostListItem_title__3xQzM`
- After selecting an element, assert it is non-null and non-empty before returning: throw a typed `ScrapeError` with the selector name rather than silently returning `null`
- Add a post-fetch assertion: if `posts.length === 0` from a page that should have posts (the freebies subforum is always non-empty), emit `thebump_scrape_zero_results` log at `warn` level, not `info`
- Write a dedicated selector smoke-test that runs weekly against the live site in CI — separate from unit tests

**Warning signs:**
- All TheBump posts have `title: null` or `body: null` in the DB
- `tier0_passed` is consistently `false` for TheBump posts while Reddit posts pass at normal rates
- `source.last_polled_at` updates but `ingested` count is 0

**Phase to address:** Phase 1 (TheBump adapter) — build in assertions from day one, not as a follow-up hardening pass


---

### Pitfall 2: Breaking the Existing Reddit Adapter During SourceAdapter Refactor

**What goes wrong:** Extracting shared adapter infrastructure requires touching `source-adapter.ts`, `ingest.ts`, and `reddit-adapter.ts`. Any change to the `SourceAdapter` interface, `RawPost` type, or the `fetchActiveSources` / `runIngestionCycle` functions can silently break the Reddit adapter. TypeScript catches interface shape mismatches but not behavioral regressions (e.g., the `since: Date` semantics changing, the `source.identifier` field being used differently).

**Why it happens:** The current `ingest.ts` is tightly coupled to Reddit: `fetchActiveSources` queries `WHERE type = 'reddit'`, `runIngestionCycle` calls `createRedditAdapter(source.identifier)` directly, and the loop is named `runRedditIngestionLoop` in `index.ts`. Any refactor that adds a TheBump branch must touch all three files simultaneously — high surface area for regression.

**How to avoid:**
- The `SourceAdapter` interface (`fetchNewPosts(since: Date): Promise<RawPost[]>`) must remain unchanged — do not add required parameters or change the return type as part of v1.1
- Extract `fetchActiveSources` to accept a `type` filter param OR make it source-type agnostic (`WHERE type IN ('reddit', 'thebump')`) — test both paths before merging
- Add a Vitest integration test that creates a `RedditAdapter` mock and runs the full ingestion cycle path with a real DB client against a test source row — run it before and after the refactor to confirm no regression
- Keep the `runRedditIngestionLoop` name in `index.ts` or add a `runTheBumpIngestionLoop` alongside it rather than merging them into a single loop prematurely

**Warning signs:**
- Reddit posts stop appearing in the DB after the refactor is merged
- `ingestion_cycle_start` logs show `source_id` for Reddit sources but `ingestion_cycle_complete` shows `total: 0`
- TypeScript compiles clean but runtime throws `createRedditAdapter is not a function` (import path changed)

**Phase to address:** Phase 2 (shared adapter infrastructure) — do the refactor in a separate phase from the TheBump adapter, with a green Reddit test suite as the gate


---

### Pitfall 3: TheBump External ID Instability Causing UNIQUE Constraint Violations or Duplicate Posts

**What goes wrong:** The `UNIQUE(source_id, external_id)` constraint on the `posts` table is the dedup guard against re-polling the same post. For Reddit, `external_id` is the stable Reddit post/comment ID (e.g., `t3_abc123`). For TheBump, the equivalent is the URL path slug or a numeric thread ID embedded in the URL. If the scraper derives `external_id` from something unstable — a list position, a scraped text string with whitespace, a partial URL that changes on pagination — the same post gets inserted repeatedly or the upsert silently updates a different post.

**Why it happens:** HTML forums do not expose a stable machine ID in a standard location. The scraper must find and extract it reliably. TheBump community URLs follow the pattern `/community/posts/{slug}-{numeric-id}` — the numeric ID is stable but the slug can change if the post title is edited. Using the full slug as `external_id` means an edited title creates a new post record.

**How to avoid:**
- Extract only the numeric suffix from TheBump post URLs as `external_id` — e.g., from `/community/posts/free-diapers-sample-4829183`, use `4829183` — never use the full slug
- Validate `external_id` format in the adapter before returning `RawPost[]`: assert it matches `/^\d+$/` and is non-empty; throw `ScrapeError` if not
- Log any `external_id` that does not match the expected format at `warn` level before dropping the post

**Warning signs:**
- The same TheBump thread appears twice in the `posts` table with different `external_id` values after a post title edit
- Upsert logs show high conflict rates (many `onConflict` hits) without corresponding `tier0_passed` increases
- `external_id` values in the DB contain whitespace, slashes, or full URL strings

**Phase to address:** Phase 1 (TheBump adapter) — define and validate the ID extraction rule before writing any other adapter logic


---

### Pitfall 4: Pagination Skipping or Infinite Looping

**What goes wrong:** TheBump forum pages list posts in paginated sets. If the scraper fetches only the first page, it misses older posts from the `since: Date` window. If it follows `Next` page links without a termination condition, it can loop indefinitely (some forums cycle back to page 1 after the last page, or `since` filtering causes all fetched pages to be empty but the "next" link still exists).

**Why it happens:** The `fetchNewPosts(since: Date): Promise<RawPost[]>` contract implies the adapter is responsible for fetching all posts newer than `since`. For API-based sources like Reddit, this is trivially handled by the `getNew({ limit: 25 })` call with timestamp comparison. For paginated HTML, the adapter must implement a crawl loop — and that loop needs a hard termination condition beyond "no more posts found."

**How to avoid:**
- Implement pagination with three termination conditions: (1) no `Next` link found, (2) the oldest post on the current page is older than `since` (stop — remaining pages are all older), (3) a page limit cap (`MAX_PAGES = 10`) to prevent runaway crawls
- Apply condition (2) correctly: TheBump lists posts newest-first, so once ANY post on the current page is older than `since`, stop pagination — do not continue to the next page
- Log `thebump_pagination_stop` with `reason` and `page_count` at the end of every crawl so pagination behavior is visible

**Warning signs:**
- Worker takes 30+ seconds per TheBump poll cycle (too many pages fetched)
- Worker logs show `page_count: 10` consistently — hitting the hard cap, meaning real termination logic is failing
- TheBump posts older than 24 hours appearing as `ingested` with pipeline_status `tier0_passed`

**Phase to address:** Phase 1 (TheBump adapter) — test with `since = 1 hour ago` and `since = 7 days ago` to verify both termination paths


---

### Pitfall 5: TheBump Rate Limiting and Anti-Scraping Measures

**What goes wrong:** TheBump does not publish rate limit headers or a robots.txt scraping policy. Sending rapid back-to-back fetch requests during pagination triggers Cloudflare or a site-level 429/403 — the scraper starts receiving challenge pages (HTML with JavaScript verification challenges) instead of forum content. Cheerio parses the challenge page, finds no posts, and returns an empty array — the adapter looks healthy but is silently blocked.

**Why it happens:** Unlike Reddit's OAuth API, TheBump has no explicit rate limit contract. The scraper appears to the server as a browser-less HTTP client. Without a `User-Agent`, `Accept`, and `Accept-Language` header matching a real browser, the request fingerprint is obviously non-human. Cloudflare's bot detection triggers on this within 10–20 requests.

**How to avoid:**
- Set a realistic `User-Agent` string (a current Chrome version on macOS) plus `Accept: text/html` and `Accept-Language: en-US,en;q=0.9` on every request
- Add a 1–3 second random jitter between page fetches during pagination — do not fire requests back-to-back
- Detect challenge pages by checking for the absence of expected forum content: if the `<title>` contains "Just a moment" or the body contains "Checking your browser", emit `thebump_challenge_detected` at `warn` and return empty — do not treat it as a parse error
- Cap TheBump polling frequency at once per 10 minutes, not once per 5 minutes like Reddit

**Warning signs:**
- TheBump adapter consistently returns 0 posts after working initially
- HTTP status 403 or 429 in fetch response
- Response HTML body is short (< 1000 chars) — challenge pages are minimal HTML
- `<title>` of response contains "Cloudflare" or "Security Check"

**Phase to address:** Phase 1 (TheBump adapter) — implement request throttling and challenge detection before testing against the live site


---

### Pitfall 6: Date Parsing Fragility Across Forum Formats

**What goes wrong:** TheBump displays post timestamps in a mix of relative and absolute formats depending on recency: "2 hours ago", "Yesterday at 3:45 PM", "April 15 at 10:23 AM", "Apr 15, 2025". None of these is an ISO 8601 string. Parsing them naively via `new Date(text)` produces `Invalid Date` silently. The `posted_at` field stored in the DB is `null`, which causes the `since: Date` comparison to never filter correctly — the adapter re-fetches and re-processes all posts on every poll cycle.

**Why it happens:** HTML forums are designed for human readability, not machine consumption. The `<time datetime="">` attribute in semantic HTML gives ISO timestamps, but only if TheBump uses the `<time>` element (they may). If they use `<span class="timestamp">2 hours ago</span>`, the scraper must parse English relative dates.

**How to avoid:**
- Check for `<time datetime="...">` first — this is the canonical source of machine-readable timestamps; parse the `datetime` attribute, not the text node
- If `<time>` is absent, implement a relative-date parser covering: "X minutes ago", "X hours ago", "Yesterday at H:MM AM/PM", "Month D at H:MM AM/PM", "Mon D, YYYY" — do not use `new Date(text)` for any of these
- Store a `Date` object in `RawPost.posted_at` only when the parse succeeds; when it fails, store `null` AND emit `thebump_date_parse_failure` at `warn` with the raw string
- In the ingestion cycle, treat `posted_at: null` as "unknown — include in this cycle" rather than "skip" to avoid missed posts

**Warning signs:**
- All TheBump posts have `posted_at: null` in the DB
- TheBump adapter re-fetches the same posts on every cycle (no effective `since` filtering)
- `thebump_date_parse_failure` appearing in logs frequently

**Phase to address:** Phase 1 (TheBump adapter) — write date parser unit tests against all format variants before wiring to the live site


---

### Pitfall 7: Content Encoding and HTML Entity Corruption in Post Bodies

**What goes wrong:** TheBump forum posts contain HTML entities (`&amp;`, `&nbsp;`, `&lt;`, `&#8220;`) and Unicode characters that must be decoded before the text is passed to Tier 0 keyword matching and Tier 1 AI classification. If Cheerio's `.text()` method is not used (i.e., `.html()` is used instead), the body stored in the DB and passed to the AI contains raw HTML markup — `<p>`, `<br>`, `<strong>`, inline image tags — which inflates token counts, distorts Tier 0 keyword matching, and burns Haiku tokens on HTML noise.

**Why it happens:** Cheerio distinguishes `.text()` (extracts text content, decodes entities) from `.html()` (returns raw inner HTML including tags). Both are valid Cheerio methods but serve different purposes. It is easy to use `.html()` when debugging (it shows more content) and then leave it in production.

**How to avoid:**
- Always use `.text()` on the element that contains the post body — never `.html()` — before storing in `RawPost.body`
- After `.text()`, apply `.trim()` and collapse internal whitespace: `text.replace(/\s+/g, ' ').trim()`
- Validate that the extracted body does not contain `<` or `>` characters — their presence is a sign `.html()` was used by mistake
- Check that `&amp;` entities are absent from the stored body — Cheerio's `.text()` decodes them; if they appear in the DB, the extraction is wrong

**Warning signs:**
- `body` column in DB contains `<p>`, `<br>`, `<strong>` strings
- Tier 0 keyword filter misses obvious matches because the text is cluttered with HTML markup
- Tier 1 token counts for TheBump posts are 2–3x higher than equivalent Reddit posts

**Phase to address:** Phase 1 (TheBump adapter) — validate body text quality in the first integration test


---

### Pitfall 8: ingest.ts Source Type Hard-coding Breaks TheBump Sources in DB

**What goes wrong:** The current `fetchActiveSources` in `ingest.ts` queries `.eq('type', 'reddit')`. Any TheBump source row inserted into the `sources` table with `type: 'thebump'` is silently ignored — no error, no log. The TheBump adapter is built and deployed, the source row is inserted, but zero posts ever appear.

**Why it happens:** The filter was written as an explicit Reddit-only guard because TheBump didn't exist at v1.0. It's a natural shortcut that becomes a latent bug when a second source type is added without updating the query.

**How to avoid:**
- Before writing the TheBump adapter, update `fetchActiveSources` to return all active sources (remove the `type` filter, or change it to `IN ('reddit', 'thebump')`)
- Add a source-type dispatch table in `runIngestionCycle`: a `Map<string, (identifier: string) => SourceAdapter>` keyed by `source.type` — unknown types emit `unknown_source_type` at `warn` and skip
- Write a test that inserts a `sources` row with `type: 'thebump'` and asserts it is returned by `fetchActiveSources`

**Warning signs:**
- TheBump source row exists in `sources` table but `last_polled_at` never updates
- No `ingestion_cycle_start` log for TheBump sources
- `fetchActiveSources` returns only Reddit sources when logged

**Phase to address:** Phase 2 (shared adapter infrastructure) — this is the first change to make before writing any TheBump adapter code


---

### Pitfall 9: Adapter Registration Pattern Diverging Between Reddit and TheBump

**What goes wrong:** The shared adapter infrastructure introduces a factory/registry pattern (e.g., `adapterRegistry.register('thebump', createTheBumpAdapter)`). If the Reddit adapter is partially migrated to this pattern while keeping its direct instantiation in `index.ts` as a fallback, two code paths exist for creating Reddit adapters. Future bugs are fixed in one path but not the other. Tests cover the factory path; production uses the legacy path. The two patterns diverge silently.

**Why it happens:** Refactors that "leave the old way working" to reduce risk inadvertently create two sources of truth. The old `createRedditAdapter` call in `index.ts` is never removed because "it works" — and so the registry is never the authoritative path for Reddit.

**How to avoid:**
- The refactor must be atomic for Reddit: the old `createRedditAdapter(source.identifier)` call in `ingest.ts` must be replaced by the registry lookup in the same PR — no interim state where both exist
- Delete `createRedditAdapter` from `reddit-adapter.ts` exports after the registry takes over OR keep it as the implementation detail called by the registry factory — never let it be both a top-level export AND used directly in production code
- The registry must be the single point of adapter creation before v1.1 ships; any direct adapter instantiation outside the registry is a bug

**Warning signs:**
- Both `createRedditAdapter` and `adapterRegistry.get('reddit')` appear in production call stacks
- Different behavior between Reddit and TheBump ingestion paths for identical input (e.g., one logs `ingestion_cycle_start`, the other does not)
- A bug fix applied to the registry path silently doesn't apply to the Reddit path

**Phase to address:** Phase 2 (shared adapter infrastructure) — make the migration atomic, enforce with TypeScript visibility (mark old factory `/** @internal */` or remove the export)


---

### Pitfall 10: Embedding Dedup Semantic Mismatch Between Reddit Post Style and Forum Post Style

**What goes wrong:** The Voyage embedding dedup at cosine ≥ 0.85 was calibrated against Reddit post text. TheBump forum posts are written in a different register: more conversational, often in first-person, with different vocabulary and sentence structure. A Reddit post "FREE Huggies samples — just fill out the form" and a TheBump post "Has anyone gotten the free Huggies sample? I just requested mine" may describe the same offer but embed differently enough to create a duplicate offer record rather than deduplicating.

**Why it happens:** The 0.85 threshold was chosen based on Reddit-vs-Reddit similarity distributions. Forum-vs-Reddit comparisons introduce a new similarity distribution that was never validated. The threshold may need to be lower (0.80) for cross-source dedup.

**How to avoid:**
- Add cross-source near-duplicate pairs to `evals/labeled-posts.json` before shipping the TheBump adapter — at least 10 pairs of Reddit + TheBump posts describing the same offer
- Run `pnpm eval` with the current 0.85 threshold against the extended eval set before shipping; adjust threshold if recall drops
- Log the cosine similarity score for every dedup check (`dedup_cosine_score` field in a structured log) so the distribution can be analyzed in Axiom after TheBump goes live

**Warning signs:**
- The same offer appears in the `offers` table from two sources (one Reddit, one TheBump) with slightly different titles
- `pnpm eval` recall drops after adding TheBump test pairs
- Axiom shows cosine scores clustering between 0.80 and 0.85 for TheBump-Reddit pairs (just below the threshold)

**Phase to address:** Phase 1 (TheBump adapter, eval set extension) and Phase 2 (threshold validation after cross-source data exists)


---

## Technical Debt Patterns

| Shortcut | Short-term Benefit | Long-term Cost |
|----------|-------------------|----------------|
| Hardcode TheBump selectors by generated class name | Faster initial build | Breaks on every TheBump deploy; requires emergency fix with no warning |
| Skip pagination and only fetch page 1 | Simpler adapter code | Misses posts from large polling windows; first-run after outage loses data |
| Leave `fetchActiveSources` Reddit-only and add a separate `fetchTheBumpSources` | No risk to Reddit | Two parallel code paths diverge; adding a third source requires touching three places |
| Use `.html()` instead of `.text()` for quick debugging | Easier to see full content during development | HTML markup corrupts Tier 0/1 text; inflates AI token costs permanently |
| Skip challenge page detection and just return empty on scrape failure | Simpler error handling | Cloudflare blocks are indistinguishable from "no new posts" in logs |
| Derive `external_id` from post title slug | Easy to find in HTML | Title edits create duplicate DB rows; UNIQUE constraint violations at scale |
| Copy-paste the Reddit ingestion loop for TheBump instead of extracting shared logic | Fastest path to working adapter | Two loops with the same bug surface; shared bug fixes require two changes |

---

## Integration Gotchas

| Integration Point | Mistake | Correct Approach |
|-------------------|---------|-----------------|
| `fetchActiveSources` in `ingest.ts` | Querying `.eq('type', 'reddit')` silently excludes TheBump sources | Query all types or use `in(['reddit', 'thebump'])` with a dispatch map |
| `runIngestionCycle` adapter dispatch | Calling `createRedditAdapter` directly | Use a source-type registry: `Map<string, AdapterFactory>` keyed by `source.type` |
| `SourceAdapter` interface | Adding optional parameters to `fetchNewPosts` for scraper-specific config | Pass config via constructor; keep the interface signature identical |
| `RawPost.external_id` | Deriving from a TheBump URL slug that includes a mutable title segment | Extract only the numeric post ID from the URL; ignore the slug portion |
| `RawPost.posted_at` | Returning `null` when date parsing fails and silently re-processing all posts | Return `null` AND log the failure; treat `null` as "include in this cycle" explicitly |
| Tier 0 keyword filter | Applying it to raw HTML body (`.html()` output) | Always apply Tier 0 on decoded, tag-stripped `.text()` output |
| Dedup embedding | Using Reddit-calibrated 0.85 threshold for cross-source comparisons | Validate threshold against cross-source labeled pairs in `evals/` before shipping |
| `config.ts` env validation | Failing to add `THEBUMP_` env vars to the startup assertion block | Add any TheBump-specific env vars (e.g., `THEBUMP_BASE_URL`) to `getEnvOrThrow` checks |
| `index.ts` loop startup | Adding a TheBump loop inside `runRedditIngestionLoop` | Add a separate `runTheBumpIngestionLoop` function and include it in `Promise.all` |

---

## Performance Traps

| Trap | Impact | Prevention |
|------|--------|------------|
| Fetching all pagination pages on every poll | 10x slower poll cycles; triggers anti-scraping at TheBump | Terminate pagination when oldest post on page is older than `since` |
| No inter-page delay during pagination | Cloudflare block within 10–20 requests | Add 1–3s random jitter between page fetches |
| Parsing full page HTML for body text when only the post body is needed | Extra CPU and memory for large forum pages | Use targeted Cheerio selectors: `$(postSelector).find(bodySelector).text()` — do not load entire page into a JSDOM tree |
| Running TheBump and Reddit ingestion on the same 5-minute poll interval | TheBump's slower page fetches (network I/O + jitter) delay Reddit ingestion | Run TheBump on a 10-minute interval, Reddit on 5-minute; separate loops in `Promise.all` |
| Voyage API call for every TheBump post at dedup time | API cost and latency if TheBump generates high post volume | Apply URL hash dedup first; only call Voyage for posts that pass URL hash check (identical to current Reddit path) |
| No caching of TheBump base page (category listing) | Re-fetching the category page on every pagination step | Fetch the listing page once per cycle; extract all post URLs from it before fetching individual posts |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing raw scraped HTML in the DB without sanitization | XSS risk if any scraped content is rendered unescaped in the dashboard | Always use `.text()` extraction; never store raw HTML in `posts.body` |
| Using TheBump session cookies scraped from a real browser session | TheBump ToS violation; cookie expiry causes silent adapter failure | Use unauthenticated requests to public forum pages only; TheBump freebies subforum is publicly accessible |
| Logging full response HTML on scrape errors | Sensitive PII in TheBump posts (user names, email patterns) captured in Axiom logs | Log only HTTP status, content length, and first 200 chars of response body on error |
| Hardcoding `User-Agent` to impersonate a specific browser version | Detectable fingerprint; can be flagged as deceptive scraping | Use a generic but realistic User-Agent; document the scraping behavior in a `robots.txt` check |
| Not checking `robots.txt` before scraping | TheBump may disallow scraping; ToS violation risk | Fetch and parse `https://www.thebump.com/robots.txt` at startup; log which paths are disallowed; skip disallowed paths |

---

## "Looks Done But Isn't" Checklist

After implementing the TheBump adapter and shared infrastructure, verify each of the following — the pipeline will appear functional without these checks passing:

- [ ] TheBump posts appear in the `posts` table with non-null `external_id`, `title`, and `body` after a real poll cycle
- [ ] `external_id` values are numeric strings matching the post's URL-embedded ID (not the full slug)
- [ ] `posted_at` is non-null for at least 90% of ingested TheBump posts
- [ ] The `posts.body` column contains no `<p>`, `<br>`, or `&amp;` strings for TheBump posts
- [ ] TheBump `source.last_polled_at` updates after each cycle
- [ ] Re-polling the same TheBump page produces zero new DB inserts (UNIQUE constraint works correctly)
- [ ] Reddit ingestion still works after the shared infrastructure refactor — run the existing ingestion with a real Reddit source and confirm posts appear
- [ ] `fetchActiveSources` returns both Reddit and TheBump source rows when both types exist in `sources`
- [ ] A TheBump post describing the same offer as an existing Reddit offer is deduplicated (linked to the existing offer via `post_offers`, not creating a new `offers` row)
- [ ] Cloudflare challenge page detection works: a mocked 403 response from TheBump emits `thebump_challenge_detected` at `warn` and returns `[]` without throwing
- [ ] Pagination stops when the oldest post on a page is older than `since` — verify with `since = 30 minutes ago` that no posts older than 30 minutes are returned
- [ ] `pnpm eval` recall does not degrade after adding TheBump test pairs to `labeled-posts.json`
- [ ] Tier 0 keyword filter correctly processes TheBump post text (run 5 known freebies posts through and confirm they pass)
- [ ] No TypeScript errors on `strict` after refactor — run `pnpm build` clean
- [ ] `config.ts` env validation fails fast with a clear error if TheBump-specific env vars are missing

---

## Recovery Strategies

| Pitfall | Recovery |
|---------|---------|
| TheBump selectors break on site update | Roll back selector changes; the adapter returns `[]` which is safe (no bad data inserted). Fix selectors against the new markup using browser DevTools. Add `[data-testid]`-based selectors as primary, class-based as fallback. |
| Reddit adapter broken by refactor | `git revert` the shared infrastructure PR. Re-run ingestion with the reverted code. Then re-approach the refactor in smaller steps: first make `fetchActiveSources` type-agnostic without changing `runIngestionCycle`, run Reddit, then add TheBump dispatch. |
| Duplicate `external_id` strategy creates DB duplicates | Write a one-time migration: `DELETE FROM posts WHERE source_id = <thebump_source_id> AND id NOT IN (SELECT MIN(id) FROM posts GROUP BY source_id, external_id)`. Fix the ID extraction logic and re-poll. |
| Pagination loop runs indefinitely | Add a `MAX_PAGES = 10` hard cap as an emergency guard (should already exist per Pitfall 4). Kill the worker, deploy with the cap, restart. |
| 0.85 threshold creates cross-source duplicates | Lower threshold to 0.80 via `EMBEDDING_SIMILARITY_THRESHOLD` config constant. Re-run `pnpm eval` to confirm no false-positive dedup on non-duplicate pairs. The config change is hot — no DB migration needed. |
| TheBump Cloudflare block | Increase inter-request jitter to 3–5 seconds. Reduce polling frequency to 20-minute intervals. Add a random delay at the start of each poll cycle. If block persists, implement exponential backoff per-source. |
| HTML body stored with markup (`.html()` bug) | Backfill: run a one-time update on `posts` table to strip HTML tags from `body` where `source_id = <thebump_source_id>`. Use a simple `body ~ '<[^>]+>'` regex in SQL to identify affected rows. Fix the `.text()` call in the adapter. |

---

## Pitfall-to-Phase Mapping

| Pitfall | Phase to Prevent |
|---------|-----------------|
| 1. DOM selector fragility | Phase 1: TheBump adapter — assertion guards on selector results |
| 2. Breaking Reddit during refactor | Phase 2: Shared infrastructure — atomic Reddit migration with regression test |
| 3. Unstable external_id derivation | Phase 1: TheBump adapter — ID extraction rule defined first |
| 4. Pagination infinite loop / missing posts | Phase 1: TheBump adapter — three termination conditions + MAX_PAGES cap |
| 5. Anti-scraping / Cloudflare blocks | Phase 1: TheBump adapter — jitter, headers, challenge detection |
| 6. Date parsing fragility | Phase 1: TheBump adapter — date parser unit tests before integration |
| 7. HTML entity / markup corruption | Phase 1: TheBump adapter — `.text()` + body validation in first integration test |
| 8. ingest.ts source type hard-coding | Phase 2: Shared infrastructure — first change before any TheBump adapter work |
| 9. Adapter registration pattern divergence | Phase 2: Shared infrastructure — atomic Reddit migration, remove old export |
| 10. Embedding dedup cross-source mismatch | Phase 1 (eval set extension) + Phase 2 (threshold validation) |

---

## Sources

- Existing codebase: `/apps/worker/src/ingestion/source-adapter.ts`, `reddit-adapter.ts`, `ingest.ts`, `index.ts`
- Existing codebase: `/apps/worker/src/dedup/url-hash.ts`, `embedding-dedup.ts`
- Existing codebase: `/apps/worker/src/config.ts`, `/packages/db/src/types.ts`
- Project context: `/.planning/PROJECT.md` (v1.1 milestone, current state)
- Stack: Cheerio HTML parsing, Node.js `fetch`, Supabase Postgres, pgvector, pgmq, Voyage AI, @anthropic-ai/sdk
- Prior v1.0 pitfalls: `/.planning/research/PITFALLS.md` (snoowrap, pgmq, pgvector, AI classification, URL normalization, Reddit-specific, dedup, validation)

*Last updated: 2026-04-21 — v1.1 Forum Adapters milestone*
