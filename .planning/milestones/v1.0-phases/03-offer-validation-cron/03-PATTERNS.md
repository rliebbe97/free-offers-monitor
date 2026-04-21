# Phase 3: Offer Validation Cron - Pattern Map

**Mapped:** 2026-04-20
**Files analyzed:** 8 (3 new, 5 modified)
**Analogs found:** 8 / 8

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/worker/src/validation/dead-signals.ts` | utility | transform | `apps/worker/src/tiers/tier0-keywords.ts` | exact |
| `apps/worker/src/validation/liveness-check.ts` | service | request-response | `apps/worker/src/dedup/embedding-dedup.ts` | role-match |
| `apps/worker/src/validation/validation-loop.ts` | service | batch | `apps/worker/src/ingestion/ingest.ts` | role-match |
| `apps/worker/src/config.ts` | config | — | `apps/worker/src/config.ts` (self, extend) | exact |
| `apps/worker/src/index.ts` | controller | event-driven | `apps/worker/src/index.ts` (self, extend) | exact |
| `apps/worker/package.json` | config | — | `apps/worker/package.json` (self, extend) | exact |
| `packages/db/src/schema.sql` | migration | CRUD | `packages/db/src/schema.sql` (self, extend) | exact |
| `packages/db/src/types.ts` | model | CRUD | `packages/db/src/types.ts` (self, extend) | exact |

---

## Pattern Assignments

### `apps/worker/src/validation/dead-signals.ts` (utility, transform)

**Analog:** `apps/worker/src/tiers/tier0-keywords.ts`

**Imports pattern** — no imports needed (pure data export, same as keyword file).

**Core pattern** (lines 1-37 of analog):
```typescript
/**
 * Hand-maintained list of dead-signal phrases for offer validation.
 *
 * IMPORTANT: NEVER auto-add phrases. Only surface suggestions for human
 * review. A human must decide whether to add a phrase to this list.
 *
 * Matching is case-insensitive substring search against Cheerio-extracted
 * body text. No regex for v1.
 */
export const DEAD_SIGNALS: readonly string[] = [
  'out of stock',
  'sold out',
  'no longer available',
  'offer expired',
  'offer ended',
  'discontinued',
  'promotion ended',
  'deal expired',
  'currently unavailable',
  'page not found',
  'this item is no longer',
  'item is unavailable',
  'this offer has ended',
  'giveaway closed',
] as const;
```

**Key pattern notes:**
- `readonly string[]` with `as const` — exactly mirrors `TIER0_KEYWORDS`
- Named export, no default export (code style rule)
- JSDoc block warning humans not to auto-add phrases — required per CLAUDE.md
- No imports, no runtime dependencies; cached at module load time

---

### `apps/worker/src/validation/liveness-check.ts` (service, request-response)

**Analog:** `apps/worker/src/dedup/embedding-dedup.ts`

**Imports pattern** (lines 1-4 of analog):
```typescript
import type { createClient } from '@repo/db';
import { EMBEDDING_SIMILARITY_THRESHOLD } from '../config.js';

type DbClient = ReturnType<typeof createClient>;
```

**Adapted imports for liveness-check.ts:**
```typescript
import * as cheerio from 'cheerio';
import {
  VALIDATION_REQUEST_TIMEOUT_MS,
  VALIDATION_MAX_REDIRECTS,
  VALIDATION_RAW_RESPONSE_MAX_CHARS,
} from '../config.js';
import { DEAD_SIGNALS } from './dead-signals.js';
```

**Core fetch pattern** — native `fetch` with AbortSignal (analog: `embedding-dedup.ts` lines 16-36):
```typescript
// Analog uses native fetch the same way (no axios/got):
const response = await fetch('https://api.voyageai.com/v1/embeddings', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: [text], model: 'voyage-2' }),
});

if (!response.ok) {
  throw new Error(`Voyage API error: ${response.status} ${response.statusText}`);
}
```

**Core pattern for liveness-check.ts** — HEAD-then-GET with AbortSignal.timeout:
```typescript
export interface LivenessResult {
  isLive: boolean;
  isWaf: boolean;           // true when 403/429 blocks — do NOT count as failure
  httpStatus: number | null; // null on network error
  deadSignals: string[];
  rawText: string | null;   // truncated to VALIDATION_RAW_RESPONSE_MAX_CHARS
}

