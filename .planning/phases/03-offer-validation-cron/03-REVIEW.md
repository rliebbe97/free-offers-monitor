---
phase: 03-offer-validation-cron
reviewed: 2026-04-20T22:52:51Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - apps/worker/src/validation/dead-signals.ts
  - apps/worker/src/validation/liveness-check.ts
  - apps/worker/src/validation/validation-loop.ts
  - apps/worker/src/config.ts
  - apps/worker/src/index.ts
  - packages/db/src/schema.sql
  - packages/db/src/types.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-20T22:52:51Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Phase 03 implements the offer validation cron subsystem: a fourth concurrent worker loop that polls active offers, performs HEAD+GET liveness checks, scans for dead-signal phrases in page body text, and writes results to `verification_log` while updating `offers.status` and `consecutive_failures`. The design is generally sound — errors are isolated per offer, concurrency is capped with `p-limit`, and WAF blocks are handled without incrementing failure counters.

Four warnings are raised, none of which are data-loss critical but each represents a real correctness or reliability gap. The most significant are: (1) `HEAD 403` being treated as a WAF block (skipping GET body analysis and never fetching the URL), (2) `offers.updated_at` never being written by the validation loop despite the column having `NOT NULL DEFAULT now()` — it will silently drift without a DB trigger, and (3) `VALIDATION_MAX_REDIRECTS` being exported from config but never consumed. Three info-level items cover dead code, a pg_cron no-op job, and a minor WAF inconsistency.

---

## Warnings

### WR-01: HEAD 403 Short-Circuits to WAF — Skips GET Body Analysis

**File:** `apps/worker/src/validation/liveness-check.ts:52-53`

**Issue:** When a HEAD request returns 403, the function immediately returns `{ isLive: false, isWaf: true }` and never falls through to the GET. This is incorrect for two reasons: (a) many origin servers return 403 on HEAD but serve the page normally on GET (403 on HEAD is NOT a reliable WAF signal — WAFs typically block uniformly across methods), and (b) the page body might contain dead signals that would correctly classify the offer as expired. The GET fallback logic for 403 (lines 78-79) handles this correctly, but HEAD 403 never reaches it. The result is that a 403-on-HEAD offer is permanently frozen in a WAF-retry loop, never expiring.

**Fix:** Treat HEAD 403 the same as HEAD 404/410/5xx — fall through to GET for body analysis. Only classify as WAF after the GET also returns 403/429:

```typescript
// In the HEAD block, replace the 403/429 WAF short-circuit:
if (headStatus === 403 || headStatus === 429) {
  // Fall through to GET — HEAD 403 is unreliable; WAF classification
  // requires GET confirmation. skipToGet already set by fall-through.
  skipToGet = true;
} else if (headStatus === 405 || headStatus === 404 || headStatus === 410 || headStatus >= 500) {
  skipToGet = true;
}
```

---

### WR-02: `offers.updated_at` Never Written by Validation Updates

**File:** `apps/worker/src/validation/validation-loop.ts:56-59, 67-71, 79-83, 91-96`

**Issue:** Every `.update()` call in `validateOffer` omits `updated_at`. The `offers` table declares `updated_at timestamptz NOT NULL DEFAULT now()` (schema.sql line 79), but that default only applies at INSERT time. Without a `BEFORE UPDATE` trigger (none exists in schema.sql), `updated_at` is never refreshed. Supabase does not add this trigger automatically — the column will silently show the original creation timestamp after every validation update, making it useless for "last modified" queries.

**Fix:** Either add an `updated_at` trigger to schema.sql, or include it explicitly in every update:

```sql
-- schema.sql addition:
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER offers_set_updated_at
  BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Or in validation-loop.ts, add to each update payload:

```typescript
await db.from('offers').update({
  updated_at: new Date().toISOString(),
  last_verified_at: new Date().toISOString(),
  next_check_at: nextCheckAtHours(VALIDATION_WAF_RETRY_INTERVAL_HOURS),
}).eq('id', offer.id);
```

---

### WR-03: `VALIDATION_MAX_REDIRECTS` Exported but Never Consumed

**File:** `apps/worker/src/config.ts:39`

**Issue:** `VALIDATION_MAX_REDIRECTS = 5` is exported and documented but not imported or used anywhere in the codebase. The `liveness-check.ts` calls `fetch` with `redirect: 'follow'`, which uses the platform default (no cap on redirect hops). This means the constant provides a false safety guarantee — the redirect limit is not actually enforced.

**Fix:** Either enforce it in `liveness-check.ts` using a manual redirect-following loop, or remove the constant and update its comment to note that `fetch` follows redirects natively (and document the actual platform behavior):

```typescript
// Option A: remove false guarantee from config.ts
// (delete the VALIDATION_MAX_REDIRECTS export and its comment)

