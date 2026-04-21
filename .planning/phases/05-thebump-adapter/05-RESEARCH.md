# Phase 5: TheBump Adapter — Research

**Researched:** 2026-04-21
**Status:** Complete

---

## 1. Existing Adapter Pattern

### SourceAdapter Interface
File: `apps/worker/src/ingestion/source-adapter.ts` (lines 1–20)

```ts
export interface RawPost {
  external_id: string;      // required, no null
  url: string;              // required, no null
  title: string | null;
  body: string | null;
  author: string | null;
  posted_at: Date | null;
}

export interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
```

Key observations:
- `external_id` and `url` are non-nullable — TheBump adapter must always produce valid values for both or skip the post entirely.
- `title` is nullable — TheBump thread titles go here; top-level post has title, comments/replies get `null`.
- `posted_at` is `Date | null` — pass `null` if parsing fails (matches BUMP-04 spec).
- The interface is minimal: one method, one return type. No optional methods.

### RedditAdapter Pattern
File: `apps/worker/src/ingestion/reddit-adapter.ts`

Class structure (lines 62–202):
```ts
export class RedditAdapter implements SourceAdapter {
  private readonly reddit: Snoowrap;
  private readonly subreddit: string;

  constructor(reddit: Snoowrap, subredditName: string) { … }

  async fetchNewPosts(since: Date): Promise<RawPost[]> { … }
}

export function createRedditAdapter(subredditName: string): RedditAdapter {
  const reddit = createRedditClient();
  return new RedditAdapter(reddit, subredditName);
}
```

Key patterns:
- **Named exports only** — no default export anywhere in the file.
- **Factory function** `createRedditAdapter` is the public construction API; internal `createRedditClient()` is not exported.
- **Filtering is inline** — `shouldSkipAuthor` is a **pure exported function** (line 18) tested in isolation. The adapter calls it inside the loop.
- **Structured logging at every decision point**: `reddit_skip_post`, `reddit_skip_comment`, `reddit_skip_reply`, `reddit_fetch_complete` — all use `logger.info(eventName, { fields })`.
- **No throwing on network errors** — errors caught in `ingest.ts` (line 54–60), adapter itself does not swallow silently.
- **`@ts-ignore` for external library incomplete types** — acceptable pattern per CLAUDE.md.

### How Ingestion Cycle Uses Adapters
File: `apps/worker/src/ingestion/ingest.ts`

Critical insight for Phase 5: the current `fetchActiveSources` function (lines 12–23) hard-codes `.eq('type', 'reddit')`. The TheBump adapter will need to be invoked outside this function until Phase 6 refactors the dispatch factory. Phase 5 scope = adapter + config + DB seed + evals only. TheBump loop wired in Phase 6.

The adapter output flows through these steps (lines 66–130):
1. Upsert to `posts` table with `{ onConflict: 'source_id,external_id' }` — idempotent re-poll.
2. `passesKeywordFilter(combinedText)` on `title + body`.
3. DB update with `tier0_passed` and `pipeline_status`.
4. `enqueueTier1(db, postId)` for passing posts.
5. `source.last_polled_at` update.

The `source_id` used in the upsert comes from the `sources` table row — confirming DB seed (BUMP-07) is required for the adapter to function end-to-end.

---

## 2. Scraping Utilities Design

### `fetchWithRetry` Signature

Based on p-retry 8.0.0 API and existing fetch patterns in `liveness-check.ts`:

```ts
// apps/worker/src/ingestion/scraping-utils.ts
export async function fetchWithRetry(
  url: string,
  options?: {
    timeoutMs?: number;     // default: SCRAPING_REQUEST_TIMEOUT_MS from config
    retries?: number;       // default: 3
    signal?: AbortSignal;
  }
): Promise<Response>
```

p-retry usage pattern (from its types):
```ts
import pRetry, { AbortError } from 'p-retry';

const response = await pRetry(
  async () => {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': SCRAPING_USER_AGENT },
    });
    // Throw AbortError on 4xx (not worth retrying) — except 429/503
    if (resp.status === 404 || resp.status === 410) {
      throw new AbortError(`HTTP ${resp.status}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  },
  {
    retries: options?.retries ?? 3,
    minTimeout: 1000,
    factor: 2,
    randomize: true,
    onFailedAttempt: (ctx) => {
      logger.warn('scrape_fetch_retry', { url, attempt: ctx.attemptNumber, error: String(ctx.error) });
    },
  }
);
```

### `respectfulDelay` with p-throttle

p-throttle 8.1.0 API (not yet installed, pure ESM, no dependencies):
```ts
import pThrottle from 'p-throttle';

