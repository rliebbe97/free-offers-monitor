# Roadmap: Free Offers Monitor

## Milestones

- ✅ **v1.0 MVP** — Phases 1-4 (shipped 2026-04-21)
- 🔄 **v1.1 Forum Adapters** — Phases 5-6 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-4) — SHIPPED 2026-04-21</summary>

- [x] Phase 1: DB Foundation & Shared Package (1/1 plan) — completed 2026-04-20
- [x] Phase 2: Worker Pipeline — Ingestion, Classification, Dedup & Logging (3/3 plans) — completed 2026-04-20
- [x] Phase 3: Offer Validation Cron (1/1 plan) — completed 2026-04-20
- [x] Phase 4: Dashboard (2/2 plans) — completed 2026-04-21

</details>

### v1.1 Forum Adapters (Phases 5-6)

- [ ] Phase 5: TheBump Adapter
- [ ] Phase 6: Shared Adapter Infrastructure + Reddit Migration

---

# Roadmap: Free Offers Monitor v1.1

**Milestone:** v1.1 Forum Adapters
**Goal:** Expand ingestion beyond Reddit with a TheBump community adapter and reusable adapter infrastructure.
**Phases:** 2
**Requirements:** 15
**Created:** 2026-04-21

## Phase 5: TheBump Adapter

**Goal:** Build the TheBump Cheerio scraping adapter in isolation — scraping utilities, base class, adapter implementation, DB source rows, and eval coverage — without touching the Reddit production code path.
**Requirements:** INGEST-01, INGEST-02, INGEST-05, BUMP-01, BUMP-02, BUMP-03, BUMP-04, BUMP-05, BUMP-06, BUMP-07, BUMP-08, QUAL-01

### Success Criteria

1. Running `pnpm test --filter worker` shows passing unit tests for `scraping-utils.ts` (fetchWithRetry, respectfulDelay, User-Agent), `TheBumpAdapter` date parsing (relative and `<time datetime="">` formats), `external_id` extraction from URLs, and Cloudflare challenge page detection.
2. A developer can manually invoke `TheBumpAdapter.fetchNewPosts(since)` against the live TheBump freebies/deals subforums and see `RawPost[]` records appearing in the `posts` table with `source_id` referencing the seeded TheBump source rows, advancing through Tier 0 inline and landing in `tier1_queue`.
3. The eval dataset at `evals/labeled-posts.json` contains at least 10 TheBump post examples with known `tier1_expected` and `tier2_expected` labels, and `pnpm eval` passes without regression on existing Reddit entries.
4. Pagination logs emit `thebump_pagination_stop` with a `reason` field (`no_next_link`, `oldest_before_since`, or `max_pages`) on every crawl, and no single crawl fetches more than `MAX_PAGES = 10` pages.
5. Selecting the two seeded rows from the `sources` table returns `type='bump'` entries with correct `identifier` and `config` JSONB including subforum URLs for both freebies and deals categories.

### Notes

**Build order:** `scraping-utils.ts` → `base-forum-adapter.ts` → `thebump-adapter.ts` → `config.ts` constants → DB seed migration → eval entries.

**Critical correctness traps (do not defer to hardening):**
- Extract `external_id` as numeric suffix only from post URLs (e.g., `4829183` from `.../free-diapers-sample-4829183`). Validate against `/^\d+$/` and throw `ScrapeError` on failure — never use the mutable title slug.
- Body extraction: always `.text()` never `.html()`. Validate no `<` or `>` characters remain in stored body.
- Date parsing: attempt `<time datetime="">` attribute first; fall back to English relative-date parser for "2 hours ago" etc.; on failure set `posted_at = null` and include the post (never silently drop).
- Challenge page detection: check `$('title').text()` for "Just a moment" / "Checking your browser" before assuming zero results; emit `thebump_challenge_detected` warn log.
- Selector assertions: target semantic attributes (`[data-testid]`, `<time datetime>`, `<article>`) over build-hash class names like `PostListItem_title__3xQzM` which regenerate on TheBump deploys.

**p-throttle:** Add `p-throttle` 8.1.0 as the new production dependency for time-windowed rate limiting (1 req/2s). This complements the existing `p-retry` (retries) and `p-limit` (concurrency) without overlap.

**Reddit adapter is untouched in this phase.** `ingest.ts` still has its Reddit-only filter during Phase 5 — TheBump can be unit-tested and DB-smoke-tested via direct adapter invocation without the dispatch factory. The filter removal is an atomic Phase 6 migration.

**Live HTML fixture:** Pull at least one TheBump subforum listing page and one thread page as Vitest fixture files before writing selectors. Do not infer selectors from Vanilla Forums conventions alone — confirm `<time datetime="">` presence and the exact CSS path to post body on TheBump's current build.

---

## Phase 6: Shared Adapter Infrastructure + Reddit Migration