// Option B: enforce it in liveness-check.ts using a manual loop
// (more involved — requires replacing fetch redirect:'follow' with
//  redirect:'manual' + loop up to VALIDATION_MAX_REDIRECTS times)
```

---

### WR-04: Unhandled `verification_log` Insert Error in `validateOffer`

**File:** `apps/worker/src/validation/validation-loop.ts:46-52`

**Issue:** The `db.from('verification_log').insert(...)` call does not check its returned `error` property. Supabase JS client does not throw on query errors — it returns `{ data, error }`. If the insert fails (e.g., FK violation because `offer_id` was deleted between the query and the insert, or a transient DB error), the error is silently swallowed and the function proceeds to update `offers` as if the log write succeeded. This breaks the audit trail requirement (VAL-05) silently.

**Fix:**

```typescript
const { error: logError } = await db.from('verification_log').insert({
  offer_id: offer.id,
  http_status: result.httpStatus,
  is_live: result.isLive,
  dead_signals: result.deadSignals.length > 0 ? result.deadSignals : null,
  raw_response: result.rawText,
});

if (logError) {
  logger.error('validation_log_insert_error', {
    offer_id: offer.id,
    error: logError.message,
  });
  // Do not proceed — verification_log write is required by VAL-05
  return;
}
```

---

## Info

### IN-01: Dead Variables `skipToGet` and `headStatus` Suppressed with `void`

**File:** `apps/worker/src/validation/liveness-check.ts:63-65`

**Issue:** The `void headStatus; void skipToGet;` lines at lines 63-65 are a code smell — they exist solely to suppress TypeScript/ESLint "assigned but never used" warnings about variables that serve no purpose after the HEAD block's early-return logic. The `skipToGet` flag is set but never read (the code always falls through to the GET block). This can be simplified significantly.

**Fix:** Remove the `skipToGet` flag and `headStatus` void suppression. The GET block is always reached when the HEAD block doesn't `return` — no flag is needed:

```typescript
// Remove: let skipToGet = false; and all skipToGet assignments
// Remove: void headStatus; void skipToGet;
// The GET block is the natural fall-through — no flag required.
```

---

### IN-02: pg_cron Validation Job Runs a No-Op `SELECT 1`

**File:** `packages/db/src/schema.sql:229-233`

**Issue:** The pg_cron schedule `validation-daily-trigger` executes `SELECT 1` — a complete no-op. The schema comment acknowledges this ("the worker does not depend on this cron job"), but the cron entry adds operational confusion: it appears in `cron.job` output, suggests daily scheduling matters, yet does nothing. If the intent is purely declarative (satisfying VAL-01 on paper), this should be clearly marked or removed to avoid confusion during ops incident response.

**Fix:** Either remove the `cron.schedule` call entirely (since the worker polls independently) or replace the no-op with a comment explaining that the worker self-schedules:

```sql
-- VAL-01: Validation scheduling is handled by the worker's own polling loop
-- (10-minute interval via VALIDATION_POLL_INTERVAL_MS). No pg_cron job required.
-- SELECT cron.schedule(...) intentionally omitted.
```

---

### IN-03: WAF Inconsistency — HEAD 403 vs GET 403 Treated Differently

**File:** `apps/worker/src/validation/liveness-check.ts:52-53, 78-79`

**Issue:** HEAD 403 → `isLive: false, isWaf: true` (no body check). GET 403 → `isLive: false, isWaf: true` (no body check). These produce the same `isWaf: true` result, but because HEAD 403 short-circuits before GET (see WR-01), the dead-signal page analysis never runs for HEAD 403 responses. The inconsistency is a side effect of WR-01 — fixing WR-01 resolves this automatically.

**Fix:** Addressed by fixing WR-01 above.

---

_Reviewed: 2026-04-20T22:52:51Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