// Create throttle: 1 call per 2000ms
const throttle = pThrottle({ limit: 1, interval: 2000 });

// Wrap the fetch function
export const fetchWithRateLimit = throttle(fetchWithRetry);
```

For random jitter (BUMP-08: 1–3s), the design should combine throttle with per-call jitter:
```ts
// respectfulDelay is a standalone utility used between page fetches in the base class loop
export async function respectfulDelay(): Promise<void> {
  const ms = 1000 + Math.random() * 2000; // 1–3s
  await new Promise((resolve) => setTimeout(resolve, ms));
}
```

The p-throttle approach guarantees minimum 2s between calls at the rate-limiter level, regardless of processing time. The additional `respectfulDelay()` provides variable human-like jitter between page fetches inside the pagination loop.

### User-Agent String

Existing pattern from `liveness-check.ts` (line 34): `'FreeOffersMonitor/1.0'`

Consistent convention to establish in `scraping-utils.ts`:
```ts
export const SCRAPING_USER_AGENT = 'FreeOffersMonitor/1.0 (+https://github.com/rliebbe97)';
```

### Logger Integration

Existing `logger` singleton from `apps/worker/src/logger.ts`:
- `logger.info(event, fields?)` — normal operation
- `logger.warn(event, fields?)` — recoverable issues (challenge detected, retry)
- `logger.error(event, fields?)` — failures

All scraping events must follow the `snake_case_event_name` + flat fields object pattern. Event naming convention from codebase: `{module}_{action}` e.g. `scrape_page_fetch`, `thebump_challenge_detected`, `thebump_skip_post`.

---

## 3. Base Forum Adapter Architecture

### Template Method Pattern

Decision D-02 specifies: base class owns `fetchNewPosts` loop; subclasses implement two abstract methods.

```ts
// apps/worker/src/ingestion/base-forum-adapter.ts
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { RawPost, SourceAdapter } from './source-adapter.js';

export abstract class BaseForumAdapter implements SourceAdapter {
  // Concrete — base class owns the pagination loop
  async fetchNewPosts(since: Date): Promise<RawPost[]> {
    // while loop: fetch page -> extractPostsFromPage -> getNextPageUrl
    // termination: no next link | oldest post > since | MAX_PAGES cap
    // on page failure (D-06): log + stop pagination, return collected so far
  }

  // Concrete — base class HTTP + Cheerio parsing
  protected async fetchPage(url: string): Promise<CheerioAPI> {
    // calls fetchWithRetry -> cheerio.load(text)
    // detects challenge page (D-07) via $('title').text()
    // throws ScrapeError on parse/challenge failure
  }

  // Concrete with override hook (D-03, D-08)
  protected shouldSkipPost(post: RawPost): boolean {
    if (!post.body || post.body.length < 20) return true;
    return false;
  }

  // Abstract — subclass extracts posts from one page
  protected abstract extractPostsFromPage($: CheerioAPI, pageUrl: string): RawPost[];

  // Abstract — subclass finds the "next page" URL or returns null
  protected abstract getNextPageUrl($: CheerioAPI): string | null;
}
```

### Pagination Loop Design

```
fetchNewPosts(since):
  results = []
  currentUrl = this.startUrl
  pageCount = 0

  while currentUrl and pageCount < MAX_PAGES:
    try:
      $ = await this.fetchPage(currentUrl)
      posts = this.extractPostsFromPage($, currentUrl)

      for post of posts:
        if this.shouldSkipPost(post): continue
        results.push(post)

      // Termination: check oldest post date
      if posts.length > 0 and all posts older than since: break

      nextUrl = this.getNextPageUrl($)
      if not nextUrl: break

      await respectfulDelay()  // BUMP-08
      currentUrl = nextUrl
      pageCount++

    catch (err):
      logger.error('forum_page_fetch_failed', { url: currentUrl, error: String(err) })
      break  // D-06: stop pagination, return what we have

  return results