**Goal:** Atomically migrate the production ingestion loop to a type-agnostic source dispatch factory, enabling both Reddit and TheBump adapters to run through the same `runIngestionCycle` path, and validate cross-source dedup correctness.
**Requirements:** INGEST-03, INGEST-04, QUAL-02

### Success Criteria

1. `fetchActiveSources` in `ingest.ts` no longer contains `.eq('type', 'reddit')` — it returns all active source rows regardless of type, and `createAdapterForSource()` factory switches on `source.type` to instantiate either `RedditAdapter` or `TheBumpAdapter`.
2. The `Promise.all` in `apps/worker/src/index.ts` calls `runIngestionLoop` (not `runRedditIngestionLoop`), and both Reddit and TheBump sources complete full ingestion cycles in a single dev-mode worker run with no errors.
3. The existing Reddit Vitest tests all pass after the migration without modification — no behavioral regression in `since`-semantics, dedup, or pgmq enqueue behavior.
4. `evals/labeled-posts.json` contains at least 10 Reddit+TheBump cross-source offer pairs (same physical offer posted on both platforms), and `pnpm eval` reports dedup cosine scores to Axiom; the 0.85 threshold either holds or is adjusted with a documented rationale.
5. Removing the old `createRedditAdapter` direct call from production code and adding the factory dispatch is a single atomic commit — no intermediate state where both the old call and the factory coexist in `ingest.ts`.

### Notes

**Do the `ingest.ts` filter removal first** (before writing the factory) — this is Pitfall 8 from research. The `.eq('type', 'reddit')` line is the single guard preventing TheBump sources from ever being fetched. Remove it, run the test suite, then add the factory dispatch.

**Atomic Reddit migration (Pitfall 9):** The old `createRedditAdapter` direct call and the new `createAdapterForSource()` factory must land in the same commit. Splitting across commits leaves a window where production code has an unresolved dispatch for `type='bump'` sources.

**Dedup threshold empirical validation:** The 0.85 cosine threshold is theoretically sound but unconfirmed against real cross-source data. After Phase 5 ships and TheBump produces posts, use the cross-source eval pairs added in this phase to measure actual cosine scores. If the distribution shows the threshold needs tuning, update `EMBEDDING_SIMILARITY_THRESHOLD` in `config.ts` and document the empirical rationale.

**`runIngestionLoop` rename:** Update the export in `apps/worker/src/ingestion/index.ts` (or wherever the loop is exported), the import in `apps/worker/src/index.ts`, and any references in tests or comments. Search for all occurrences of `runRedditIngestionLoop` before marking complete.

**Type safety:** `createAdapterForSource()` should have a `default` branch that throws `new Error(\`Unknown source type: \${source.type}\`)` — never silently ignore an unrecognized type.

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. DB Foundation & Shared Package | v1.0 | 1/1 | Complete | 2026-04-20 |
| 2. Worker Pipeline | v1.0 | 3/3 | Complete | 2026-04-20 |
| 3. Offer Validation Cron | v1.0 | 1/1 | Complete | 2026-04-20 |
| 4. Dashboard | v1.0 | 2/2 | Complete | 2026-04-21 |
| 5. TheBump Adapter | v1.1 | 0/— | Not started | — |
| 6. Shared Adapter Infrastructure + Reddit Migration | v1.1 | 0/— | Not started | — |

## Coverage

| Requirement | Phase |
|-------------|-------|
| DB-01 | 1 |
| DB-02 | 1 |
| DB-03 | 1 |
| DB-04 | 1 |
| ING-01 | 2 |
| ING-02 | 2 |
| ING-03 | 2 |
| ING-04 | 2 |
| ING-05 | 2 |
| CLS-01 | 2 |
| CLS-02 | 2 |
| CLS-03 | 2 |
| CLS-04 | 2 |
| CLS-05 | 2 |
| CLS-06 | 2 |
| DDP-01 | 2 |
| DDP-02 | 2 |
| DDP-03 | 2 |
| DDP-04 | 2 |
| VAL-01 | 3 |
| VAL-02 | 3 |
| VAL-03 | 3 |
| VAL-04 | 3 |
| VAL-05 | 3 |
| LOG-01 | 2 |
| LOG-02 | 2 |
| DSH-01 | 4 |
| DSH-02 | 4 |
| DSH-03 | 4 |
| DSH-04 | 4 |
| WRK-01 | 2 |
| WRK-02 | 2 |
| WRK-03 | 2 |
| INGEST-01 | 5 |
| INGEST-02 | 5 |
| INGEST-03 | 6 |
| INGEST-04 | 6 |
| INGEST-05 | 5 |
| BUMP-01 | 5 |
| BUMP-02 | 5 |
| BUMP-03 | 5 |
| BUMP-04 | 5 |
| BUMP-05 | 5 |
| BUMP-06 | 5 |
| BUMP-07 | 5 |
| BUMP-08 | 5 |
| QUAL-01 | 5 |
| QUAL-02 | 6 |

**Coverage:** 48/48 ✓ (v1.0: 33/33, v1.1: 15/15)
