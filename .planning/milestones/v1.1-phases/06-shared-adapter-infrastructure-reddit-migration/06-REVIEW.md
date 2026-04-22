---
status: issues_found
phase: "06"
depth: standard
files_reviewed: 6
findings:
  critical: 1
  warning: 5
  info: 4
  total: 10
reviewed_at: 2026-04-21T00:00:00Z
---

# Code Review: Phase 06

## Summary

The Phase 6 files are well-structured with good error handling and logging throughout. One critical correctness bug exists in `fetchActiveSources` (missing active-filter clause means the worker polls every source row regardless of status), and several moderate issues cover upsert semantics, test coverage gaps, and eval robustness that should be addressed before production deployment.

## Findings

### CR-1: `fetchActiveSources` fetches ALL sources, not just active ones
**Severity:** critical
**File:** `apps/worker/src/ingestion/ingest.ts:31-33`
**Description:** The query `db.from('sources').select('*')` has no filter. The function is named `fetchActiveSources` and the docstring says "Fetch all active sources from the sources table," but there is no `.eq('active', true)` or similar predicate. If the `sources` table has an `active`/`enabled` column (or a soft-delete column), inactive or paused sources will be polled every cycle regardless. Even if the `sources` table has no such column today, the omission means there is no way to disable a source without deleting the row.
**Suggestion:** Either add a filter (`.eq('active', true)`) if the column exists in the schema, or add an `active boolean DEFAULT true` column to the schema and the `Source` type, then filter here. At minimum, rename the function to `fetchAllSources` to align with its actual behaviour so future readers are not misled.

---

