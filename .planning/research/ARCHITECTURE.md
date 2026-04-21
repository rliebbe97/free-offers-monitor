# Architecture Research

**Domain:** Forum scraping adapter infrastructure
**Researched:** 2026-04-21
**Confidence:** HIGH

---

## Standard Architecture

### System Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                               WORKER (Railway)                                 │
│                                                                                │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  Ingestion Layer (apps/worker/src/ingestion/)                            │  │
│  │                                                                          │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │  │
│  │  │  Shared adapter infrastructure (NEW v1.1)                        │   │  │
│  │  │  ┌─────────────────┐   ┌────────────────────────────────────┐   │   │  │
│  │  │  │  SourceAdapter  │   │  BaseForumAdapter (abstract class)  │   │   │  │
│  │  │  │  interface      │   │  - fetchPage(url): Cheerio root     │   │   │  │
│  │  │  │  (EXISTING)     │   │  - normalizePost(raw): RawPost      │   │   │  │
│  │  │  └────────┬────────┘   │  - shouldSkipPost(raw): boolean     │   │   │  │
│  │  │           │ implements  └────────────────────┬───────────────┘   │   │  │
│  │  │           │                                  │ extends            │   │  │
│  │  │  ┌────────┴──────────────┐    ┌─────────────┴──────────────┐    │   │  │
│  │  │  │  RedditAdapter        │    │  TheBumpAdapter (NEW v1.1)  │    │   │  │
│  │  │  │  (EXISTING)           │    │  - Cheerio scraping         │    │   │  │
│  │  │  │  - snoowrap OAuth     │    │  - freebies/deals subforums │    │   │  │
│  │  │  │  - top-level comments │    │  - pagination handling      │    │   │  │
│  │  │  │  + one reply deep     │    │  - thread-level scraping    │    │   │  │
│  │  │  └───────────────────────┘    └────────────────────────────┘    │   │  │
│  │  └──────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                          │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Adapter registry / ingest.ts (MODIFIED v1.1)                      │ │  │
│  │  │  - fetchActiveSources() now fetches type='reddit' AND type='bump'  │ │  │
│  │  │  - createAdapterForSource(source) factory resolves adapter by type  │ │  │
│  │  │  - runIngestionCycle() is source-type-agnostic                     │ │  │
│  │  └────────────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Pipeline (unchanged from v1.0)                                         │   │
│  │  Tier 0 → tier1_queue → Tier 1 (Haiku) → tier2_queue                   │   │
│  │         → Tier 2 (Sonnet) → dedup → offers / human_review_queue        │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Validation loop (unchanged from v1.0)                                  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  Concurrent loops (index.ts — MODIFIED v1.1):                                  │
│  Promise.all([                                                                 │
│    runIngestionLoop(db, shutdown),     ← renamed; now multi-adapter            │
│    runTier1ConsumerLoop(...),          ← unchanged                             │
│    runTier2ConsumerLoop(...),          ← unchanged                             │
│    runValidationLoop(...),             ← unchanged                             │
│  ])                                                                            │
└────────────────────────────────────────────────────────────────────────────────┘

DB: sources table drives adapter dispatch
  sources.type = 'reddit' → RedditAdapter
  sources.type = 'bump'   → TheBumpAdapter
