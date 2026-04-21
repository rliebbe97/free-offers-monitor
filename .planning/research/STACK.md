# Stack Research

**Domain:** Forum scraping adapter infrastructure
**Researched:** 2026-04-21
**Confidence:** HIGH

---

## Recommended Stack

### Core Technologies

No new core runtime technologies are required. The TheBump adapter runs inside the existing worker (Node.js 22, TypeScript strict, pnpm workspaces) and leverages the already-installed `fetch` + `cheerio` combination. The `SourceAdapter` interface in `apps/worker/src/ingestion/source-adapter.ts` already defines the contract — no interface changes needed.

### Supporting Libraries

The following libraries are new additions (not currently in `apps/worker/package.json`):

| Library | Version | Purpose | Why Recommended |
|---|---|---|---|
| `p-throttle` | 8.1.0 | Per-adapter request rate limiter | Ensures TheBump fetch loop stays well under any server-side rate limits without blocking the entire event loop. More ergonomic than `p-limit` for time-windowed throttling (e.g., 1 req/2s). Already using `p-limit` for concurrency — this fills the orthogonal time-rate gap. |
| `playwright` | 1.59.1 | Headless browser fallback (conditional) | TheBump forum pages are currently server-rendered HTML — Cheerio-first is correct. Add `playwright` only as a dev/optional dependency now so the conditional path exists; activate if a future poll cycle returns a JS-challenge page or Cloudflare IUAM page. Do NOT install `@playwright/test` in prod bundle. |

### Development Tools

No new dev tooling is required. Existing Vitest, tsx, tsup, and ESLint setup covers the new adapter code.

---

## Installation

```bash
# Add to apps/worker — new production dependency
pnpm add p-throttle --filter worker

# Add playwright as optional (dev-only until needed)
pnpm add -D playwright --filter worker
# If/when Playwright is activated, run once to download browsers:
npx playwright install chromium --with-deps
```

---

## What NOT to Add

| Library | Why to Avoid |
|---|---|
| `got` | Native `fetch` (Node 22 built-in) is sufficient for simple GET requests with headers. `got` adds 15+ dependencies and retry logic already covered by `p-retry` (already installed). |
| `axios` | Same reason as `got` — redundant with native `fetch`. |
| `puppeteer` | Playwright is the chosen headless fallback (already in the v1.0 STACK.md dev tools list). Do not add both. |
| `node-html-parser` | Cheerio 1.2.0 is already installed and provides the right jQuery-like selector API for scraping Vanilla Forums HTML. A second HTML parser adds zero value. |
| `tough-cookie` | TheBump forum threads are publicly accessible without login. No session/cookie management needed for the read-only scrape path. If login-gated content is needed in a future milestone, add then. |
| `user-agents` | A single well-formed static `User-Agent` header is sufficient. A randomized UA library is overkill and harder to debug. |
| `bottleneck` | `p-throttle` covers time-windowed rate limiting cleanly. `bottleneck` is a heavier distributed rate limiter designed for multi-process scenarios — unnecessary here. |
| `https-proxy-agent` | No proxy infrastructure in this project. If TheBump blocks the Railway egress IP in future, address as a separate ops decision — do not preemptively add. |

---

## Stack Patterns by Adapter Variant

### Pattern A: Static HTML (Cheerio-first) — Applies to TheBump Now

```typescript
// apps/worker/src/ingestion/thebump-adapter.ts
import { load } from 'cheerio';
import { pThrottle } from 'p-throttle';
import type { RawPost, SourceAdapter } from './source-adapter.js';

const throttledFetch = pThrottle({ limit: 1, interval: 2000 })(
  async (url: string, init?: RequestInit) => fetch(url, init)
);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; free-offers-monitor/1.1; +https://github.com/your-org/free-offers-monitor)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class TheBumpAdapter implements SourceAdapter {
  constructor(private readonly discussionId: string) {}

  async fetchNewPosts(since: Date): Promise<RawPost[]> {
    // 1. Fetch page 1, parse total page count from pagination HTML
    // 2. Iterate pages in reverse (newest first), stop when post.posted_at < since
    // 3. Use cheerio selectors: .Comments .Item, .UserLink, .DateLink, .Message
    // 4. Return RawPost[] — external_id = comment ID from /discussion/comment/[ID]
  }
}
```

### Pattern B: JS-Rendered Fallback (Playwright) — Conditional Path

Activate only when Cheerio fetch returns a Cloudflare challenge page (HTTP 403, or `<title>` contains "Just a moment" / "Checking your browser"). Do not activate proactively.

```typescript
// Detect challenge page in Cheerio path:
const $ = load(html);
const isChallenge =
  $('title').text().includes('Just a moment') ||
  $('title').text().includes('Checking your browser') ||
  res.status === 403;

if (isChallenge) {
  // fall through to Playwright path
}
```

### Pattern C: Shared Base Class (Adapter Infrastructure)