export async function checkLiveness(url: string): Promise<LivenessResult> {
  const headers = { 'User-Agent': 'FreeOffersMonitor/1.0' };
  const signal = AbortSignal.timeout(VALIDATION_REQUEST_TIMEOUT_MS);

  // 1. Try HEAD first
  let headResponse: Response | null = null;
  try {
    headResponse = await fetch(url, { method: 'HEAD', headers, signal, redirect: 'follow' });
  } catch {
    // HEAD failed (timeout, DNS, 405 throws) — fall through to GET
  }

  // 2. If HEAD succeeded and is not 405, evaluate immediately
  // 3. If HEAD gave 405 or failed, fall back to GET
  // ...
}
```

**Error handling pattern** — same `throw new Error(...)` pattern as analog (lines 26-27):
```typescript
if (!response.ok) {
  throw new Error(`Voyage API error: ${response.status} ${response.statusText}`);
}
```
In liveness-check, network errors are caught internally and returned as `{ isLive: false, httpStatus: null }` — do NOT re-throw; caller (validation-loop) decides state machine transitions.

**Dead signal detection** — Cheerio extraction:
```typescript
const html = await response.text();
const $ = cheerio.load(html);
const pageText = $('body').text().toLowerCase();
const deadSignals = DEAD_SIGNALS.filter((phrase) => pageText.includes(phrase));
const rawText = pageText.slice(0, VALIDATION_RAW_RESPONSE_MAX_CHARS);
```

**HTTP status classification:**
```typescript
// 200-399 = live
// 403/429 = WAF — isWaf: true, isLive: false, do NOT increment consecutive_failures
// 404/410/5xx = failed — isLive: false
// Network error (AbortError, TypeError) = failed — httpStatus: null
```

---

### `apps/worker/src/validation/validation-loop.ts` (service, batch)

**Analog:** `apps/worker/src/ingestion/ingest.ts` (batch loop over DB rows) and `apps/worker/src/index.ts` (shutdown flag loop pattern).

**Imports pattern** (from ingest.ts lines 1-7):
```typescript
import type { createClient, Source } from '@repo/db';
import { logger } from '../logger.js';
// ...
type DbClient = ReturnType<typeof createClient>;
```

**Adapted imports for validation-loop.ts:**
```typescript
import pLimit from 'p-limit';
import type { createClient } from '@repo/db';
import { logger } from '../logger.js';
import {
  VALIDATION_POLL_INTERVAL_MS,
  VALIDATION_CHECK_INTERVAL_DAYS,
  VALIDATION_RETRY_INTERVAL_HOURS,
  VALIDATION_WAF_RETRY_INTERVAL_HOURS,
  VALIDATION_JITTER_HOURS,
  VALIDATION_CONCURRENT_LIMIT,
  VALIDATION_RAW_RESPONSE_MAX_CHARS,
} from '../config.js';
import { sleep } from '../queue/consumer.js';
import { checkLiveness } from './liveness-check.js';

type DbClient = ReturnType<typeof createClient>;
```

**Polling loop pattern** — from `apps/worker/src/index.ts` lines 92-115 (`runRedditIngestionLoop`):
```typescript
async function runRedditIngestionLoop(
  db: DbClient,
  shutdown: { stop: boolean },
): Promise<void> {
  while (!shutdown.stop) {
    const cycleStart = Date.now();

    try {
      const sources = await fetchActiveSources(db);
      await runIngestionCycle(db, sources);
    } catch (err) {
      logger.error('ingestion_loop_error', { error: String(err) });
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, POLL_INTERVAL_MS - elapsed);

    if (!shutdown.stop && remaining > 0) {
      await sleep(remaining);
    }
  }

  logger.info('ingestion_loop_stopped');
}
```

**Adapted loop signature for validation-loop.ts:**
```typescript
export async function runValidationLoop(
  db: DbClient,
  shutdown: { stop: boolean },
): Promise<void> {
  while (!shutdown.stop) {
    const cycleStart = Date.now();

    try {
      await runValidationCycle(db);
    } catch (err) {
      logger.error('validation_loop_error', { error: String(err) });
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, VALIDATION_POLL_INTERVAL_MS - elapsed);

    if (!shutdown.stop && remaining > 0) {
      await sleep(remaining);
    }
  }

  logger.info('validation_loop_stopped');
}
```

**Batch DB query pattern** — from ingest.ts lines 12-23 (fetch all active rows):
```typescript
const { data, error } = await db
  .from('sources')
  .select('*')
  .eq('type', 'reddit');