```

### Component Responsibilities

| Component | Location | Status | Owns |
|-----------|----------|--------|------|
| `SourceAdapter` interface | `ingestion/source-adapter.ts` | EXISTING — no change | Contract: `fetchNewPosts(since: Date): Promise<RawPost[]>` |
| `RawPost` type | `ingestion/source-adapter.ts` | EXISTING — no change | Data shape adapter outputs: external_id, url, title, body, author, posted_at |
| `RedditAdapter` | `ingestion/reddit-adapter.ts` | EXISTING — no change | snoowrap OAuth, bot filtering, top-level + one-reply-deep traversal |
| `BaseForumAdapter` | `ingestion/base-forum-adapter.ts` | NEW | Cheerio page fetching, retry/error handling, shared post-filtering logic |
| `TheBumpAdapter` | `ingestion/thebump-adapter.ts` | NEW | TheBump-specific URL patterns, CSS selectors, subforum pagination, thread parsing |
| `createAdapterForSource()` | `ingestion/ingest.ts` | MODIFIED | Factory: resolves source type → adapter instance |
| `fetchActiveSources()` | `ingestion/ingest.ts` | MODIFIED | Remove `.eq('type', 'reddit')` filter — fetch all active sources |
| `runIngestionLoop()` | `apps/worker/src/index.ts` | MODIFIED (rename only) | Rename `runRedditIngestionLoop` → `runIngestionLoop`; no logic change |
| `scraping-utils.ts` | `ingestion/scraping-utils.ts` | NEW | Shared: `fetchWithRetry()`, `followOneRedirect()`, User-Agent rotation, rate-limit sleep |
| `config.ts` | `apps/worker/src/config.ts` | MODIFIED | Add `THEBUMP_POLL_INTERVAL_MS`, `SCRAPING_REQUEST_TIMEOUT_MS`, env var for TheBump base URL |
| Tier 0–2 processors | `tiers/` | EXISTING — no change | Classification is source-agnostic; RawPost flows through unchanged |
| dedup, queue, validation | `dedup/`, `queue/`, `validation/` | EXISTING — no change | All downstream of ingestion; source type is invisible to them |
| `sources` DB table | `packages/db/src/schema.sql` | EXISTING — no change | `type` column already accepts any string; TheBump rows use `type='bump'` |
| `@repo/db` types | `packages/db/src/types.ts` | EXISTING — no change | `Source` type already generic; no new columns needed |

---

## Recommended Project Structure

```
apps/worker/src/
  ingestion/
    source-adapter.ts          # EXISTING — SourceAdapter interface + RawPost type
    reddit-adapter.ts          # EXISTING — RedditAdapter (no changes)
    base-forum-adapter.ts      # NEW — abstract base for HTTP/Cheerio adapters
    thebump-adapter.ts         # NEW — TheBumpAdapter implements SourceAdapter
    scraping-utils.ts          # NEW — shared fetch, retry, redirect-follow helpers
    ingest.ts                  # MODIFIED — adapter factory, source-type-agnostic loop
  tiers/                       # EXISTING — no changes
  dedup/                       # EXISTING — no changes
  queue/                       # EXISTING — no changes
  validation/                  # EXISTING — no changes
  config.ts                    # MODIFIED — TheBump env + polling constants
  index.ts                     # MODIFIED — rename Reddit loop to generic ingestion loop
  logger.ts                    # EXISTING — no changes
```

No new packages. No new DB tables. No dashboard changes.

### Structure Rationale

**`base-forum-adapter.ts` as abstract class (not interface):** TheBump scraping needs concrete shared behavior — `fetchWithRetry`, Cheerio parsing wiring, `shouldSkipPost` guards (spam, deleted, too-short body). An abstract class lets `TheBumpAdapter` inherit this behavior without duplicating it, while `RedditAdapter` keeps using snoowrap and ignores the base class entirely (it implements `SourceAdapter` directly as it does today).

**`scraping-utils.ts` as a separate module:** `fetchWithRetry`, redirect-following, and User-Agent management are pure utilities with no adapter state. Extracting them makes both `BaseForumAdapter` and future adapters independently testable. The existing dedup module already uses a similar redirect-follow pattern in `url-hash.ts` — `scraping-utils.ts` does NOT duplicate that; it focuses on page-fetching concerns, not URL normalization.

**`thebump-adapter.ts` as a leaf adapter:** TheBump has two subforums to scan (freebies + deals), paginated thread lists, and per-thread post scraping. All TheBump-specific CSS selectors, URL construction, and pagination logic live here. Nothing from TheBump leaks into `ingest.ts` or the pipeline.

**`ingest.ts` modification (not rewrite):** The existing `fetchActiveSources` + `runIngestionCycle` structure is kept. Two targeted changes: (1) remove the `.eq('type', 'reddit')` filter so all source types are fetched, (2) replace the inline `createRedditAdapter(source.identifier)` call with a `createAdapterForSource(source)` factory that switches on `source.type`. The per-post upsert + Tier 0 + enqueue logic is unchanged.

---

## Architectural Patterns

### Adapter pattern via `SourceAdapter` interface

```typescript
// source-adapter.ts — already exists, no change
export interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
```

Both `RedditAdapter` and `TheBumpAdapter` implement this interface. `ingest.ts` only calls `fetchNewPosts` — it has zero knowledge of scraping mechanics.

### Abstract base class for HTTP/Cheerio adapters

```typescript
// base-forum-adapter.ts — NEW
export abstract class BaseForumAdapter implements SourceAdapter {
  abstract fetchNewPosts(since: Date): Promise<RawPost[]>;