```typescript
// apps/worker/src/ingestion/base-html-adapter.ts
export abstract class BaseHtmlAdapter implements SourceAdapter {
  protected abstract readonly baseUrl: string;
  protected abstract parsePostsFromPage(html: string, pageUrl: string): RawPost[];
  protected abstract getNextPageUrl(html: string, currentUrl: string): string | null;

  async fetchNewPosts(since: Date): Promise<RawPost[]> {
    // Shared: throttled fetch, pagination loop, since-date cutoff, error logging
  }
}
```

This base class extracts the pagination/fetch loop common to all HTML forum adapters. `RedditAdapter` does NOT extend it (it uses snoowrap, not raw fetch). Only HTML-scraped adapters (TheBump, future Discourse boards) inherit from `BaseHtmlAdapter`.

---

## TheBump Forum Structure (Verified 2026-04-21)

| Property | Value |
|---|---|
| Forum software | Vanilla Forums (PHP-based, Higher Logic acquired 2021) |
| Rendering | Server-rendered HTML — content present in initial response |
| Freebies threads | Discussion threads, not a dedicated category. Target by discussion ID. |
| Key thread IDs | `12727626` (Steals, Deals, Freebies, & Coups), `12745853` (Pregnancy + Baby Freebies), `12607983` (All the Free Baby Stuff), `12726602` (Free baby stuff), `12709081` (Free Stuff!) |
| Thread URL pattern | `https://forums.thebump.com/discussion/{id}/{slug}` |
| Pagination | `/p2`, `/p3`, etc. appended to thread URL |
| Comment URL pattern | `/discussion/comment/{comment-id}/#Comment_{comment-id}` |
| Post timestamp format | Relative ("November 2017") in HTML; absolute time in comment permalink |
| robots.txt disallows | `/entry/`, `/messages/`, `/profile/`, `/search/` — discussion pages are NOT disallowed |
| WAF evidence | None observed in public HTML responses; no Cloudflare challenge pages encountered |

---

## Integration with Existing Stack

| Existing capability | How TheBump adapter uses it |
|---|---|
| `cheerio` ^1.0.0 (already installed) | HTML parsing — no version change needed |
| `p-retry` 8.0.0 (already installed) | Wrap `fetch` calls for transient network errors |
| `p-limit` 7.3.0 (already installed) | Cap concurrent page fetches if parallelism is added |
| `@axiomhq/js` 1.6.0 (already installed) | Log fetch errors, rate limit warnings, page counts |
| `sources` DB table (`type` column) | Add `type: 'thebump'` rows; `identifier` = discussion ID |
| `ingest.ts` `runIngestionCycle` | Extend to route `type: 'thebump'` sources to `TheBumpAdapter` |
| `SourceAdapter` interface | `TheBumpAdapter` implements it unchanged |

The one code change required in `ingest.ts` is removing the `redditSources` filter and routing by `source.type`:

```typescript
// Before (reddit-only):
const redditSources = sources.filter((s) => s.type === 'reddit');

// After (multi-adapter):
for (const source of sources) {
  const adapter = createAdapter(source); // factory by source.type
  ...
}
```

---

## Version Compatibility

| Library | Node req | ESM? | Notes |
|---|---|---|---|
| `p-throttle` 8.1.0 | Node 18+ | ESM-only | Import as `import { pThrottle } from 'p-throttle'` |
| `playwright` 1.59.1 | Node 18+ | CJS + ESM | Import as `import { chromium } from 'playwright'` — keep in conditional path only |
| `cheerio` 1.2.0 | Node 18+ | ESM-only | Already installed; confirm `^1.0.0` resolves to 1.2.0 |

All packages are ESM-compatible, matching the worker's `"type": "module"` in `package.json`.

---

## Alternatives Considered

| Alternative | Considered for | Rejected because |
|---|---|---|
| `got` 15.0.3 | HTTP client for page fetching | Native `fetch` in Node 22 is sufficient; `got` adds unnecessary dependency weight |
| `node-html-parser` 7.1.0 | HTML parsing | Cheerio already installed with jQuery-like API; switching parsers yields no benefit |
| `bottleneck` 2.19.5 | Rate limiting | Designed for distributed/multi-process scenarios; `p-throttle` is simpler and sufficient |
| `puppeteer` (latest) | JS-rendered fallback | Playwright already in dev tools list from v1.0; don't add a second headless driver |
| Dedicated Discourse scraper (e.g., `discourse-api`) | Future Discourse adapters | TheBump is not Discourse; premature to add. If Discourse sources are added, evaluate then. |

---

## Sources

- npm registry: cheerio 1.2.0 — https://registry.npmjs.org/cheerio/latest
- npm registry: p-throttle 8.1.0 — https://registry.npmjs.org/p-throttle/latest
- npm registry: playwright 1.59.1 — https://registry.npmjs.org/playwright/latest
- npm registry: p-queue 9.1.2 — https://registry.npmjs.org/p-queue/latest
- npm registry: got 15.0.3 — https://registry.npmjs.org/got/latest
- TheBump forum categories — https://forums.thebump.com/categories
- TheBump freebies threads verified live — https://forums.thebump.com/discussion/12727626/steals-deals-freebies-coups
- TheBump robots.txt — https://forums.thebump.com/robots.txt
- Vanilla Forums technology — https://success.vanillaforums.com/kb/articles/138-vanilla-technology-stack