if (error) {
  throw new Error(`Failed to fetch active sources: ${error.message}`);
}

return data ?? [];
```

**Adapted offer query for validation-loop.ts:**
```typescript
const { data: dueOffers, error: queryError } = await db
  .from('offers')
  .select('id, destination_url, consecutive_failures, status')
  .eq('status', 'active')
  .lte('next_check_at', new Date().toISOString());

if (queryError) {
  throw new Error(`Failed to fetch due offers: ${queryError.message}`);
}
```

**Supabase update pattern** — from ingest.ts lines 102-111:
```typescript
const { error: updateError } = await db
  .from('posts')
  .update({ tier0_passed: true, pipeline_status: 'tier0_passed' })
  .eq('id', postId);

if (updateError) {
  logger.error('post_tier0_update_error', { post_id: postId, error: updateError.message });
  continue;
}
```

**verification_log insert pattern** (adapted from tier2.ts `db.from('human_review_queue').insert(...)` lines 325-329):
```typescript
const { error: logError } = await db.from('verification_log').insert({
  offer_id: offer.id,
  http_status: result.httpStatus ?? null,
  is_live: result.isLive,
  dead_signals: result.deadSignals.length > 0 ? result.deadSignals : null,
  raw_response: result.rawText ?? null,
});

if (logError) {
  logger.error('verification_log_insert_error', { offer_id: offer.id, error: logError.message });
}
```

**p-limit concurrency pattern** (per RESEARCH.md §4.2):
```typescript
const limit = pLimit(VALIDATION_CONCURRENT_LIMIT); // 5