  protected async fetchPage(url: string): Promise<CheerioAPI> {
    // Uses scraping-utils.fetchWithRetry internally
  }

  protected shouldSkipPost(body: string | null): boolean {
    // Too short, deleted marker, spam signals
  }
}
```

`TheBumpAdapter extends BaseForumAdapter`. `RedditAdapter` does NOT extend it — Reddit adapter uses snoowrap, not Cheerio.

### Config-driven source registration (DB-side)

Sources are registered as rows in the `sources` table, not hardcoded in TypeScript. The `config` JSONB column on `sources` carries adapter-specific config (e.g., subforum URLs, max pages per poll):

```sql
-- Example TheBump source row
INSERT INTO sources (type, identifier, config) VALUES (
  'bump',
  'thebump-freebies',
  '{
    "base_url": "https://community.thebump.com",
    "subforum_paths": ["/freebies", "/deals-and-coupons"],
    "max_pages_per_poll": 3
  }'
);
```

The adapter factory in `ingest.ts` reads `source.config` and passes it to the adapter constructor. New adapters in future milestones only need a new DB row + a new adapter class — no code changes to `ingest.ts`.

### Factory function in `ingest.ts`

```typescript
// ingest.ts — MODIFIED
function createAdapterForSource(source: Source): SourceAdapter {
  switch (source.type) {
    case 'reddit':
      return createRedditAdapter(source.identifier);
    case 'bump':
      return createTheBumpAdapter(source.identifier, source.config);
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
}
```

### Scraping utility pattern

```typescript
// scraping-utils.ts — NEW
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 3,
): Promise<Response> { ... }