```

Three termination conditions (BUMP-03):
1. `getNextPageUrl` returns `null` — no pagination link found.
2. Oldest post in page is older than `since` — we've caught up.
3. `pageCount >= MAX_PAGES` — hard cap to prevent infinite crawl.

### TheBump-Specific `shouldSkipPost` Override (D-09)

Subclass adds:
- Admin/staff badge detection via HTML attribute on post author element.
- Sticky/pinned thread detection via CSS class or data attribute on post container.
- Exact selectors determined during fixture analysis (left to implementer's discretion per D-09 note).

---

## 4. TheBump HTML & Selector Strategy

### What We Know (Cannot Fetch Live Pages)

From CONTEXT.md decisions and REQUIREMENTS.md:

**External ID Extraction (BUMP-02):**
TheBump post URLs follow the Vanilla Forums convention:
```
https://community.thebump.com/discussion/{numeric-id}/slug-title
```
or
```
https://community.thebump.com/discussion/comment/{numeric-id}/p1
```

External ID = numeric suffix only. Example: `4829183` from `.../free-diapers-sample-4829183`.

Extraction logic (strict, per CONTEXT.md critical traps):
```ts
const match = url.match(/\/(\d+)(?:\/|$)/);
if (!match || !/^\d+$/.test(match[1])) {
  throw new ScrapeError('PARSE', `Cannot extract external_id from URL: ${url}`);
}
const externalId = match[1];
```

**Date Parsing (BUMP-04):**
Priority order:
1. `$('time[datetime]').attr('datetime')` — ISO 8601 string → `new Date(datetime)`.
2. `$('time').text()` — English relative string (e.g. "2 hours ago", "January 5, 2025") → relative-date parser.
3. Fall through → `null` (never silently drop or guess).

**Body Extraction (BUMP-06):**
```ts
const body = $('[data-role="commentBody"] .userContent-body').text().trim().replace(/\s+/g, ' ');
// Validate: no HTML tags leaked
if (/<|>/.test(body)) throw new ScrapeError('PARSE', 'HTML leaked into body text');
```
`.text()` always, never `.html()`. Whitespace collapse with `.replace(/\s+/g, ' ')`.

**Challenge Page Detection (BUMP-05):**
```ts
const title = $('title').text().toLowerCase();
if (title.includes('just a moment') || title.includes('checking your browser')) {
  logger.warn('thebump_challenge_detected', { url });
  throw new ScrapeError('CHALLENGE', 'Cloudflare challenge detected');
}
```

**Selector Strategy:**
From CONTEXT.md critical traps: "Target semantic attributes over build-hash class names."
- Prefer: `[data-role="..."]`, `[itemtype="..."]`, `<time datetime="">`, `<article>`, `<header>`, semantic HTML5 elements.
- Avoid: `.css-a1b2c3` (Tailwind/CSS-module hashes that change on deploy).

Vanilla Forums conventions (TheBump runs on a Vanilla Forums variant):
- Post list container: typically `ul.DataList` or `div.ItemContent`
- Individual post/comment: `li.ItemDiscussion` or `div.Comment`
- Author: `a.Username` or `[rel="author"]`
- Post body: `div.Message` or `[data-role="commentBody"]`
- Timestamp: `time[datetime]`
- Pagination: `a[rel="next"]` or `.NextPage`
- Staff/admin badge: role badge span adjacent to username

**Note:** Exact selectors will be verified against real HTML fixtures during implementation. The implementer should capture live HTML snapshots before coding selectors.

---

## 5. Testing Strategy

### Vitest Configuration
File: `apps/worker/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      ANTHROPIC_API_KEY: 'test-key',
      REDDIT_CLIENT_ID: 'test-client-id',
      REDDIT_CLIENT_SECRET: 'test-client-secret',
      REDDIT_REFRESH_TOKEN: 'test-refresh-token',
      VOYAGE_API_KEY: 'test-voyage-key',
    },
  },
});
```

Any new env vars added to `config.ts` module-load validation must also be added here, otherwise tests fail at module import time.

### Existing Test Patterns

From `liveness-check.test.ts` and `validation-loop.test.ts`:

**Pattern 1: Pure functions** — direct import + unit test with `vi.stubGlobal('fetch', vi.fn())`.
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myPureFunction } from './my-module.js';  // .js extension required

describe('myPureFunction', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  it('returns X for input Y', () => { … });
});
```

