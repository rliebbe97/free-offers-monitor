# Phase 5: TheBump Adapter — Pattern Map

**Generated:** 2026-04-21

---

## File Index

| File | Action | Role | Analog |
|------|--------|------|--------|
| `apps/worker/src/ingestion/scraping-utils.ts` | create | source | `apps/worker/src/validation/liveness-check.ts` (fetch + cheerio patterns) |
| `apps/worker/src/ingestion/base-forum-adapter.ts` | create | source | `apps/worker/src/ingestion/reddit-adapter.ts` (class + SourceAdapter) |
| `apps/worker/src/ingestion/thebump-adapter.ts` | create | source | `apps/worker/src/ingestion/reddit-adapter.ts` (concrete adapter) |
| `apps/worker/src/config.ts` | modify | config | itself — add constants after existing validation loop block |
| `apps/worker/vitest.config.ts` | modify | config | itself — add any new env var stubs |
| `apps/worker/src/ingestion/scraping-utils.test.ts` | create | test | `apps/worker/src/validation/liveness-check.test.ts` |
| `apps/worker/src/ingestion/thebump-adapter.test.ts` | create | test | `apps/worker/src/validation/validation-loop.test.ts` |
| `apps/worker/src/ingestion/__fixtures__/*.html` | create | fixture | no existing analog — new convention |
| `packages/db/src/migrations/001_seed_thebump_sources.sql` | create | migration | `packages/db/src/schema.sql` (INSERT pattern) |
| `evals/labeled-posts.json` | create | eval data | no existing analog — new convention |
| `evals/run-eval.ts` | create | eval runner | `apps/worker/src/tiers/tier1.ts` (Anthropic SDK usage) |
| `apps/worker/package.json` | modify | config | itself — add `p-throttle` to dependencies |
| `package.json` (root) | modify | config | itself — add `eval` script |

---

## Pattern Details

---

### `apps/worker/src/ingestion/scraping-utils.ts`

**Action:** create
**Role:** source — pure utility functions: `fetchWithRetry`, `respectfulDelay`, `ScrapeError`, `SCRAPING_USER_AGENT`
**Closest analog:** `apps/worker/src/validation/liveness-check.ts` (lines 1–34) for the fetch + cheerio pattern; `apps/worker/src/validation/validation-loop.ts` (lines 1–13) for the config import pattern
**Data flow:** reads from `../config.js` (timeout constants); consumed by `base-forum-adapter.ts`

#### Import Pattern (from analog — liveness-check.ts lines 1–3)
```ts
import * as cheerio from 'cheerio';
import { VALIDATION_REQUEST_TIMEOUT_MS, VALIDATION_RAW_RESPONSE_MAX_CHARS } from '../config.js';
import { DEAD_SIGNALS } from './dead-signals.js';
```

Adaptation for scraping-utils.ts:
```ts
import pRetry, { AbortError } from 'p-retry';
import pThrottle from 'p-throttle';
import { logger } from '../logger.js';
import { SCRAPING_REQUEST_TIMEOUT_MS, SCRAPING_MAX_RETRIES } from '../config.js';
```

#### Export Pattern (from analog — liveness-check.ts lines 6–11, 31)
```ts
export interface LivenessResult {
  isLive: boolean;
  isWaf: boolean;
  httpStatus: number | null;
  deadSignals: string[];
  rawText: string | null;
}

export async function checkLiveness(url: string): Promise<LivenessResult> {
```

Adaptation: export class + named functions, no default exports (CLAUDE.md rule).

#### Key Code Excerpt — fetch with AbortSignal timeout (liveness-check.ts lines 38–45)
```ts
const headResponse = await fetch(url, {
  method: 'HEAD',
  headers,
  signal: AbortSignal.timeout(VALIDATION_REQUEST_TIMEOUT_MS),
  redirect: 'follow',
});
```

#### Key Code Excerpt — error swallowing pattern (liveness-check.ts lines 57–61)
```ts
  } catch {
    // Network error on HEAD — fall through to GET
    skipToGet = true;
  }
```

Note: `checkLiveness` never throws — errors are captured in the return value. `fetchWithRetry` in scraping-utils DOES throw `ScrapeError` so the adapter's pagination loop can catch and stop cleanly (D-06).

#### Key Code Excerpt — user agent constant (liveness-check.ts line 32)
```ts
const headers = { 'User-Agent': 'FreeOffersMonitor/1.0' };
```

Adaptation: promote to exported constant with fuller string per RESEARCH.md:
```ts
export const SCRAPING_USER_AGENT = 'FreeOffersMonitor/1.0 (+https://github.com/rliebbe97)';
```

#### Key Code Excerpt — logger usage (validation-loop.ts lines 61–64)
```ts
logger.warn('validation_waf_blocked', {
  offer_id: offer.id,
  http_status: result.httpStatus,
});
```

Adaptation for scraping-utils:
```ts
logger.warn('scrape_fetch_retry', { url, attempt: ctx.attemptNumber, error: String(ctx.error) });
```