// Rate-limit sleep between TheBump page requests (no OAuth backoff like Reddit)
export async function respectfulDelay(ms = 1500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
```

These are stateless pure functions — no class, no singleton.

---

## Data Flow

TheBump posts flow through the existing pipeline identically to Reddit posts. The source type becomes invisible after the `RawPost[]` boundary:

```
TheBumpAdapter.fetchNewPosts(since)
  └─ scrapes subforum thread list pages (Cheerio)
  └─ for each thread newer than `since`:
       └─ scrapes thread page (Cheerio)
       └─ maps each post/reply → RawPost

ingest.ts: runIngestionCycle()
  └─ for each RawPost:
       └─ upsert to posts table (UNIQUE source_id, external_id) ← same as Reddit
       └─ Tier 0 keyword filter on title + body              ← same as Reddit
       └─ if passes: enqueue to tier1_queue                  ← same as Reddit
       └─ update posts.pipeline_status                       ← same as Reddit

Tier 1 consumer (Haiku)  ← unchanged, processes post_id off queue
Tier 2 consumer (Sonnet) ← unchanged, processes post_id off queue
Dedup (URL hash + Voyage) ← unchanged
Validation cron           ← unchanged
Dashboard                 ← unchanged
```

Key invariant: `posts.source_id` links back to the TheBump source row, but no downstream component queries by `source_id`. The pipeline is source-blind from Tier 0 onward.

### `external_id` construction for TheBump

TheBump threads and posts have numeric IDs in their URLs (e.g., `https://community.thebump.com/t/thread-title/123456/7`). Use the thread ID + post number as the `external_id` (e.g., `"t123456-p7"`). This guarantees UNIQUE(source_id, external_id) uniqueness without colliding with Reddit's alphanumeric IDs.

### `posted_at` for TheBump

Parse the timestamp from the `<time>` element's `datetime` attribute in each post. Fall back to `null` if absent — the ingestion loop will still process the post; `since`-based filtering is skipped for null timestamps (treat as "could be new").

---

## Integration Points

| Integration Point | Existing Code | What Changes |
|-------------------|---------------|--------------|
| `SourceAdapter` interface | `ingestion/source-adapter.ts` | No change. TheBumpAdapter implements it. |
| `fetchActiveSources()` | `ingestion/ingest.ts` line 13 | Remove `.eq('type', 'reddit')` filter — fetch all types. |
| `runIngestionCycle()` | `ingestion/ingest.ts` line 36 | Replace inline `createRedditAdapter` with `createAdapterForSource(source)` factory. Remove `redditSources` filter at line 38. |
| Worker entry point | `apps/worker/src/index.ts` | Rename `runRedditIngestionLoop` → `runIngestionLoop`. No other changes. |
| `sources` DB table | `packages/db/src/schema.sql` | No schema change. Insert TheBump rows with `type='bump'`. |
| `config.ts` | `apps/worker/src/config.ts` | Add `SCRAPING_REQUEST_TIMEOUT_MS`, optional `THEBUMP_BASE_URL` env var override. |
| Tier 0–2 pipeline | `tiers/` | No changes. `post_id` UUID is source-agnostic. |
| Dedup | `dedup/` | No changes. |
| Validation | `validation/` | No changes. `offers.destination_url` from TheBump flows through identically. |
| Dashboard | `apps/dashboard/` | No changes needed for v1.1. Source column on offer list could show "TheBump" vs "Reddit" in a future milestone. |

---

## Anti-Patterns

**Do NOT add a TheBump ingestion loop in `index.ts` alongside the Reddit loop.** The existing `runIngestionLoop` handles all sources by reading the `sources` table. Adding a parallel `runTheBumpIngestionLoop` would duplicate polling logic, split `last_polled_at` updates, and make it impossible to add source 3 without another loop.

**Do NOT hardcode TheBump URLs in TypeScript.** Subforum paths belong in `sources.config` JSONB, not in `thebump-adapter.ts` constants. The adapter reads them from the config passed by `ingest.ts`. This is what makes the infrastructure "config-driven."

**Do NOT use Playwright in the TheBump adapter for v1.1.** TheBump's community forum renders server-side HTML — Cheerio is sufficient. Playwright is reserved for the validation cron's JS-heavy offer pages (as noted in PITFALLS.md section 8.2). Using Playwright in the hot ingestion path adds 2–5 second latency per page.

**Do NOT query `source_id` in Tier 1 or Tier 2 processors.** These tiers receive only a `post_id` from the queue. Reading source metadata inside Tier 1/2 would couple classification logic to ingestion concerns. If source-specific prompt adjustments are ever needed (e.g., different prompts for forum vs Reddit), pass a `source_type` field in the pgmq message payload — don't reach back to the `sources` table inside the tier processor.

**Do NOT skip the Tier 0 keyword filter for TheBump posts.** TheBump forums contain deal posts, coupon posts, and questions — most will not pass Tier 0. TheBump has lower signal-to-noise than a dedicated freebies subreddit. Bypassing Tier 0 would send significant Haiku traffic for posts that fail at keyword filtering. The filter runs inline in `runIngestionCycle` for all source types already.

**Do NOT extend `RedditAdapter` for TheBump.** `RedditAdapter` is tightly coupled to snoowrap and Reddit API shapes. TheBump needs HTTP+Cheerio. Shared adapter behavior belongs in `BaseForumAdapter` — a separate abstract class that Reddit never inherits from.

**Do NOT reuse the Reddit `shouldSkipAuthor` function for TheBump.** That function checks for Reddit-specific patterns (bot name patterns, `[deleted]`, `[removed]`, `distinguished` field). TheBump has different spam/delete indicators — implement `shouldSkipPost` on `BaseForumAdapter` with TheBump-appropriate signals (deleted post markers, extremely short body, staff/moderator badges).

---

## Build Order

Dependencies flow downward — each step unblocks the next.

**Step 1: `scraping-utils.ts`** (no dependencies in worker)
- `fetchWithRetry(url, options, maxRetries)` using native `fetch`
- `respectfulDelay(ms)` for rate limiting between page requests
- User-Agent string constant (identify the bot honestly)
- Unit testable in isolation

**Step 2: `base-forum-adapter.ts`** (depends on `scraping-utils.ts`)
- Abstract class implementing `SourceAdapter`
- `protected fetchPage(url): Promise<CheerioAPI>` — wraps scraping-utils
- `protected shouldSkipPost(body: string | null): boolean` — shared guard
- Vitest unit tests with mocked `fetchWithRetry`

**Step 3: `thebump-adapter.ts`** (depends on `base-forum-adapter.ts`)
- `TheBumpAdapter extends BaseForumAdapter`
- `fetchNewPosts(since)`: scrape subforum thread list → per-thread posts
- Map scraped HTML → `RawPost[]` with correct `external_id` construction
- Vitest unit tests with Cheerio fixture HTML snapshots (record real pages once, test deterministically)

**Step 4: `ingest.ts` modifications** (depends on `thebump-adapter.ts`)
- Remove `.eq('type', 'reddit')` from `fetchActiveSources`
- Add `createAdapterForSource(source)` factory
- Remove `redditSources` filtering from `runIngestionCycle`
- Existing tests still pass; add integration test for TheBump source type dispatch

**Step 5: `config.ts` additions** (independent, can be done alongside Step 1)
- `SCRAPING_REQUEST_TIMEOUT_MS = 10_000`
- `getEnvOrThrow('THEBUMP_BASE_URL')` only if you want to override the base URL in tests; otherwise hardcode as a constant in `thebump-adapter.ts`

**Step 6: `index.ts` rename** (depends on Step 4)
- Rename `runRedditIngestionLoop` → `runIngestionLoop` — one-line change

**Step 7: DB source row insertion** (independent — can be done anytime)
- Insert TheBump source rows into `sources` table via Supabase SQL editor
- No schema migration needed

**Step 8: End-to-end smoke test**
- Run worker in dev mode, verify TheBump posts appear in `posts` table
- Verify `pipeline_status` progresses through `tier0_passed` / `tier0_rejected`
- Check Tier 1 queue receives TheBump post IDs

---

## Sources

- `/apps/worker/src/ingestion/source-adapter.ts` — existing `SourceAdapter` interface and `RawPost` type
- `/apps/worker/src/ingestion/reddit-adapter.ts` — existing `RedditAdapter` implementation pattern
- `/apps/worker/src/ingestion/ingest.ts` — existing `fetchActiveSources` + `runIngestionCycle` (hardcoded Reddit filter at line 14 and 38)
- `/apps/worker/src/index.ts` — existing 4-loop `Promise.all` structure
- `/apps/worker/src/config.ts` — existing env validation and constants
- `/packages/db/src/schema.sql` — `sources.type` column, `sources.config` JSONB, `UNIQUE(source_id, external_id)` constraint
- `/packages/db/src/types.ts` — `Source` type (already generic — no new columns needed)
- `/.planning/PROJECT.md` — v1.1 milestone goals: TheBump adapter + shared adapter infrastructure
- `/.planning/research/PITFALLS.md` — sections 5 (URL normalization), 8.2 (Playwright only for validation)
- `/.planning/research/STACK.md` — Cheerio 1.2.0 already in stack; `p-retry` and `p-limit` available