**Pattern 2: Module mocking** — `vi.mock('./dep.js', () => ({ … }))` at top of file before imports.
```ts
vi.mock('./liveness-check.js', () => ({ checkLiveness: vi.fn() }));
import { runValidationCycle } from './validation-loop.js';
import { checkLiveness } from './liveness-check.js';
```

**Pattern 3: Mock DB factory** — manual chainable mock object (see `validation-loop.test.ts` lines 15–36). No Supabase client dependency in tests.

**Pattern 4: File extension** — all imports use `.js` extension even for `.ts` source files. Required for ESM.

### Fixture File Approach for HTML Snapshots

The codebase has no existing fixture directory, so Phase 5 establishes the convention. Recommended structure:
```
apps/worker/src/ingestion/__fixtures__/
  thebump-post-list-page.html      # real captured HTML, forum listing
  thebump-challenge-page.html      # Cloudflare challenge page
  thebump-empty-page.html          # empty/no-posts page
```

Test approach:
```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '__fixtures__/thebump-post-list-page.html'), 'utf-8');
```

### What to Unit Test vs Integration Test

**Unit test (isolated, no network, no DB):**
- `scraping-utils.ts`: `extractExternalId()`, URL validation, `respectfulDelay()` range.
- `thebump-adapter.ts`: `extractPostsFromPage($)` against HTML fixtures.
- `thebump-adapter.ts`: `getNextPageUrl($)` against fixture HTML with and without next link.
- `thebump-adapter.ts`: `shouldSkipPost()` override behavior.
- Date parsing logic: `<time datetime="">` extraction, relative-date parsing, null fallback.
- Challenge page detection: title text matching.
- External ID extraction: valid URL, missing ID, non-numeric ID (should throw `ScrapeError`).

**Integration test (optional, marked skip in CI):**
- Live TheBump fetch — skipped unless `INTEGRATION=1` env var set.
- DB smoke test — skipped unless `SUPABASE_URL` set.

**Not tested:**
- `fetchWithRetry` p-retry internals — test the HTTP outcome, not retry counting.
- `BaseForumAdapter.fetchPage` network call — mock `fetch` at global level.

---

## 6. DB Seed Migration

### Sources Table Schema
File: `packages/db/src/schema.sql` (lines 27–34)

```sql
CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL,          -- 'reddit' | 'discourse'
  identifier     text NOT NULL UNIQUE,   -- subreddit name or base URL
  config         jsonb NOT NULL DEFAULT '{}',
  last_polled_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

**Required columns for TheBump rows:**
- `type`: `'bump'`
- `identifier`: the subforum URL (e.g. `https://community.thebump.com/categories/freebies-and-deals`). Must be UNIQUE across all sources.
- `config`: JSONB — stores subforum-specific config. Suggested shape:
  ```json
  {
    "base_url": "https://community.thebump.com",
    "subforum_path": "/categories/freebies-and-deals",
    "max_pages": 5
  }
  ```
- `last_polled_at`: `null` on seed (first run sets it).

**Migration convention:**
No Supabase CLI migration files in the project yet. The pattern is: ad-hoc SQL applied via Supabase SQL editor. The `schema.sql` file is the single source of truth. For this phase:

- File: `packages/db/src/migrations/001_seed_thebump_sources.sql` (establish this as the migration naming convention).
- Alternatively, append a `-- SEED DATA` section to `schema.sql` with `INSERT ... ON CONFLICT DO NOTHING` for idempotency.

Recommended seed SQL:
```sql
-- Seed TheBump source rows (type='bump')
INSERT INTO sources (type, identifier, config)
VALUES
  (
    'bump',
    'https://community.thebump.com/categories/freebies-and-deals',
    '{"base_url": "https://community.thebump.com", "subforum_path": "/categories/freebies-and-deals", "max_pages": 5}'::jsonb
  )
ON CONFLICT (identifier) DO NOTHING;
```

Note: The `identifier` UNIQUE constraint means re-running the migration is safe.

### DB Types Impact

After seeding, the `Source` type from `@repo/db` (line 354 of `types.ts`) already handles `type: string` so no type changes needed. The `config: Json` field accepts the JSONB shape above.

---

## 7. Eval Data Structure

### Current State

The `evals/` directory does **not exist** in the repo. The `pnpm eval` script is referenced in CLAUDE.md as `pnpm eval — Run prompt eval script against labeled-posts.json` but is not yet defined in `package.json` or `turbo.json`.