#### Adaptation Notes
- Import `pRetry` and `AbortError` from `'p-retry'` (ESM, no `.js` extension needed on npm packages)
- Import `pThrottle` default export from `'p-throttle'`
- `ScrapeError` extends `Error` with a `code` field (`'NETWORK' | 'PARSE' | 'CHALLENGE' | 'TIMEOUT'`) and optional `url` field
- `fetchWithRetry` throws `ScrapeError` (not swallows) — callers decide recovery
- `respectfulDelay()` is a standalone async function using `setTimeout` — no library needed
- `fetchWithRateLimit` is a throttle-wrapped version of `fetchWithRetry` (1 req/2s floor)
- All imports use `.js` extension for local files (ESM requirement, established throughout codebase)

---

### `apps/worker/src/ingestion/base-forum-adapter.ts`

**Action:** create
**Role:** source — abstract class implementing `SourceAdapter`; owns `fetchNewPosts` pagination loop, `fetchPage`, and default `shouldSkipPost`
**Closest analog:** `apps/worker/src/ingestion/reddit-adapter.ts` (lines 62–210) — class structure, SourceAdapter implementation, logging pattern
**Data flow:** imports `scraping-utils.js`, `source-adapter.js`, `../config.js`, `../logger.js`; subclassed by `thebump-adapter.ts`

#### Import Pattern (from analog — reddit-adapter.ts lines 1–5)
```ts
// @ts-ignore — snoowrap ships its own types but they are incomplete in several places
import Snoowrap from 'snoowrap';
import { logger } from '../logger.js';
import { getEnvOrThrow } from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';
```

Adaptation for base-forum-adapter.ts:
```ts
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { logger } from '../logger.js';
import { SCRAPING_MAX_PAGES } from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';
import { fetchPage, respectfulDelay } from './scraping-utils.js';
```

Note: `cheerio` import pattern follows `liveness-check.ts` line 1: `import * as cheerio from 'cheerio'`. The `CheerioAPI` type is available as a named export from the same `'cheerio'` package entry.

#### Export Pattern (from analog — reddit-adapter.ts lines 62–70, 207–210)
```ts
export class RedditAdapter implements SourceAdapter {
  private readonly reddit: Snoowrap;
  private readonly subreddit: string;

  constructor(reddit: Snoowrap, subredditName: string) {
    this.reddit = reddit;
    this.subreddit = subredditName;
  }
  …
}

export function createRedditAdapter(subredditName: string): RedditAdapter {
  const reddit = createRedditClient();
  return new RedditAdapter(reddit, subredditName);
}
```

Adaptation: `abstract class BaseForumAdapter implements SourceAdapter` — no factory function (factories live in concrete subclasses). No default export.

#### Key Code Excerpt — fetchNewPosts loop skeleton (reddit-adapter.ts lines 71–201)
```ts
async fetchNewPosts(since: Date): Promise<RawPost[]> {
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const results: RawPost[] = [];

  // @ts-ignore — getSubreddit returns a Subreddit object; getNew returns a Listing
  const listing = await this.reddit.getSubreddit(this.subreddit).getNew({ limit: 25 });
  checkRateLimit(this.reddit);

  // @ts-ignore — listing is iterable but its type does not expose iterator in all snoowrap versions
  for (const post of listing) {
    // @ts-ignore — post.created_utc is a unix timestamp; exists at runtime
    if (post.created_utc < sinceUnix) continue;
    …
    results.push({ … });
  }

  logger.info('reddit_fetch_complete', {
    subreddit: this.subreddit,
    count: results.length,
  });

  return results;
}
```

Adaptation for base-forum-adapter.ts: while-loop with pageCount cap, try/catch stopping pagination on error (D-06), termination when all posts older than `since`.

#### Key Code Excerpt — per-post logging (reddit-adapter.ts lines 92–98)
```ts
if (shouldSkipAuthor(authorName, body, distinguished)) {
  logger.info('reddit_skip_post', {
    external_id: post.id,
    reason: 'bot_or_deleted',
    author: authorName,
  });
  continue;
}
```

Adaptation:
```ts
if (this.shouldSkipPost(post)) {
  logger.info('thebump_skip_post', {
    external_id: post.external_id,
    reason: 'skip_filter',
  });
  continue;
}
```

#### Key Code Excerpt — completion log (reddit-adapter.ts lines 195–199)
```ts
logger.info('reddit_fetch_complete', {
  subreddit: this.subreddit,
  count: results.length,
});
```

Adaptation: `logger.info('forum_fetch_complete', { url: this.startUrl, count: results.length, pages_fetched: pageCount })`

#### Adaptation Notes
- Class is `abstract` — `extractPostsFromPage` and `getNextPageUrl` are abstract protected methods
- `shouldSkipPost` is `protected` (overridable) with a concrete base implementation (D-03, D-08)
- `fetchPage` is a concrete `protected async` method — calls `fetchWithRateLimit` from scraping-utils, then `cheerio.load(text)`, then detects challenge page (D-07)
- `fetchNewPosts` is the public concrete method (satisfies `SourceAdapter` interface, D-04)
- No `@ts-ignore` needed for cheerio — types ship with the package and are complete

---

### `apps/worker/src/ingestion/thebump-adapter.ts`