### WR-1: Upsert on `pipeline_status` unconditionally overwrites re-polled posts
**Severity:** warning
**File:** `apps/worker/src/ingestion/ingest.ts:83-98`
**Description:** The upsert sets `pipeline_status: 'ingested'` in both the insert and the conflict-update path (Supabase's `upsert` with `onConflict` updates every specified column on conflict). A post that has already progressed to `tier1_passed` or `tier2_extracted` will have its `pipeline_status` reset to `'ingested'` every time the same external post is returned by the adapter on a re-poll (e.g. during the 1-hour fallback window or if `last_polled_at` is stale). This could cause already-processed posts to be re-enqueued into `tier1_queue`.
**Suggestion:** Either exclude `pipeline_status` from the upsert columns (so only new rows set it) by using an explicit insert with an `onConflict: 'ignore'` strategy, or add `.select('id, pipeline_status')` and skip Tier 0 + enqueue if `pipeline_status !== 'ingested'`. Supabase also supports `ignoreDuplicates: true` to silently skip existing rows.

---

### WR-2: `passedCount` not incremented when enqueue succeeds on a conflict row
**Severity:** warning
**File:** `apps/worker/src/ingestion/ingest.ts:116-133`
**Description:** `passedCount++` sits inside the `try` block for `enqueueTier1`. If `enqueueTier1` throws, the post still passed Tier 0 (the DB was updated) but the count stays as if it didn't. More importantly, if the upsert hits the conflict path (existing post), the post passes Tier 0 again, its status is set to `tier0_passed`, and it is re-enqueued — but if `enqueueTier1` then throws, `passedCount` is under-counted and the `ingestion_cycle_complete` log is misleading. The real issue is WR-1 (double-enqueue), but this secondary counting inaccuracy obscures it.
**Suggestion:** Move `passedCount++` above the `enqueueTier1` call and track `enqueuedCount` separately; or increment it unconditionally after the `update` succeeds to reflect "passed Tier 0" (distinct from "successfully enqueued").

---

### WR-3: `Promise.all` in `main()` — one loop crash kills the whole worker
**Severity:** warning
**File:** `apps/worker/src/index.ts:227-232`
**Description:** `Promise.all([runIngestionLoop, runTier1ConsumerLoop, runTier2ConsumerLoop, runValidationLoop])` means a single unhandled rejection from any loop terminates the entire `main()` awaitable, then hits the `.catch` handler which calls `process.exit(1)`. Each loop does have internal try/catch for per-cycle errors, but a bug that escapes those try blocks (e.g. an error thrown synchronously before the first iteration, or an error in loop setup) will bring down all sibling loops. In a production worker this would cause unnecessary full restarts.
**Suggestion:** Wrap each `Promise.all` entry in a per-loop error boundary that logs and optionally restarts the individual loop, e.g. using a `restartOnError` wrapper. At minimum, use `Promise.allSettled` and inspect results at completion, so one loop dying does not silently swallow the others.

---

### WR-4: `cosineSimilarity` in `run-eval.ts` has a division-by-zero risk
**Severity:** warning
**File:** `evals/run-eval.ts:53-62`
**Description:** If either embedding vector has all-zero components (which should not happen in practice but could occur if the Voyage API returns a malformed or zero-padded result), `Math.sqrt(normA) * Math.sqrt(normB)` is `0` and the function returns `NaN`. `NaN >= 0.85` is `false`, so the pair would silently be counted as `pairsBelow` and the warning would fire, but no error is raised and no indication is given that the similarity is invalid.
**Suggestion:** Guard the denominator:
```ts
const denom = Math.sqrt(normA) * Math.sqrt(normB);
if (denom === 0) throw new Error('Zero-norm embedding — cosine similarity undefined');
return dot / denom;
```

---

### WR-5: `ingest.test.ts` has zero coverage for `runIngestionCycle` and `fetchActiveSources`
**Severity:** warning
**File:** `apps/worker/src/ingestion/ingest.test.ts`
**Description:** The test file only tests `createAdapterForSource` (three cases). The two other exported functions — `fetchActiveSources` and `runIngestionCycle` — have no test coverage at all. `runIngestionCycle` contains significant branching logic: Tier 0 pass/reject paths, upsert error handling, enqueue error handling, and the `last_polled_at` fallback. These are the highest-risk code paths and the most likely to regress.
**Suggestion:** Add Vitest tests that mock a Supabase client (or use a lightweight stub) to cover: (a) `fetchActiveSources` throws when the DB returns an error; (b) `runIngestionCycle` calls `passesKeywordFilter`, enqueues passing posts, and updates `last_polled_at`; (c) a failed upsert on one post does not skip subsequent posts (`continue` path).

---

### IR-1: `fetchActiveSources` missing `active` filter also affects `source.last_polled_at` update
**Severity:** info
**File:** `apps/worker/src/ingestion/ingest.ts:147-157`
**Description:** Downstream of CR-1, if paused/disabled sources are polled, their `last_polled_at` timestamp is still updated. This means re-enabling a source later would miss posts published during the disabled period because `since` would be derived from the stale `last_polled_at` rather than the actual pause time.
**Suggestion:** Resolved by fixing CR-1. No additional action needed beyond adding the active filter.

---

### IR-2: `run-eval.ts` Tier 2 deferred eval section is not clearly flagged in CI output
**Severity:** info
**File:** `evals/run-eval.ts:13-16`
**Description:** The NOTE comment explaining Tier 2 eval is deferred is clear in source, but at runtime the script exits 0 even when the `tier2_expected` fields are populated in `labeled-posts.json`. There is no runtime warning printed to stdout that Tier 2 cases were skipped. A developer running `pnpm eval` and seeing "PASS" might incorrectly assume Tier 2 has been validated.
**Suggestion:** Add a runtime log line counting how many entries have `tier2_expected !== null` and printing e.g. `NOTE: Tier 2 eval skipped for N entries — run when Tier 2 runner is implemented`. This makes the scope of the eval self-documenting at runtime, not just in source comments.

---

### IR-3: `source-adapter.ts` — `RawPost.url` typed as non-nullable but can be empty string in practice
**Severity:** info
**File:** `apps/worker/src/ingestion/source-adapter.ts:7`
**Description:** `url: string` in `RawPost` is non-nullable. In `reddit-adapter.ts` line 101, the `postUrl` is produced with a fallback, so it is always populated. However, in `thebump-adapter.ts`, `url` is derived from `href` which is guarded by `if (!href) return`, so it is also always set. The risk is future adapters — the type permits an empty string `""` without requiring null handling. If a bug in a new adapter passes an empty string, it will be stored in `posts.url` silently.
**Suggestion:** Either add a non-empty-string validation utility in `RawPost` construction, or document the invariant with a comment on the field. Low urgency but worth noting as the adapter surface grows.

---

### IR-4: `labeled-posts.json` entry `thebump-11023445` is missing `cross_source_pair_id`
**Severity:** info
**File:** `evals/labeled-posts.json:160-170`
**Description:** The entry for `thebump-11023445` (Costco BOGO wipes) has no `cross_source_pair_id` field while all other entries have one (including `undefined` being omitted). This is consistent with the interface (`cross_source_pair_id?: string`) so it is not a bug, but there is no corresponding Reddit-side entry for this case. The dataset has 11 TheBump entries and 10 Reddit entries; this appears to be an intentional standalone reject case. Worth confirming it was deliberately left unpaired.
**Suggestion:** Add a `notes` clarification like `"no reddit pair — standalone reject case"` or assign a `pair-011` if a Reddit counterpart is planned. No code change required.

---

## Files Reviewed

| File | Lines |
|---|---|
| `apps/worker/src/ingestion/ingest.ts` | 168 |
| `apps/worker/src/ingestion/source-adapter.ts` | 20 |
| `apps/worker/src/index.ts` | 240 |
| `apps/worker/src/ingestion/ingest.test.ts` | 67 |
| `evals/run-eval.ts` | 269 |
| `evals/labeled-posts.json` | 356 |
| **Total** | **1,120** |