await Promise.all(
  dueOffers.map((offer) => limit(() => validateOffer(db, offer)))
);
```

**Two-check expiry state machine** — jitter helper + scheduling logic:
```typescript
function nextCheckAt(daysFromNow: number, jitterHours = 0): string {
  const jitterMs = Math.random() * jitterHours * 60 * 60 * 1000;
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000 + jitterMs).toISOString();
}
```

**Error logging pattern** — from consumer.ts lines 94-98 and tier2.ts lines 121-126:
```typescript
logger.error('consumer_read_error', { queue: queueName, error: error.message });
```

---

### `apps/worker/src/config.ts` (config, extend existing)

**Analog:** `apps/worker/src/config.ts` (self — add constants following existing style)

**Existing pattern** (lines 25-31):
```typescript
// Pipeline constants
export const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const POSTS_PER_POLL = 25;
export const TIER1_VISIBILITY_TIMEOUT = 30; // seconds
export const TIER2_VISIBILITY_TIMEOUT = 120; // seconds
export const CONSUMER_BATCH_SIZE = 5;
export const DLQ_RETRY_THRESHOLD = 3;
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;
```

**Constants to add** — follow same naming pattern (`SCREAMING_SNAKE_CASE`, inline comments):
```typescript
// Validation loop constants
export const VALIDATION_POLL_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
export const VALIDATION_CHECK_INTERVAL_DAYS = 7;              // normal recheck cycle
export const VALIDATION_RETRY_INTERVAL_HOURS = 24;            // after first failure
export const VALIDATION_WAF_RETRY_INTERVAL_HOURS = 6;         // after 403/429 WAF block
export const VALIDATION_REQUEST_TIMEOUT_MS = 10_000;          // 10 seconds per URL
export const VALIDATION_MAX_REDIRECTS = 5;                    // max redirect hops
export const VALIDATION_JITTER_HOURS = 6;                     // max random jitter spread
export const VALIDATION_CONCURRENT_LIMIT = 5;                 // max concurrent requests
export const VALIDATION_RAW_RESPONSE_MAX_CHARS = 2_000;       // verification_log truncation
```

**No new env vars needed** — validation loop reuses existing `db` client, no new secrets.

---

### `apps/worker/src/index.ts` (controller, extend existing)

**Analog:** `apps/worker/src/index.ts` (self — add fourth loop to Promise.all)

**Existing import block** (lines 1-12):
```typescript
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@repo/db';
import { logger } from './logger.js';
import { POLL_INTERVAL_MS, TIER1_VISIBILITY_TIMEOUT, TIER2_VISIBILITY_TIMEOUT, CONSUMER_BATCH_SIZE } from './config.js';
import { fetchActiveSources, runIngestionCycle } from './ingestion/ingest.js';
import { runConsumerLoop, sleep } from './queue/consumer.js';
import { processTier1 } from './tiers/tier1.js';
import { processTier2 } from './tiers/tier2.js';
```

**Add one import** (alongside existing tier imports):
```typescript
import { runValidationLoop } from './validation/validation-loop.js';
```

**Existing Promise.all pattern** (lines 226-230):
```typescript
await Promise.all([
  runRedditIngestionLoop(db, shutdown),
  runTier1ConsumerLoop(db, anthropic, tier1Prompt, promptVersion, shutdown),
  runTier2ConsumerLoop(db, anthropic, tier2Prompt, promptVersion, shutdown),
]);
```

**Modified Promise.all** — append fourth entry:
```typescript
await Promise.all([
  runRedditIngestionLoop(db, shutdown),
  runTier1ConsumerLoop(db, anthropic, tier1Prompt, promptVersion, shutdown),
  runTier2ConsumerLoop(db, anthropic, tier2Prompt, promptVersion, shutdown),
  runValidationLoop(db, shutdown),
]);
```

**Wrapper function pattern** — add a named wrapper following the same style as `runRedditIngestionLoop` (lines 92-115); no wrapper needed since `runValidationLoop` already takes `(db, shutdown)` directly.

---

### `apps/worker/package.json` (config, extend existing)

**Analog:** `apps/worker/package.json` (self — add cheerio dependency)

**Existing dependencies block:**
```json
"dependencies": {
  "@anthropic-ai/sdk": "0.90.0",
  "@axiomhq/js": "1.6.0",
  "@repo/db": "workspace:*",
  "normalize-url": "9.0.0",
  "p-limit": "7.3.0",
  "p-retry": "8.0.0",
  "snoowrap": "1.23.0",
  "zod": "4.3.6"
}
```

**Add cheerio** (per RESEARCH.md §9 — not currently in deps):
```json
"cheerio": "^1.0.0"
```

**Note:** `p-limit` is already present at `7.3.0` — no version change needed. The `@types/cheerio` package is NOT needed for cheerio v1.0+ which ships its own types.

---

### `packages/db/src/schema.sql` (migration, extend existing)

**Analog:** `packages/db/src/schema.sql` (self — add column to offers table)

**Existing offers CREATE TABLE** (lines 60-79):
```sql
CREATE TABLE offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_url       text NOT NULL,
  destination_url_hash  text NOT NULL,
  title                 text NOT NULL,
  ...
  status                text NOT NULL DEFAULT 'active',
  last_verified_at      timestamptz,
  next_check_at         timestamptz,
  extraction_confidence numeric,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

**Add column** inline to the CREATE TABLE (since schema.sql is canonical DDL, not migration files):
```sql
  consecutive_failures  integer NOT NULL DEFAULT 0,
```

Place after `next_check_at` and before `extraction_confidence`.

**Schema.sql also needs pg_cron queue creation** (per VAL-01). Minimal implementation appended after existing `SELECT pgmq.create()` calls:
```sql
-- ============================================================
-- VALIDATION SCHEDULING
-- ============================================================
-- pg_cron satisfies VAL-01: the worker validation loop handles
-- actual execution via next_check_at polling. This cron job
-- is a no-op safety net ensuring the scheduling intent is
-- documented and the extension is exercised.
--
-- Fires at midnight UTC daily. Requires pg_cron extension.
SELECT cron.schedule(
  'validation-daily-trigger',
  '0 0 * * *',
  $$ SELECT 1 $$   -- no-op: worker polls next_check_at independently
);
```