**Action:** create
**Role:** source — concrete subclass of `BaseForumAdapter`; implements TheBump-specific selectors, date parsing, external ID extraction, and admin/sticky skip detection
**Closest analog:** `apps/worker/src/ingestion/reddit-adapter.ts` (full file) — the complete reference implementation of `SourceAdapter`
**Data flow:** imports `base-forum-adapter.js`, `scraping-utils.js`, `source-adapter.js` (types), `../logger.js`, `../config.js`; consumed by `ingest.ts` (Phase 6 wiring); invocable directly for smoke testing

#### Import Pattern (from analog — reddit-adapter.ts lines 1–5)
```ts
// @ts-ignore — snoowrap ships its own types but they are incomplete in several places
import Snoowrap from 'snoowrap';
import { logger } from '../logger.js';
import { getEnvOrThrow } from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';
```

Adaptation for thebump-adapter.ts:
```ts
import type { CheerioAPI } from 'cheerio';
import { logger } from '../logger.js';
import { THEBUMP_BASE_URL } from '../config.js';
import type { RawPost } from './source-adapter.js';
import { BaseForumAdapter } from './base-forum-adapter.js';
import { ScrapeError } from './scraping-utils.js';
```

#### Export Pattern (from analog — reddit-adapter.ts lines 62–69, 207–210)
```ts
export class RedditAdapter implements SourceAdapter {
  private readonly reddit: Snoowrap;
  private readonly subreddit: string;

  constructor(reddit: Snoowrap, subredditName: string) { … }
  …
}

export function createRedditAdapter(subredditName: string): RedditAdapter { … }
```

Adaptation:
```ts
export class TheBumpAdapter extends BaseForumAdapter {
  private readonly startUrl: string;

  constructor(sourceIdentifier: string) {
    super();
    this.startUrl = sourceIdentifier;  // subforum URL from sources.identifier
  }
  …
}

export function createTheBumpAdapter(sourceIdentifier: string): TheBumpAdapter {
  return new TheBumpAdapter(sourceIdentifier);
}
```

#### Key Code Excerpt — pure exported skip predicate (reddit-adapter.ts lines 18–30)
```ts
export function shouldSkipAuthor(
  author: string | null,
  body: string | null,
  distinguished?: string | null,
): boolean {
  if (author === null) return true; // deleted account
  if (BOT_NAMES.has(author)) return true;
  if (BOT_PATTERNS.some((p) => p.test(author))) return true;
  if (distinguished === 'moderator') return true;
  if (body === '[deleted]' || body === '[removed]') return true;
  if ((body ?? '').trim().length < 20) return true;
  return false;
}
```

Adaptation: TheBump override is a `protected shouldSkipPost(post: RawPost): boolean` method on the class, not a standalone exported function. However, the external-ID extraction function (`extractExternalId`) SHOULD be a pure exported function — enables isolated unit testing exactly like `shouldSkipAuthor` above.

#### Key Code Excerpt — inline filtering in loop (reddit-adapter.ts lines 91–98)
```ts
if (shouldSkipAuthor(authorName, body, distinguished)) {
  logger.info('reddit_skip_post', {
    external_id: post.id,
    reason: 'bot_or_deleted',
    author: authorName,
  });
  continue;
}
```

Adaptation: base class handles this with `this.shouldSkipPost(post)`. TheBump override adds admin/sticky checks before calling `super.shouldSkipPost(post)`.

#### Key Code Excerpt — RawPost construction (reddit-adapter.ts lines 107–115)
```ts
results.push({
  external_id: post.id as string,
  url: postUrl,
  title: postTitle,
  body,
  author: authorName,
  posted_at: postedAt,
});
```

Adaptation: TheBump `extractPostsFromPage` builds identical `RawPost` objects. `external_id` and `url` are non-nullable (per `source-adapter.ts` spec) — must throw `ScrapeError` if extraction fails rather than pushing null values.

#### Adaptation Notes
- Extends `BaseForumAdapter` — no `implements SourceAdapter` needed (inherited via D-04)
- `extractPostsFromPage($: CheerioAPI, pageUrl: string): RawPost[]` — concrete override; CSS selectors target semantic attributes per RESEARCH.md selector strategy
- `getNextPageUrl($: CheerioAPI): string | null` — concrete override; returns `null` if no `.NextPage` / `a[rel="next"]` link
- `shouldSkipPost(post: RawPost): boolean` — concrete override; calls `super.shouldSkipPost(post)` then adds TheBump-specific checks (D-09)
- `extractExternalId(url: string): string` — pure exported function; uses regex `/\/discussion\/(?:comment\/)?(\d+)/` per RESEARCH.md R-08
- Date parsing: `$('time[datetime]').attr('datetime')` → `new Date()` first; relative-date fallback; `null` on failure (BUMP-04)
- Challenge detection in `fetchPage` (base class): `$('title').text().toLowerCase().includes('just a moment')` → emit `thebump_challenge_detected` warn + throw `ScrapeError('CHALLENGE', …)` (D-07)
- Body text extraction: `.text().trim().replace(/\s+/g, ' ')` — never `.html()` (BUMP-06)
- No `@ts-ignore` needed (unlike reddit-adapter.ts which needs them for snoowrap incomplete types)

---

### `apps/worker/src/config.ts`