Phase 5 must **create** the `evals/` directory with:
1. `evals/labeled-posts.json` — the dataset.
2. `evals/run-eval.ts` — the eval runner script.
3. A `pnpm eval` script in the root `package.json`.

### Labeled-Posts JSON Structure

Inferred from CLAUDE.md reference and Tier 1/2 schema. Each entry needs enough context for Tier 1 classification:

```json
[
  {
    "id": "thebump-4829183",
    "source": "thebump",
    "url": "https://community.thebump.com/discussion/4829183/free-diapers-sample",
    "external_id": "4829183",
    "title": "Free Diapers Sample from Pampers",
    "body": "Pampers is giving away free diaper samples...",
    "author": "BabyMomma2024",
    "posted_at": "2026-03-15T14:30:00Z",
    "label": "pass",
    "label_reason": "Genuinely free physical product, zero shipping",
    "notes": "Classic freebie post, clear signup link"
  },
  {
    "id": "thebump-4830001",
    "source": "thebump",
    "url": "https://community.thebump.com/discussion/4830001/50-off-baby-formula",
    "external_id": "4830001",
    "title": "50% off formula with coupon code",
    "body": "Use code BABY50 at checkout...",
    "author": "DealMommy",
    "posted_at": "2026-03-16T10:00:00Z",
    "label": "reject",
    "label_reason": "Coupon/discount, not free",
    "notes": "Common false positive for keyword filter"
  }
]
```

Key fields:
- `id`: unique across all sources, prefixed with source name.
- `source`: `'thebump'` | `'reddit'` | etc.
- `label`: `'pass'` | `'reject'` — the ground truth for Tier 1.
- `label_reason`: human explanation.
- `notes`: optional; helpful for debugging model failures.

**Label distribution (D-11):** ~50/50 split — approximately 5 pass + 5 reject for initial eval coverage (QUAL-01 requires coverage, not a specific count).

### Eval Runner Script

The `run-eval.ts` script (to be created at `evals/run-eval.ts`) should:
1. Read `labeled-posts.json`.
2. For each entry, call Tier 1 classifier with the post text.
3. Compare model decision to ground truth label.
4. Print precision/recall/accuracy summary.
5. Exit 0 if above threshold, exit 1 if not.

No existing implementation to reference — this is a new file. Pattern: standalone TypeScript script using `@anthropic-ai/sdk` directly.

---

## 8. Dependencies & Compatibility

### Existing Dependencies (confirmed installed)

| Package | Version | Type | Notes |
|---------|---------|------|-------|
| `cheerio` | `^1.0.0` → resolves to `1.2.0` | ESM | `import * as cheerio from 'cheerio'`; `CheerioAPI` type exported from main entry |
| `p-retry` | `8.0.0` | ESM | `import pRetry, { AbortError } from 'p-retry'`; default export + named `AbortError` |
| `p-limit` | `7.3.0` | ESM | Available but not needed for Phase 5 (no concurrency — sequential crawl) |
| `normalize-url` | `9.0.0` | ESM | Used by dedup pipeline, not adapter |

**Cheerio 1.2.0 API:**
- Import: `import * as cheerio from 'cheerio'` (matches existing `liveness-check.ts` pattern at line 1).
- `CheerioAPI` type: exported from both `'cheerio'` main and `'cheerio/slim'`.
- Load: `const $ = cheerio.load(htmlString)` → returns `CheerioAPI`.
- Selectors: standard CSS + jQuery extensions; `.text()`, `.attr()`, `.find()`, `.each()` all available.

**p-retry 8.0.0 API:**
- `import pRetry, { AbortError } from 'p-retry'`
- `pRetry(async (attemptNumber) => { … }, { retries, minTimeout, factor, randomize, onFailedAttempt })`
- Throw `AbortError` to stop retrying immediately (for 404/410/challenge page — not worth retrying).
- `makeRetriable` helper also available for wrapping functions directly.

### New Dependency: p-throttle 8.1.0

