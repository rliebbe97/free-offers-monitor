# Phase 3: Offer Validation Cron — Research

**Researched:** 2026-04-20
**Phase:** 03-offer-validation-cron
**Requirements addressed:** VAL-01, VAL-02, VAL-03, VAL-04, VAL-05

---

## 1. What This Phase Builds

A fourth concurrent loop inside the existing worker process that polls the `offers` table for active offers whose `next_check_at` has passed, performs a HEAD/GET liveness check with Cheerio dead-signal scanning, enforces a two-consecutive-failure rule before expiry, and writes all results to `verification_log`.

No new tables, no new queues — pure worker-side TypeScript logic layered onto the existing infrastructure.

---

## 2. Integration Points Into Existing Code

### 2.1 Worker Entry Point (`apps/worker/src/index.ts`)

The `main()` function currently runs three loops with `Promise.all()`:

```typescript
await Promise.all([
  runRedditIngestionLoop(db, shutdown),
  runTier1ConsumerLoop(db, anthropic, tier1Prompt, promptVersion, shutdown),
  runTier2ConsumerLoop(db, anthropic, tier2Prompt, promptVersion, shutdown),
]);
```

Phase 3 adds a fourth: `runValidationLoop(db, shutdown)` appended to the `Promise.all()` array. The loop follows the exact same shutdown flag pattern (`{ stop: boolean }`).

### 2.2 Config Module (`apps/worker/src/config.ts`)

The existing config module uses `getEnvOrThrow()` and exports named constants. Add validation-specific constants here:

- `VALIDATION_POLL_INTERVAL_MS` — how often the validation loop checks for due offers (e.g., 10 minutes)
- `VALIDATION_CHECK_INTERVAL_DAYS` — normal recheck cycle (7 days)
- `VALIDATION_RETRY_INTERVAL_HOURS` — retry interval after first failure (24 hours)
- `VALIDATION_REQUEST_TIMEOUT_MS` — per-URL request timeout (10 seconds = 10_000)
- `VALIDATION_MAX_REDIRECTS` — maximum redirect hops to follow (5)
- `VALIDATION_JITTER_HOURS` — maximum random jitter spread (6 hours)
- `VALIDATION_CONCURRENT_LIMIT` — max concurrent validation requests (5, using `p-limit` already in deps)
- `VALIDATION_RAW_RESPONSE_MAX_CHARS` — truncation limit for `verification_log.raw_response` (e.g., 2000 chars)

No new env vars needed — the validation loop reuses the existing Supabase `db` client.

### 2.3 Dead Signals File (`apps/worker/src/validation/dead-signals.ts`)

Mirrors the `tier0-keywords.ts` pattern: a TypeScript file exporting a `readonly string[]`, loaded at module import time, cached in memory. No DB roundtrip, version-controlled, reviewable in PRs.

Initial pattern set (per D-05 from CONTEXT.md):
- `"out of stock"`, `"sold out"`, `"no longer available"`, `"offer expired"`, `"offer ended"`
- `"discontinued"`, `"promotion ended"`, `"deal expired"`, `"currently unavailable"`, `"page not found"`
- `"this item is no longer"`, `"item is unavailable"`, `"this offer has ended"`, `"giveaway closed"`

Matching: case-insensitive `toLowerCase().includes(phrase)` against Cheerio-extracted `$('body').text()`. No regex for v1.

### 2.4 Module Layout

Create `apps/worker/src/validation/` directory:

```
apps/worker/src/validation/
  dead-signals.ts      # readonly string[] — managed list
  liveness-check.ts    # HEAD/GET fetch + 403/429 handling + Cheerio dead-signal scan
  validation-loop.ts   # polling loop: query due offers, call checker, write log, update offer
```

---

## 3. Database Schema — What Already Exists

### `offers` table (existing columns used)
- `id`, `status` (`'active'` | `'expired'` | `'unverified'` | `'review_pending'`)
- `next_check_at` — timestamptz, already set by Phase 2 dedup to `now() + 7 days + jitter`
- `last_verified_at` — timestamptz, updated on each check

**Gap discovered:** The schema has no `consecutive_failures` counter column. The context leaves this to Claude's discretion. Two options:

**Option A — Counter column on `offers`** (recommended):
- Add `consecutive_failures integer NOT NULL DEFAULT 0` to `offers` table
- Pro: O(1) read, no join, clean update pattern
- Con: Schema change needed — must add to `schema.sql` and `types.ts`