**Action:** modify
**Role:** config — add 4 scraping constants after the existing `VALIDATION_*` block
**Closest analog:** itself (lines 34–42) — the existing validation loop constants block
**Data flow:** imported by `scraping-utils.ts`, `base-forum-adapter.ts`, `thebump-adapter.ts`

#### Import Pattern (from analog — no imports; module-level code only)
N/A — config.ts is a pure export file.

#### Export Pattern (from analog — config.ts lines 25–42)
```ts
// Pipeline constants
export const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const POSTS_PER_POLL = 25;
…

// Validation loop constants
export const VALIDATION_POLL_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
export const VALIDATION_CHECK_INTERVAL_DAYS = 7;              // normal recheck cycle
export const VALIDATION_RETRY_INTERVAL_HOURS = 24;            // after first failure
export const VALIDATION_WAF_RETRY_INTERVAL_HOURS = 6;         // after 403/429 WAF block
export const VALIDATION_JITTER_HOURS = 6;                     // max random jitter spread
export const VALIDATION_CONCURRENT_LIMIT = 5;                 // max concurrent requests
export const VALIDATION_RAW_RESPONSE_MAX_CHARS = 2_000;       // verification_log truncation
```

#### Key Code Excerpt — existing getEnvOrThrow validation block (config.ts lines 7–12)
```ts
// Validate all required env vars at module load time — fail fast with clear messages
getEnvOrThrow('ANTHROPIC_API_KEY');
getEnvOrThrow('REDDIT_CLIENT_ID');
getEnvOrThrow('REDDIT_CLIENT_SECRET');
getEnvOrThrow('REDDIT_REFRESH_TOKEN');
getEnvOrThrow('VOYAGE_API_KEY');
```

#### Adaptation Notes
- Do NOT use `getEnvOrThrow` for `THEBUMP_BASE_URL` — use `process.env.THEBUMP_BASE_URL ?? 'https://community.thebump.com'` pattern (RESEARCH.md R-07: avoids breaking test suite)
- Append after line 42 (after `VALIDATION_RAW_RESPONSE_MAX_CHARS`), before `computeCost`:
  ```ts
  // Scraping constants (INGEST-05)
  export const SCRAPING_REQUEST_TIMEOUT_MS = 15_000;
  export const SCRAPING_MAX_RETRIES = 3;
  export const SCRAPING_MAX_PAGES = 10;
  export const THEBUMP_BASE_URL = process.env.THEBUMP_BASE_URL ?? 'https://community.thebump.com';
  ```
- Follow the numeric literal separator pattern: `15_000` not `15000` (already used in the file: `1_000_000`)
- Follow the inline comment style: `// 10 seconds per URL` (concise, lowercase)

---

### `apps/worker/vitest.config.ts`

**Action:** modify
**Role:** config — add dummy env vars for any new `getEnvOrThrow` calls added to config.ts
**Closest analog:** itself (lines 1–14)
**Data flow:** consumed by Vitest test runner; not imported by source files

#### Key Code Excerpt (vitest.config.ts lines 1–14 — full file)
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set dummy env vars required by config.ts module-load-time validation
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

#### Adaptation Notes
- Since `THEBUMP_BASE_URL` uses `??` fallback (not `getEnvOrThrow`), NO new env var stubs are needed in vitest.config.ts for Phase 5
- Only modify this file if a future decision changes `THEBUMP_BASE_URL` to `getEnvOrThrow`
- If modified, follow existing pattern: add `THEBUMP_BASE_URL: 'http://localhost'` inside the `env` object

---

### `apps/worker/src/ingestion/scraping-utils.test.ts`

**Action:** create
**Role:** test — unit tests for pure exported functions: `extractExternalId`, `ScrapeError`, `respectfulDelay` timing
**Closest analog:** `apps/worker/src/validation/liveness-check.test.ts` (full file) — pure function test pattern with `vi.stubGlobal('fetch', vi.fn())`
**Data flow:** imports `./scraping-utils.js`; no DB dependency; mocks `fetch` globally

#### Import Pattern (from analog — liveness-check.test.ts lines 1–3)
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkLiveness } from './liveness-check.js';
import type { LivenessResult } from './liveness-check.js';
```

Adaptation:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScrapeError, fetchWithRetry, respectfulDelay } from './scraping-utils.js';
```

#### Export Pattern (test files have no exports)
N/A — test files are not exported.

#### Key Code Excerpt — fetch mock pattern (liveness-check.test.ts lines 11–23)
```ts
it('HEAD 200 returns isLive: true', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
    status: 200,
    ok: true,
  }));

  const result: LivenessResult = await checkLiveness('https://example.com/offer');

  expect(result.isLive).toBe(true);
  expect(result.isWaf).toBe(false);
  expect(result.httpStatus).toBe(200);
  expect(result.deadSignals).toEqual([]);
  expect(result.rawText).toBeNull();
});
```

#### Key Code Excerpt — beforeEach reset (liveness-check.test.ts lines 6–8)
```ts
describe('checkLiveness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
```