- Not yet installed. Add to `apps/worker/package.json` dependencies.
- Pure ESM, no peer dependencies, no transitive dependencies.
- `import pThrottle from 'p-throttle'`
- API: `pThrottle({ limit: 1, interval: 2000 })` returns a factory function.
- The factory wraps any function: `const throttled = throttle(myFn)`.
- `throttled.queueSize` — introspectable for monitoring.
- `throttled.isEnabled` — can be set to `false` to bypass throttle (useful for tests).
- Requires `WeakRef` and `FinalizationRegistry` — Node.js 18+ ✓ (engines spec in root `package.json`).

**Installation command:**
```bash
pnpm add p-throttle@8.1.0 --filter worker
```

### ESM Compatibility

All packages are pure ESM. The worker is `"type": "module"` (confirmed in `apps/worker/package.json`). No CJS/ESM interop issues expected. All imports must use `.js` extensions for local files (established pattern throughout codebase).

### TypeScript Config

Worker uses TypeScript 5.x, strict mode. No `any` — use `unknown` + type narrowing. The `CheerioAPI` type is fully typed; no `@ts-ignore` should be needed for Cheerio (unlike snoowrap).

For p-throttle: types ship with the package (`"types": "./index.d.ts"` in exports). No `@types/p-throttle` needed.

---

## 9. Risks & Unknowns

### R-01: HTML Fixtures Required Before Selector Code
**Risk:** The TheBump-specific selectors in `extractPostsFromPage` and `getNextPageUrl` cannot be correctly implemented without real HTML. If fixtures are not captured before implementing, selectors will be guesses that silently return empty results.
**Mitigation:** The implementer must fetch and save real TheBump HTML to `__fixtures__/` before writing selector code. This is an ordering constraint within Phase 5.

### R-02: Cloudflare / Bot Detection
**Risk:** TheBump may serve Cloudflare challenges or return 403 for Node.js fetch. Challenge detection (BUMP-05) handles this gracefully but means zero posts returned — silently empty results from the adapter.
**Mitigation:** The `thebump_challenge_detected` warn log (D-07) is the only alerting mechanism. Axiom alerting config is not in scope for Phase 5. The planner should note this as an operational gap.

### R-03: Vanilla Forums Variant — Selector Stability
**Risk:** TheBump uses a modified Vanilla Forums version. The HTML structure may not perfectly match documented Vanilla Forums conventions. Build-hash class names could change on their deploy cycle.
**Mitigation:** CONTEXT.md decision to target semantic attributes (`data-role`, `time[datetime]`, `[rel="author"]`) over class names. Fixture-driven development catches breakage on next re-capture.

### R-04: `pnpm eval` Script Not Defined
**Risk:** CLAUDE.md documents `pnpm eval` but it does not exist in `package.json` or `turbo.json`. Phase 5 must add it, but the script invocation path is undefined.
**Mitigation:** The simplest path: add `"eval": "tsx evals/run-eval.ts"` to root `package.json`. `tsx` is already in worker devDependencies; moving it to root or using `pnpm --filter worker exec tsx` are both valid. Planner should define this explicitly.

### R-05: Relative Date Parser Library
**Risk:** CONTEXT.md leaves the relative-date parsing library choice to implementer discretion. No such library exists in the current dependencies. Options: `chrono-node`, `date-fns`, or custom regex.
**Mitigation:** `chrono-node` parses English natural language dates ("2 hours ago", "January 5, 2025") and is well-maintained ESM-compatible. Should be added as a dependency if chosen. A lightweight custom implementation handles the common cases (`N minutes/hours/days ago`) without a new dependency. Planner should make this call.

### R-06: Migration Convention Not Established
**Risk:** No migration directory or naming convention exists yet. The `schema.sql` is the single source of truth but has no versioned migration history.
**Mitigation:** Establish `packages/db/src/migrations/` as the migration directory. Name convention: `{NNN}_{description}.sql`. Phase 5 creates the first migration file.

### R-07: Vitest Config Must Be Updated for New Env Vars
**Risk:** If new env vars are added to `config.ts` module-load validation (e.g. `THEBUMP_BASE_URL`), `vitest.config.ts` must be updated with dummy values or all tests will fail at import time.
**Mitigation:** INGEST-05 says scraping config constants go in `config.ts`. If `THEBUMP_BASE_URL` is optional (with a hardcoded default), no env var validation is needed. The planner should spec this as optional with a default, not `getEnvOrThrow`.