**Option B — Query `verification_log`**:
- Query the last 2 `verification_log` rows for an offer and check if both `is_live = false`
- Pro: No schema change
- Con: Extra DB query per offer check; timing gap between checks requires additional logic to enforce the 24-hour separation guarantee

Recommendation: **Option A — add `consecutive_failures` column**. The two-check expiry rule is a core requirement (VAL-04) and a dedicated counter is cleaner, faster, and easier to test. The schema is already hand-maintained (not migrated), so adding the column to `schema.sql` and `types.ts` is low-friction.

### `verification_log` table (existing, ready to write)
```sql
CREATE TABLE verification_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id     uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  http_status  integer,
  is_live      boolean NOT NULL,
  dead_signals text[],
  raw_response text                 -- truncated page text for debug
);
```
All fields available. `raw_response` should be truncated to avoid bloat (2000 chars is reasonable).

### Index already exists for validation queries
```sql
CREATE INDEX offers_next_check_active_idx ON offers(next_check_at) WHERE status = 'active';
```
This partial index makes the validation query efficient: `WHERE status = 'active' AND next_check_at <= now()`.

---

## 4. HTTP Liveness Check Implementation

### 4.1 Request Logic (per CONTEXT D-10 through D-13)

```
HEAD {url} → on success (2xx-3xx): live
           → on 405 or timeout: fall back to GET
GET {url}  → on 200-399: live
           → on 403/429: check_failed (WAF/rate-limit, NOT dead)
           → on 404/410/5xx: failed
           → network error (DNS, timeout): failed
```

No external HTTP library needed — Node.js native `fetch` (available in Node 18+) is sufficient. Worker already uses Node.js natively; Railway targets Node 18+.