#### Key Code Excerpt — multiple mock calls (liveness-check.test.ts lines 26–44)
```ts
it('HEAD 405 falls back to GET', async () => {
  const mockFetch = vi.fn()
    .mockResolvedValueOnce({ status: 405 })
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => '<body>normal page with great content</body>',
    });

  vi.stubGlobal('fetch', mockFetch);

  const result = await checkLiveness('https://example.com/offer');

  expect(result.isLive).toBe(true);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[0]![1]).toMatchObject({ method: 'HEAD' });
  expect(mockFetch.mock.calls[1]![1]).toMatchObject({ method: 'GET' });
});
```

#### Adaptation Notes
- Test coverage targets from RESEARCH.md section 5:
  - `extractExternalId`: valid `/discussion/4829183/slug`, valid `/discussion/comment/4829183/p1`, missing ID (throws `ScrapeError('PARSE', …)`), non-numeric ID (throws `ScrapeError`)
  - `ScrapeError`: constructor sets `name`, `code`, `url`, `message` correctly
  - `respectfulDelay`: elapsed time is between 900ms and 3100ms (allow ±100ms for CI jitter)
  - `fetchWithRetry`: 200 response returns Response; 404 throws `ScrapeError('NETWORK', …)` without retrying (AbortError path); network error triggers retry
- Mock `fetch` via `vi.stubGlobal('fetch', vi.fn())` — same pattern as liveness-check.test.ts
- `vi.restoreAllMocks()` in `beforeEach` — exact pattern from liveness-check.test.ts line 7
- File extension: `.js` on all local imports (ESM requirement)

---

### `apps/worker/src/ingestion/thebump-adapter.test.ts`

**Action:** create
**Role:** test — unit tests for `TheBumpAdapter` methods against HTML fixtures; module mock for `scraping-utils`
**Closest analog:** `apps/worker/src/validation/validation-loop.test.ts` (full file) — module mock pattern (`vi.mock`) + mock DB factory
**Data flow:** imports `./thebump-adapter.js`, `./scraping-utils.js` (mocked); reads `__fixtures__/*.html` via `readFileSync`

#### Import Pattern (from analog — validation-loop.test.ts lines 1–11)
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock liveness-check before importing validation-loop so vi.mock hoisting works
vi.mock('./liveness-check.js', () => ({
  checkLiveness: vi.fn(),
}));

// No need to mock sleep — tests call runValidationCycle directly (not the loop)
import { runValidationCycle } from './validation-loop.js';
import { checkLiveness } from './liveness-check.js';
import type { LivenessResult } from './liveness-check.js';
```

Adaptation:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock scraping-utils before importing adapter (vi.mock hoisting)
vi.mock('./scraping-utils.js', () => ({
  fetchWithRateLimit: vi.fn(),
  respectfulDelay: vi.fn().mockResolvedValue(undefined),
  ScrapeError: class ScrapeError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { TheBumpAdapter, extractExternalId } from './thebump-adapter.js';
import { fetchWithRateLimit } from './scraping-utils.js';
```

#### Key Code Excerpt — mock DB factory (validation-loop.test.ts lines 15–36)
```ts
function createMockDb(selectResult: Array<{ id: string; destination_url: string; consecutive_failures: number }>) {
  const insertFn = vi.fn().mockResolvedValue({ error: null });
  const updateChain = {
    eq: vi.fn().mockResolvedValue({ error: null }),
  };
  const updateFn = vi.fn().mockReturnValue(updateChain);
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    lte: vi.fn().mockResolvedValue({ data: selectResult, error: null }),
  };
  const selectFn = vi.fn().mockReturnValue(selectChain);

  return {
    from: vi.fn((table: string) => {
      if (table === 'verification_log') return { insert: insertFn };
      return { select: selectFn, update: updateFn, insert: insertFn };
    }),
    _insertFn: insertFn,
    _updateFn: updateFn,
    _updateChain: updateChain,
  };
}
```

Adaptation: TheBump adapter tests do not require a DB mock — the adapter has no DB interaction. The mock target is `fetchWithRateLimit` from scraping-utils.

#### Key Code Excerpt — vi.mocked + mockResolvedValue (validation-loop.test.ts lines 47–53)
```ts
vi.mocked(checkLiveness).mockResolvedValue({
  isLive: false,
  isWaf: false,
  httpStatus: 404,
  deadSignals: [],
  rawText: null,
} satisfies LivenessResult);
```

Adaptation: `vi.mocked(fetchWithRateLimit).mockResolvedValue(new Response(fixtureHtml, { status: 200 }))`

#### Key Code Excerpt — file fixture loading (from RESEARCH.md section 5)
```ts
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '__fixtures__/thebump-post-list-page.html'), 'utf-8');
```

#### Key Code Excerpt — beforeEach reset (validation-loop.test.ts lines 40–42)
```ts
describe('runValidationCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
```

#### Adaptation Notes
- Test coverage targets from RESEARCH.md section 5:
  - `extractPostsFromPage($)` against `thebump-post-list-page.html` fixture: correct count, correct `external_id`, correct `title`, correct `body` (no HTML tags), `posted_at` as Date or null
  - `getNextPageUrl($)` with next link present → returns URL string; without next link → returns `null`
  - `shouldSkipPost()` override: admin post → returns true; sticky post → returns true; short body → returns true (inherited); normal post → returns false
  - Challenge page detection: `thebump-challenge-page.html` → `fetchPage` throws `ScrapeError('CHALLENGE', …)` and emits `thebump_challenge_detected` warn
  - Date parsing: `<time datetime="2026-03-15T14:30:00Z">` → `new Date('2026-03-15T14:30:00Z')`; missing datetime attr with relative text → null (BUMP-04 fallback)
  - External ID extraction: tested via `extractExternalId` in `scraping-utils.test.ts`, not duplicated here