### R-08: `evals/run-eval.ts` Has No Reference Implementation
**Risk:** The eval runner must be written from scratch. Its interaction with the Anthropic API, result parsing, and scoring logic is undefined.
**Mitigation:** The eval runner is a simple script — it uses `@anthropic-ai/sdk` directly (per CLAUDE.md), reads the JSON file, calls Tier 1 prompt, compares decision to label. No complex framework needed. Scope it to ~100 lines.

---

## 10. Recommendations

### R-01: File Creation Order
Implement in strict dependency order:
1. `apps/worker/src/ingestion/scraping-utils.ts` — pure utilities, no adapter dependency.
2. `apps/worker/src/ingestion/base-forum-adapter.ts` — abstract class, imports scraping-utils.
3. `apps/worker/src/ingestion/thebump-adapter.ts` — concrete implementation.
4. `apps/worker/src/config.ts` constants — add `SCRAPING_REQUEST_TIMEOUT_MS`, `THEBUMP_BASE_URL` (with default), `MAX_PAGES`.
5. `packages/db/src/migrations/001_seed_thebump_sources.sql` — seed data.
6. `evals/labeled-posts.json` + `evals/run-eval.ts` — eval coverage.

### R-02: Config Constants Design
Add to `apps/worker/src/config.ts`:
```ts
// Scraping constants (INGEST-05)
export const SCRAPING_REQUEST_TIMEOUT_MS = 15_000;
export const SCRAPING_MAX_RETRIES = 3;
export const SCRAPING_MAX_PAGES = 10;
export const THEBUMP_BASE_URL = process.env.THEBUMP_BASE_URL ?? 'https://community.thebump.com';
```
Do NOT use `getEnvOrThrow` for `THEBUMP_BASE_URL` — the default is the real URL, the env var is only for testing/override. This avoids breaking the test suite (R-07).

### R-03: p-throttle vs respectfulDelay
Use `respectfulDelay()` (random 1–3s sleep) between page fetches inside `fetchNewPosts` loop — this satisfies BUMP-08 simply. Reserve p-throttle for wrapping `fetchWithRetry` to enforce the 1 req/2s rate limit as a safety floor independent of processing time. Both work together: throttle ensures minimum interval, delay adds jitter on top.

### R-04: ScrapeError Class Design
```ts
export class ScrapeError extends Error {
  readonly code: 'NETWORK' | 'PARSE' | 'CHALLENGE' | 'TIMEOUT';
  readonly url?: string;

  constructor(code: ScrapeError['code'], message: string, url?: string) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.url = url;
  }
}
```
Keep it flat — no subclasses. The `code` field enables structured logging: `logger.warn('thebump_challenge_detected', { url, code: err.code })`.

### R-05: Test File Placement
Co-locate test files with source (existing pattern):
```
apps/worker/src/ingestion/
  scraping-utils.test.ts
  base-forum-adapter.test.ts
  thebump-adapter.test.ts
  __fixtures__/
    thebump-post-list-page.html
    thebump-challenge-page.html
```

### R-06: Eval Script Placement
```
evals/
  labeled-posts.json    # 10 entries minimum (D-11: ~50/50)
  run-eval.ts           # standalone tsx script
```

Root `package.json` script addition:
```json
{
  "scripts": {
    "eval": "tsx evals/run-eval.ts"
  }
}
```
Add `tsx` to root devDependencies or use `pnpm --filter worker exec tsx evals/run-eval.ts`.

### R-07: Factory Function Export
Follow `createRedditAdapter` pattern exactly:
```ts
export function createTheBumpAdapter(sourceIdentifier: string): TheBumpAdapter {
  return new TheBumpAdapter(sourceIdentifier);
}
```
The `sourceIdentifier` is the subforum URL from `sources.identifier`. The `TheBumpAdapter` constructor stores it and derives `startUrl` from it.

### R-08: External ID Regex — Be Precise
The URL pattern for TheBump threads is:
```
/discussion/{id}/{slug}         → extract id
/discussion/comment/{id}/...    → extract id
```
Use a regex that handles both:
```ts
const match = url.match(/\/discussion\/(?:comment\/)?(\d+)/);
if (!match) throw new ScrapeError('PARSE', `Cannot extract external_id: ${url}`, url);
const externalId = match[1];
if (!/^\d+$/.test(externalId)) throw new ScrapeError('PARSE', `Invalid external_id: ${externalId}`, url);
```

---

## RESEARCH COMPLETE