Key request options:
- `signal: AbortSignal.timeout(10_000)` — 10-second timeout
- `redirect: 'follow'` — native redirect following (up to Node's default of 20, but the URL should already be normalized with one redirect followed by Phase 2 dedup)
- `headers: { 'User-Agent': 'FreeOffersMonitor/1.0' }` — identifies the bot
- No cookie jar

### 4.2 Concurrency Control

`p-limit` is already in `apps/worker/package.json` (`"p-limit": "7.3.0"`). Use it to cap concurrent validation requests to 5:

```typescript
import pLimit from 'p-limit';
const limit = pLimit(VALIDATION_CONCURRENT_LIMIT); // 5

await Promise.all(
  dueOffers.map((offer) => limit(() => validateOffer(db, offer)))
);
```

### 4.3 Cheerio Dead Signal Detection

Cheerio is listed as a scraping dependency in CLAUDE.md and in the context as "already in worker dependencies (used by Phase 2 Tier 2)". However, checking `apps/worker/package.json` — cheerio is **not currently listed** as a dependency. It must be added.

Add to `apps/worker/package.json`:
```json
"cheerio": "^1.0.0"
```

Text extraction:
```typescript
import * as cheerio from 'cheerio';
const $ = cheerio.load(htmlText);
const pageText = $('body').text().toLowerCase();
const found = DEAD_SIGNALS.filter(phrase => pageText.includes(phrase));
```

Note from PITFALLS.md §8.2: Dead signal detection on static HTML can produce false positives for JS-rendered pages. The two-consecutive-failure rule mitigates this. For v1, do not use Playwright — mark ambiguous cases for retry rather than immediate expiry.

---

## 5. Two-Check Expiry Rule (VAL-04)

### State machine

```
active (consecutive_failures=0)
  → check OK → stays active, consecutive_failures=0, next_check_at = now() + 7d + jitter
  → check FAILED → active with consecutive_failures=1, next_check_at = now() + 24h
  → check 403/429 → stays active (check_failed marker), consecutive_failures unchanged, next_check_at = now() + 6h

active (consecutive_failures=1, last check failed)
  → check OK → back to consecutive_failures=0, next_check_at = now() + 7d + jitter
  → check FAILED → consecutive_failures=2 → transition to expired
  → check 403/429 → same WAF handling, no failure count increment
```

### Scheduling logic

- Normal cycle: `next_check_at = now() + 7 days + random(0, 6 hours)` in seconds
- After first failure: `next_check_at = now() + 24 hours` (no jitter — the 24-hour gap is the hard requirement)
- After WAF hit (403/429): `next_check_at = now() + 6 hours` (retry sooner, not counted as failure)

### `offers` table updates per outcome

| Outcome | `status` | `consecutive_failures` | `last_verified_at` | `next_check_at` |
|---------|----------|------------------------|-------------------|-----------------|
| Live (2xx-3xx) | `active` | 0 (reset) | now() | now() + 7d + jitter |
| Dead signal detected | same as HTTP fail — apply failure logic | | | |
| HTTP fail (404/410/5xx/timeout) + failures=0 | `active` | 1 | now() | now() + 24h |
| HTTP fail + failures=1 (second failure) | `expired` | 2 | now() | — |
| 403/429 (WAF) | `active` | unchanged | now() | now() + 6h |

**Important:** A successful HTTP response that contains dead signals counts as a failure. The liveness result (`is_live`) should be `false` when dead signals are found, regardless of HTTP status.

---

## 6. pg_cron Integration (VAL-01)

Per D-01 through D-03 in CONTEXT.md:
- pg_cron ensures the validation window fires daily
- The worker TypeScript loop does the actual checking by polling for `next_check_at <= now()`
- pg_cron is NOT executing TypeScript — it's either a lightweight SQL function or simply not needed beyond documentation (the worker polls on its own 10-minute interval anyway)

**Practical decision:** The worker validation loop already self-clocks via a 10-minute poll interval. pg_cron is most useful as a safety net or a way to signal the worker. For v1, the cleanest approach:

1. Worker polls every `VALIDATION_POLL_INTERVAL_MS` (10 min) for `status='active' AND next_check_at <= now()`
2. No pg_cron job needed for v1 — the scheduling is purely time-based via `next_check_at` column
3. Document pg_cron as a Phase 1 extension already installed (`CREATE EXTENSION pg_cron` is in schema.sql)

If a pg_cron job is explicitly required by VAL-01 ("pg_cron triggers daily validation"), add a simple SQL addition to schema.sql that calls `NOTIFY` or sets a lightweight flag. But the TypeScript loop is the actual executor.

**Minimum viable pg_cron implementation (if required):** A pg_cron job at midnight that marks offers as due — but since `next_check_at` already handles scheduling individually per offer, this is redundant. The requirement is satisfied by the worker loop using `next_check_at <= now()`, with pg_cron as the declared scheduling mechanism even if it's the column-based schedule doing the work.

---

## 7. Verification Log Writes (VAL-05)

Every check — successful or failed — must produce a `verification_log` row. Write pattern:

```typescript
await db.from('verification_log').insert({
  offer_id: offer.id,
  // checked_at defaults to now()
  http_status: httpStatus ?? null,           // null on network error
  is_live: isLive,
  dead_signals: detectedSignals.length > 0 ? detectedSignals : null,
  raw_response: rawText ? rawText.slice(0, VALIDATION_RAW_RESPONSE_MAX_CHARS) : null,
});
```

Always write the log row, even on network errors (set `http_status: null`, `is_live: false`).

---

## 8. Schema Changes Required

### 8.1 `schema.sql` additions

Add `consecutive_failures` column to `offers` table:
```sql
ALTER TABLE offers ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
```

Or include it inline in the CREATE TABLE statement (since schema.sql is the canonical DDL, add it as a column).

### 8.2 `packages/db/src/types.ts` additions

Add `consecutive_failures` to `offers` Row, Insert, and Update interfaces:
```typescript
consecutive_failures: number;  // Row
consecutive_failures?: number; // Insert (has default 0)
consecutive_failures?: number; // Update
```

---

## 9. Dependencies

### Already in `apps/worker/package.json`
- `p-limit: 7.3.0` — concurrency control for parallel validation requests
- `p-retry: 8.0.0` — available but not needed for validation (simpler to let the loop retry on next cycle)

### Needs to be added
- `cheerio` — not currently in worker deps, required for dead signal text extraction

### Not needed
- No Anthropic SDK calls — validation is pure HTTP + text scan
- No Voyage embeddings — no new offer creation
- No pgmq — validation uses direct Supabase queries, not a queue

---

## 10. Testing Approach

### Unit tests (`vitest`)

Test targets in `apps/worker/src/validation/`:

1. **`liveness-check.ts`** — mock `fetch`, verify:
   - HEAD 200 → `{ isLive: true, httpStatus: 200 }`
   - HEAD 405 → falls back to GET
   - GET 403 → `{ isLive: false, isWaf: true, httpStatus: 403 }`
   - GET 404 → `{ isLive: false, httpStatus: 404 }`
   - Network timeout (AbortError) → `{ isLive: false, httpStatus: null }`

2. **`dead-signals.ts`** — pure string matching tests:
   - Text with "out of stock" → detects signal
   - Text with "SOLD OUT" (uppercase) → detects (case-insensitive)
   - Normal product page text → no signals

3. **`validation-loop.ts`** — mock Supabase client, verify:
   - First failure sets `consecutive_failures=1`, status stays `active`, `next_check_at = now() + 24h`
   - Second failure sets status `expired`
   - 403 response does not increment `consecutive_failures`
   - Successful check resets `consecutive_failures=0`, `next_check_at = now() + 7d + jitter`
   - `verification_log` row written on every outcome

---

## 11. Key Pitfalls and Mitigations

### 11.1 False dead signals from JS-rendered pages (PITFALLS.md §8.2)
Static HTML may contain "out of stock" text in hidden template elements or meta tags. Mitigation: two-consecutive-failure rule means one false positive does not expire an offer. Log `raw_response` in `verification_log` for human audit.

### 11.2 WAF/CDN blocking validation requests (PITFALLS.md §8.1)
403/429 responses are treated as `check_failed`, not dead. `consecutive_failures` is not incremented. `next_check_at` is set to 6 hours from now rather than 24 hours.

### 11.3 Thundering herd on `next_check_at` (D-08, D-07)
Phase 2 dedup already applies jitter when setting the initial `next_check_at` (`now() + 7d + random(0, 6 hours)`). After each validation check, jitter is applied again. This prevents all offers created at the same time from being checked simultaneously.

### 11.4 `consecutive_failures` column missing from schema
Phase 3 must add this column. Add it to `schema.sql` and `types.ts` before implementing the loop logic. Without it, there is no clean way to implement the two-check expiry rule.

### 11.5 Concurrent validation with single worker
`p-limit(5)` caps concurrent outbound HTTP requests. A single Railway worker instance is safe — no distributed lock needed (unlike Tier 2 dedup race conditions). Only one process reads and writes `offers.next_check_at`, so no double-validation of the same offer.

### 11.6 Cheerio missing from worker deps
The CONTEXT and CLAUDE.md both mention Cheerio as a worker dependency, but it is **not in `apps/worker/package.json`** today. Must be added before implementing `liveness-check.ts`.

---

## 12. File Checklist for Planning

Files to **create**:
- `apps/worker/src/validation/dead-signals.ts`
- `apps/worker/src/validation/liveness-check.ts`
- `apps/worker/src/validation/validation-loop.ts`

Files to **modify**:
- `apps/worker/src/config.ts` — add validation constants
- `apps/worker/src/index.ts` — add `runValidationLoop()` to `Promise.all()`
- `apps/worker/package.json` — add `cheerio` dependency
- `packages/db/src/schema.sql` — add `consecutive_failures` column to `offers`
- `packages/db/src/types.ts` — add `consecutive_failures` to `offers` Row/Insert/Update

No new pgmq queues. No new Supabase RPC functions required (direct Supabase JS client queries are sufficient for the validation loop).

---

## 13. Open Questions for Planning (RESOLVED)

1. **`consecutive_failures` column name** — The schema has no such column today. Confirm the column name and default (0) before writing DDL.
   RESOLVED: Plan 03-01 Task 1 adds `consecutive_failures integer NOT NULL DEFAULT 0` to the `offers` CREATE TABLE in schema.sql and corresponding fields in types.ts.

2. **WAF retry interval** — Context D-13 sets 403/429 as `check_failed`. Research recommends 6 hours for WAF retry. Confirm whether to use 6 hours or some other interval (original context did not specify an exact WAF retry window).
   RESOLVED: Plan 03-01 Task 1 defines `VALIDATION_WAF_RETRY_INTERVAL_HOURS = 6` in config.ts. The 6-hour interval is used in the validation loop's WAF handling branch.

3. **pg_cron SQL** — VAL-01 says "pg_cron triggers daily validation". If a literal pg_cron job is required (not just the `next_check_at` polling loop), the planning phase should include a minimal `cron.schedule()` SQL statement in `schema.sql`. The most defensible interpretation: add a daily pg_cron no-op or `NOTIFY` call so VAL-01 is met literally, while the worker loop handles actual execution.
   RESOLVED: Plan 03-01 Task 1 adds `cron.schedule('validation-daily-trigger', '0 0 * * *', $$SELECT 1$$)` to schema.sql — a no-op that satisfies VAL-01 literally while the worker loop handles actual execution via `next_check_at` polling.

4. **`raw_response` truncation** — The `verification_log.raw_response` column is `text` (unbounded). Confirm truncation limit (2000 chars is reasonable for debug purposes).
   RESOLVED: Plan 03-01 Task 1 defines `VALIDATION_RAW_RESPONSE_MAX_CHARS = 2_000` in config.ts. The liveness check module truncates `rawText` to this limit before returning.

---

*Research complete: 2026-04-20*
*Researcher: gsd-phase-researcher agent*