- `vi.mock` must appear before imports (hoisting) — exact pattern from validation-loop.test.ts lines 3–6
- `vi.clearAllMocks()` (not `vi.restoreAllMocks()`) in `beforeEach` — consistent with validation-loop.test.ts line 41

---

### `apps/worker/src/ingestion/__fixtures__/*.html`

**Action:** create
**Role:** fixture — real captured HTML snapshots used by thebump-adapter.test.ts
**Closest analog:** none — establishes new convention for the codebase
**Data flow:** read by `thebump-adapter.test.ts` via `readFileSync`; not imported at runtime

#### Files to create:
- `thebump-post-list-page.html` — real HTML from a TheBump freebies/deals category page; must contain at least 2 posts (one normal, one admin/sticky), pagination link, and `<time datetime="">` elements
- `thebump-challenge-page.html` — minimal Cloudflare challenge HTML with `<title>Just a moment...</title>`
- `thebump-empty-page.html` — TheBump page with no posts (empty result); used to test zero-post termination

#### Key Code Excerpt — how fixtures are loaded in tests (RESEARCH.md section 5)
```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '__fixtures__/thebump-post-list-page.html'), 'utf-8');
```

#### Adaptation Notes
- HTML files must be real captures (D-10), not synthetic — actual TheBump structure is needed to verify CSS selectors
- The implementer must fetch live TheBump pages before writing selectors (RESEARCH.md R-01)
- Challenge page fixture can be minimal synthetic HTML since the detection logic only reads `<title>` text
- Fixture directory `__fixtures__/` is co-located with source files — no separate `test/` directory (RESEARCH.md recommendation R-05)
- Files are plain HTML — no TypeScript compilation, no `.js` extension concerns

---

### `packages/db/src/migrations/001_seed_thebump_sources.sql`

**Action:** create
**Role:** migration — idempotent INSERT of TheBump subforum rows into `sources` table
**Closest analog:** `packages/db/src/schema.sql` (lines 27–34) for `sources` table schema; (lines 215–216) for `SELECT pgmq.create()` idempotent pattern
**Data flow:** applied once via Supabase SQL editor; the inserted rows are read by ingest.ts `fetchActiveSources` after Phase 6 adds `type='bump'` filter

#### Import Pattern (SQL — no imports)
N/A.

#### Key Code Excerpt — sources table schema (schema.sql lines 27–34)
```sql
CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL,                    -- 'reddit' | 'discourse'
  identifier     text NOT NULL UNIQUE,             -- subreddit name or base URL
  config         jsonb NOT NULL DEFAULT '{}',      -- polling config, auth config
  last_polled_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

#### Key Code Excerpt — idempotent operation pattern (schema.sql lines 215–216)
```sql
SELECT pgmq.create('tier1_queue');
SELECT pgmq.create('tier2_queue');
```

Adaptation: use `INSERT ... ON CONFLICT (identifier) DO NOTHING` for idempotency (RESEARCH.md section 6):
```sql
INSERT INTO sources (type, identifier, config)
VALUES (
  'bump',
  'https://community.thebump.com/categories/freebies-and-deals',
  '{"base_url": "https://community.thebump.com", "subforum_path": "/categories/freebies-and-deals", "max_pages": 5}'::jsonb
)
ON CONFLICT (identifier) DO NOTHING;
```

#### Key Code Excerpt — comment style (schema.sql lines 1–10)
```sql
-- ============================================================
-- Free Offers Monitor — Canonical Schema
-- ============================================================
-- This file is the single source of truth for the database
-- schema. After any changes, run `pnpm db:generate` to
-- regenerate TypeScript types in packages/db/src/types.ts.
```

Adaptation: migration files use simpler block comment:
```sql
-- Migration: 001_seed_thebump_sources
-- Adds TheBump freebies/deals subforum to sources table (type='bump').
-- Safe to re-run: ON CONFLICT (identifier) DO NOTHING.
```

#### Adaptation Notes
- `type` value must be `'bump'` — the `ingest.ts` Phase 6 filter will query `.eq('type', 'bump')`
- `identifier` is the `UNIQUE` column — the full subforum URL serves as the stable identifier
- `config` JSONB shape: `{ base_url, subforum_path, max_pages }` — TheBumpAdapter reads these fields at construction to build `startUrl`
- `last_polled_at` omitted from INSERT — defaults to `null` on first row; first adapter run sets it
- Directory `packages/db/src/migrations/` does not exist yet — establish convention with this file

---

### `evals/labeled-posts.json`

**Action:** create
**Role:** eval data — labeled ground-truth dataset for Tier 1 classifier evaluation
**Closest analog:** none — establishes new convention
**Data flow:** read by `evals/run-eval.ts`; not imported by worker or dashboard code

#### Schema (from RESEARCH.md section 7)
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
  }
]
```