---

### `packages/db/src/types.ts` (model, extend existing)

**Analog:** `packages/db/src/types.ts` (self — add `consecutive_failures` to offers interfaces)

**Existing offers Row** (lines 99-117):
```typescript
offers: {
  Row: {
    id: string;
    ...
    status: string;
    last_verified_at: string | null;
    next_check_at: string | null;
    extraction_confidence: number | null;
    created_at: string;
    updated_at: string;
  };
  Insert: {
    ...
    next_check_at?: string | null;
    extraction_confidence?: number | null;
    ...
  };
  Update: {
    ...
  };
```

**Pattern for adding a new column** — follow exact style of existing fields:
```typescript
// In Row (required, non-nullable — column has DEFAULT 0, always present):
consecutive_failures: number;

// In Insert (optional — has DEFAULT 0):
consecutive_failures?: number;

// In Update (optional):
consecutive_failures?: number;
```

**Add to exported type alias** — the `Offer` type alias at line 353 picks up the new field automatically:
```typescript
export type Offer = Database['public']['Tables']['offers']['Row'];
```

---

## Shared Patterns

### Shutdown Flag Pattern
**Source:** `apps/worker/src/index.ts` (lines 210-229) and `apps/worker/src/queue/consumer.ts` (lines 87, 109)
**Apply to:** `validation-loop.ts` — all polling loops use `{ stop: boolean }` shutdown flag

```typescript
// Declaration in index.ts (line 210):
const shutdown = { stop: false };

// Usage in loop (consumer.ts line 87):
while (!shutdown.stop) {
  // ...
  if (shutdown.stop) break; // line 109 — inner check before processing
}

// After loop exits (consumer.ts line 147):
logger.info('consumer_loop_stopped', { queue: queueName });
```

### Sleep Utility
**Source:** `apps/worker/src/queue/consumer.ts` (lines 11-13)
**Apply to:** `validation-loop.ts` — import `sleep` from consumer, do not reimplement

```typescript
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### Structured Logger Pattern
**Source:** `apps/worker/src/logger.ts` (lines 29-50)
**Apply to:** `validation-loop.ts`, `liveness-check.ts`

```typescript
// All log calls: event name (snake_case string) + optional payload object
logger.info('validation_cycle_start', { due_count: dueOffers.length });
logger.warn('validation_waf_blocked', { offer_id: offer.id, http_status: 403 });
logger.error('validation_loop_error', { error: String(err) });
```

### Supabase Client Type Pattern
**Source:** Every worker file (e.g., `ingest.ts` line 7, `consumer.ts` line 6)
**Apply to:** `validation-loop.ts` — use same DbClient type alias

```typescript
import type { createClient } from '@repo/db';
type DbClient = ReturnType<typeof createClient>;
```

### Supabase Query Error Handling
**Source:** `apps/worker/src/ingestion/ingest.ts` (lines 14-23) and `apps/worker/src/tiers/tier2.ts` (lines 160-175)
**Apply to:** All DB queries in `validation-loop.ts`

```typescript
const { data, error } = await db.from('...').select('...').eq('...', value);

if (error) {
  throw new Error(`Failed to ...: ${error.message}`);
}
// Proceed with data ?? []
```

### Named Exports Only
**Source:** All existing modules
**Apply to:** All new files — no default exports. Every export is named.

```typescript
// CORRECT:
export const DEAD_SIGNALS = [...] as const;
export async function checkLiveness(url: string): Promise<LivenessResult> { ... }
export async function runValidationLoop(db: DbClient, shutdown: { stop: boolean }): Promise<void> { ... }

// WRONG:
export default function checkLiveness(...) { ... }
```

---

## No Analog Found

All files in this phase have close analogs. No files require fallback to RESEARCH.md patterns only.

---

## Metadata

**Analog search scope:** `apps/worker/src/`, `packages/db/src/`
**Files scanned:** 16 TypeScript files, 1 SQL file, 2 JSON files
**Pattern extraction date:** 2026-04-20