#### Adaptation Notes
- `label` values: `'pass'` | `'reject'` — maps to Tier 1 `decision` field (same vocabulary)
- D-11: approximately 5 `pass` + 5 `reject` entries for initial coverage (50/50)
- Entries must be sourced from real TheBump scrapes (D-10) — no synthetic post bodies
- `id` convention: `{source}-{external_id}` (e.g., `thebump-4829183`)
- `notes` field is optional — use for debugging model failures
- `evals/` directory does not exist yet — must be created with this file

---

### `evals/run-eval.ts`

**Action:** create
**Role:** eval runner — standalone TypeScript script; reads `labeled-posts.json`, calls Tier 1 classifier, reports precision/recall/accuracy
**Closest analog:** `apps/worker/src/tiers/tier1.ts` (lines 1–10, 85–172) — `@anthropic-ai/sdk` usage pattern, `processTier1` response parsing
**Data flow:** reads `./labeled-posts.json`; calls Anthropic API directly; no DB dependency; exits 0 on pass, 1 on fail

#### Import Pattern (from analog — tier1.ts lines 1–9)
```ts
import Anthropic from '@anthropic-ai/sdk';
import type { createClient } from '@repo/db';
import type { Json } from '@repo/db';
import { logger } from '../logger.js';
import { TIER1_MODEL, computeCost } from '../config.js';
import { enqueueTier2 } from '../queue/producer.js';
import { Tier1ResultSchema } from './schemas.js';

type DbClient = ReturnType<typeof createClient>;
```

Adaptation for run-eval.ts (standalone script, no worker dependencies):
```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
```

Note: `run-eval.ts` lives in `evals/` — uses `node:` builtins for file I/O; imports Anthropic SDK directly; does NOT import `@repo/db` or worker modules.

#### Key Code Excerpt — Anthropic API call (tier1.ts lines 141–154)
```ts
response = await anthropic.messages.create({
  model: TIER1_MODEL,
  max_tokens: 256,
  messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
});

latencyMs = Date.now() - startMs;
inputTokens = response.usage.input_tokens;
outputTokens = response.usage.output_tokens;

const textBlock = response.content.find((block) => block.type === 'text');
rawText = textBlock?.type === 'text' ? textBlock.text : '';
```

#### Key Code Excerpt — JSON parse + validation (tier1.ts lines 183–229)
```ts
let parsedJson: unknown;
try {
  parsedJson = JSON.parse(rawText);
} catch (parseErr) {
  const errorMsg = `JSON parse failed: ${String(parseErr)}. Raw: ${rawText.slice(0, 200)}`;
  …
  throw new Error(`Tier 1 JSON parse failure for post ${postId}: ${errorMsg}`);
}
```

#### Key Code Excerpt — process.exit pattern (not in codebase yet — establishes new convention)
```ts
if (accuracy < PASS_THRESHOLD) {
  console.error(`FAIL: accuracy ${accuracy.toFixed(2)} below threshold ${PASS_THRESHOLD}`);
  process.exit(1);
}
process.exit(0);
```

#### Adaptation Notes
- Standalone script — no worker imports; reads `ANTHROPIC_API_KEY` from `process.env` directly
- Must read `prompts/tier1-classify.md` prompt from disk (same mechanism as `index.ts` lines 175–179: `readFileSync(path.join(promptsDir, 'tier1-classify.md'), 'utf-8')`)
- Tier 1 prompt path: resolved relative to repo root (use `process.cwd()` or `import.meta.url` + `fileURLToPath`)
- Loop over each `labeled-posts.json` entry, call `anthropic.messages.create`, parse `decision` from JSON response
- Compare `decision` to `label` (both use `'pass'`/`'reject'` vocabulary — no mapping needed)
- Print per-entry result + summary table to stdout
- Exit 1 if accuracy below threshold (e.g., 0.7); exit 0 otherwise
- No `tsx` shebang needed — invoked via `pnpm eval` which calls `tsx evals/run-eval.ts`

---

### `apps/worker/package.json`

**Action:** modify
**Role:** config — add `p-throttle@8.1.0` to `dependencies`
**Closest analog:** itself (lines 13–22)
**Data flow:** consumed by `pnpm install`; `p-throttle` is imported by `scraping-utils.ts`

#### Key Code Excerpt — existing dependencies block (package.json lines 13–22)
```json
"dependencies": {
  "@anthropic-ai/sdk": "0.90.0",
  "@axiomhq/js": "1.6.0",
  "@repo/db": "workspace:*",
  "cheerio": "^1.0.0",
  "normalize-url": "9.0.0",
  "p-limit": "7.3.0",
  "p-retry": "8.0.0",
  "snoowrap": "1.23.0",
  "zod": "4.3.6"
},
```

#### Adaptation Notes
- Add `"p-throttle": "8.1.0"` to `dependencies` (not `devDependencies`) — it is a runtime dependency of `scraping-utils.ts`
- Follow exact version pinning style: `"8.1.0"` not `"^8.1.0"` (all other non-workspace deps in this file use exact pins)
- Installation command: `pnpm add p-throttle@8.1.0 --filter worker` — do not run `pnpm add` manually if editing the file directly; just edit `package.json` then run `pnpm install`
- Alphabetical ordering within `dependencies` block: `p-throttle` goes between `p-retry` and `snoowrap`

---

### `package.json` (root)

**Action:** modify
**Role:** config — add `eval` script to root package.json scripts
**Closest analog:** itself (lines 4–9)
**Data flow:** invoked by `pnpm eval` from repo root

#### Key Code Excerpt — existing scripts block (root package.json lines 4–9)
```json
"scripts": {
  "build": "turbo run build",
  "dev": "turbo run dev",
  "lint": "turbo run lint",
  "format": "prettier --write \"**/*.{ts,tsx,md}\"",
  "check-types": "turbo run check-types",
  "db:generate": "pnpm --filter @repo/db db:generate"
},
```

#### Adaptation Notes
- Add `"eval": "pnpm --filter worker exec tsx ../../evals/run-eval.ts"` OR `"eval": "tsx evals/run-eval.ts"` (if `tsx` added to root devDependencies)
- `tsx` is currently only in `apps/worker/devDependencies` — simplest path: use `pnpm --filter worker exec tsx` to leverage worker's existing `tsx` install
- RESEARCH.md R-04 documents this exact ambiguity — planner should resolve: recommend `pnpm --filter worker exec tsx evals/run-eval.ts` as it requires no new root dependency
- Script name `eval` matches `pnpm eval` invocation documented in CLAUDE.md
- Do NOT add `eval` to `turbo.json` tasks — it is a one-shot dev script, not part of the build pipeline

---

## Cross-Cutting Patterns

### ESM Module Resolution — `.js` Extension Rule

Every local import in the worker uses `.js` extension even for `.ts` source files. Evidence from every file read:

```ts
// reddit-adapter.ts lines 3–5
import { logger } from '../logger.js';
import { getEnvOrThrow } from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';

// validation-loop.ts lines 1–13
import pLimit from 'p-limit';
import type { createClient } from '@repo/db';
import { logger } from '../logger.js';
import { sleep } from '../queue/consumer.js';
import { checkLiveness } from './liveness-check.js';

// liveness-check.test.ts lines 1–3
import { checkLiveness } from './liveness-check.js';
import type { LivenessResult } from './liveness-check.js';
```

Rule: all local imports → `.js` extension; npm package imports → no extension.

### Named Exports Only

From CLAUDE.md: "Named exports only, no default exports". Evidence:
- `reddit-adapter.ts`: exports `shouldSkipAuthor`, `RedditAdapter`, `createRedditAdapter` — no default
- `liveness-check.ts`: exports `LivenessResult`, `checkLiveness` — no default
- `config.ts`: exports constants and `computeCost` — no default
- Exception pattern: npm packages that ship default exports (e.g., `import Anthropic from '@anthropic-ai/sdk'`, `import pRetry from 'p-retry'`, `import pThrottle from 'p-throttle'`) — these are third-party, CLAUDE.md rule applies only to our code

### Structured Logging Event Naming

Pattern: `{module}_{action}` in `snake_case`. Evidence:
- `reddit_skip_post`, `reddit_skip_comment`, `reddit_fetch_complete` (reddit-adapter.ts)
- `ingestion_cycle_start`, `ingestion_cycle_complete`, `ingestion_fetch_error` (ingest.ts)
- `validation_waf_blocked`, `validation_offer_live`, `validation_cycle_start` (validation-loop.ts)
- `tier1_classified`, `tier1_idempotency_skip`, `tier1_enqueued_tier2` (tier1.ts)

New events for Phase 5 follow same pattern:
- `scrape_fetch_retry` — scraping-utils.ts
- `forum_page_fetch_failed` — base-forum-adapter.ts
- `forum_fetch_complete` — base-forum-adapter.ts
- `thebump_challenge_detected` — base-forum-adapter.ts / thebump-adapter.ts
- `thebump_skip_post` — thebump-adapter.ts

### Error Handling Stratification

Three levels observed in the codebase:

1. **Never throws** (consumer-facing): `checkLiveness` — catches all errors internally, returns structured result. Pattern used when caller cannot recover and must continue.
2. **Throws for caller to catch** (pipeline): `processTier1`, `enqueueTier1` — throw descriptive `Error` objects. Consumer loop (`runConsumerLoop`) catches and routes to DLQ.
3. **Catches + continues** (loop level): `runIngestionCycle` (lines 54–61), `validateOffer` (lines 104–110) — catch per-item errors, log, continue to next item.

Phase 5 adds a fourth: `ScrapeError` — typed error class thrown by scraping-utils; caught at pagination loop boundary in base class to implement D-06 (stop pagination, return partial results).

### `type` Import Distinction

The codebase consistently uses `import type` for type-only imports (no runtime value):
```ts
import type { RawPost, SourceAdapter } from './source-adapter.js';  // reddit-adapter.ts line 5
import type { createClient } from '@repo/db';                        // ingest.ts line 1
import type { Json } from '@repo/db';                                // tier1.ts line 3
```

vs runtime imports without `type`:
```ts
import { logger } from '../logger.js';    // has runtime value
import { getEnvOrThrow } from '../config.js';  // has runtime value
```

New files must follow this distinction strictly (TypeScript strict mode).

---

## PATTERN MAPPING COMPLETE
