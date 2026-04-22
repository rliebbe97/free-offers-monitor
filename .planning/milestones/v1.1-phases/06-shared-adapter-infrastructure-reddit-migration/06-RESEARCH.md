# Phase 06 Research: Shared Adapter Infrastructure + Reddit Migration

**Researched:** 2026-04-21
**Status:** Complete

---

## Executive Summary

Phase 5 shipped a complete TheBump adapter (scraping utilities, base class, concrete adapter, DB seed, eval dataset) without touching the production ingestion path. The production loop in `ingest.ts` still has a `.eq('type', 'reddit')` hard-filter and a `createRedditAdapter()` direct call, so TheBump source rows in the DB are silently ignored. Phase 6 removes that filter, introduces a `createAdapterForSource()` dispatch factory, renames the loop function in `index.ts`, and validates cross-source dedup correctness by extending the eval dataset with 10+ Reddit+TheBump offer pairs. Every change in Phase 6 touches only two production files (`ingest.ts`, `index.ts`) and one eval file — the adapter implementations themselves are already complete and tested.

---

## Current Architecture

### File Map — Ingestion Layer

| File | Role | Phase 6 Touch? |
|------|------|----------------|
| `apps/worker/src/ingestion/source-adapter.ts` | `RawPost` + `SourceAdapter` interface | No — interface is final |
| `apps/worker/src/ingestion/reddit-adapter.ts` | `RedditAdapter` class + `createRedditAdapter()` factory | No — implementation stays; `createRedditAdapter()` remains as the factory the dispatcher calls |
| `apps/worker/src/ingestion/thebump-adapter.ts` | `TheBumpAdapter` class + `createTheBumpAdapter()` factory | No — implementation complete from Phase 5 |
| `apps/worker/src/ingestion/base-forum-adapter.ts` | Abstract `BaseForumAdapter` template method loop | No — complete from Phase 5 |
| `apps/worker/src/ingestion/scraping-utils.ts` | `fetchWithRetry`, `fetchWithRateLimit`, `respectfulDelay`, `ScrapeError`, `extractExternalId` | No — complete from Phase 5 |
| `apps/worker/src/ingestion/ingest.ts` | `fetchActiveSources()` + `runIngestionCycle()` | YES — primary migration target |
| `apps/worker/src/index.ts` | `runRedditIngestionLoop()` + `Promise.all` startup | YES — rename + comment update |
| `apps/worker/src/config.ts` | `EMBEDDING_SIMILARITY_THRESHOLD = 0.85` and all constants | Possibly — if threshold needs adjustment |
| `evals/labeled-posts.json` | 10 TheBump-only labeled posts, 5 pass + 5 reject | YES — add 10+ cross-source pairs |
| `evals/run-eval.ts` | Tier 1 eval runner (Tier 2 deferred to Phase 6 per comment in file) | Possibly — extend for dedup cosine score reporting |

### The Two Hard-Coded Reddit Guards (lines to remove/replace)

**Guard 1 — `ingest.ts` line 16:**
```ts
.eq('type', 'reddit')
```
This is inside `fetchActiveSources()`. Removing it makes the query return ALL source rows regardless of type.

**Guard 2 — `ingest.ts` line 37:**
```ts
const redditSources = sources.filter((s) => s.type === 'reddit');
```
This is inside `runIngestionCycle()`. Removing it allows all source types into the loop body.

**Guard 3 — `ingest.ts` line 50:**
```ts
const adapter = createRedditAdapter(source.identifier);
```
This is the direct Reddit adapter call. Replacing it with `createAdapterForSource(source)` is the factory migration.

**Guard 4 — `index.ts` line 93:**
```ts
async function runRedditIngestionLoop(...)
```
The function name embeds "Reddit". The ROADMAP requires renaming to `runIngestionLoop`. It is referenced at lines 228 (the `Promise.all` call) and in the JSDoc at line 90 and the `worker_started` comment at line 164.

### Existing Test Suite (must remain green after migration)

Five test files exist, none of which test `ingest.ts` or `index.ts` directly:

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `apps/worker/src/ingestion/scraping-utils.test.ts` | `ScrapeError`, `extractExternalId`, `respectfulDelay`, `fetchWithRetry` | 8 tests |
| `apps/worker/src/ingestion/base-forum-adapter.test.ts` | Pagination loop, max pages, challenge detection, skip filter, partial error | 6 tests |
| `apps/worker/src/ingestion/thebump-adapter.test.ts` | Full adapter against HTML fixtures | 10 tests |
| `apps/worker/src/validation/liveness-check.test.ts` | HTTP status, WAF, dead signals | 6 tests |
| `apps/worker/src/validation/validation-loop.test.ts` | Validation cycle logic, DB mocking | 6 tests |

No test directly covers `ingest.ts` `runIngestionCycle` or `index.ts` `runRedditIngestionLoop`. This means:
- The migration cannot accidentally break existing tests (no existing tests cover those code paths).
- The ROADMAP success criterion 3 ("Existing Reddit Vitest tests all pass") refers to the adapter-level tests above — they will continue to pass without modification since no adapter code changes.
- There is a gap: no test validates the integration behavior of `runIngestionCycle` with either adapter type. Phase 6 should decide whether to add a unit test for `createAdapterForSource()` itself.

### Dedup System

The dedup pipeline (`apps/worker/src/dedup/index.ts`) is source-type agnostic — it only operates on `OfferExtraction` output from Tier 2. No changes to the dedup layer are required for Phase 6. The cross-source dedup validation is done at the eval level, not by changing dedup code.

`EMBEDDING_SIMILARITY_THRESHOLD = 0.85` is defined in `config.ts`. The threshold is read by `findSimilarOffer()` in `embedding-dedup.ts` as the default parameter. If empirical validation suggests adjustment, only `config.ts` changes.

### Eval System (Current State)

`evals/labeled-posts.json` — 10 entries, all TheBump-only (IDs `thebump-10234567` through `thebump-11023445`), 5 pass + 5 reject. No Reddit entries, no cross-source pairs.

`evals/run-eval.ts` — Tier 1 only. Contains explicit comment: "Tier 2 eval execution deferred to Phase 6." The file is ready for extension. The eval script does not log cosine scores anywhere — the ROADMAP success criterion 4 requires dedup cosine scores to be "reported," which likely means console output from an extended runner or Axiom logging from a dev-mode worker run.

`pnpm eval` in root `package.json` is defined as: `pnpm --filter worker exec tsx ../../evals/run-eval.ts`

---

## Migration Analysis

### Step-by-Step Sequence (order matters)

**Step 1: Remove the `fetchActiveSources` type filter (Pitfall 8)**

In `ingest.ts`, remove `.eq('type', 'reddit')`. This makes the function return all source rows from the `sources` table regardless of type. No other logic changes in Step 1.

After this step alone, `runIngestionCycle` will receive TheBump sources — but Guard 2 (`sources.filter((s) => s.type === 'reddit')`) will silently drop them. This intermediate state is non-functional for TheBump but safe (no errors, no behavioral regression for Reddit).

Run `pnpm test --filter worker` after Step 1 to confirm all 5 test files still pass (they mock their dependencies and do not touch `ingest.ts`).

**Step 2: Add `createAdapterForSource()` factory + remove Reddit-only guards (Pitfall 9 — atomic)**

This step must be done as a single atomic change to `ingest.ts`:

1. Add import for `createTheBumpAdapter` from `./thebump-adapter.js`
2. Remove `const redditSources = sources.filter((s) => s.type === 'reddit');` (Guard 2)
3. Change `for (const source of redditSources)` to `for (const source of sources)` (or directly iterate `sources`)
4. Add `createAdapterForSource()` factory function that switches on `source.type`:
   - `'reddit'` → `createRedditAdapter(source.identifier)`
   - `'bump'` → `createTheBumpAdapter(source.identifier)`
   - `default` → throw `new Error(\`Unknown source type: \${source.type}\`)`
5. Replace `const adapter = createRedditAdapter(source.identifier)` (Guard 3) with `const adapter = createAdapterForSource(source)`
6. Update JSDoc on `runIngestionCycle` to remove "Reddit" references

The `createRedditAdapter` import remains — it is called by `createAdapterForSource`. The `createRedditAdapter` named export in `reddit-adapter.ts` is NOT removed (it is the implementation detail called by the factory).

**Step 3: Rename `runRedditIngestionLoop` to `runIngestionLoop` in `index.ts`**

- Rename the function definition at line 93
- Update the JSDoc at line 90
- Update the call site in `Promise.all` at line 228
- Update the comment at line 164 ("Reddit polling loop")
- Update `ingestion_loop_stopped` log event if it says "reddit" (line 115 — it just says `ingestion_loop_stopped`, no change needed)

**Step 4: Add cross-source eval pairs to `evals/labeled-posts.json`**

Add 10+ entries that are Reddit+TheBump cross-source pairs of the same physical offer. Each pair should have:
- One entry with `"source": "reddit"` and a Reddit-style URL/body
- One entry with `"source": "thebump"` and a TheBump-style URL/body
- Both entries describing the same offer (same brand, same product, same "free" claim)
- A `"cross_source_pair_id"` field (new field) linking the two entries, e.g. `"pair-001"`

The entries themselves still carry a `"label": "pass"` or `"reject"` for Tier 1, but the dedup validation uses the pair relationship.

**Step 5: Extend eval runner for dedup cosine score reporting**

The ROADMAP requires "dedup cosine scores reported." The `run-eval.ts` script currently only runs Tier 1 classification. Two options:

Option A: Add a standalone dedup validation section to `run-eval.ts` that calls `embedText()` on each cross-source pair and computes cosine similarity directly in the script. This requires a `VOYAGE_API_KEY` at eval time but produces actual cosine scores without needing a running worker.

Option B: Add dedup cosine logging to the production `dedup/embedding-dedup.ts` (add a `dedup_cosine_score` log event when `findSimilarOffer` returns a result). Then run the worker in dev mode against the seeded TheBump sources and Reddit sources and observe the scores in Axiom. No change to `run-eval.ts`.

Option A is more aligned with the ROADMAP phrasing ("pnpm eval reports dedup cosine scores") and keeps validation self-contained. Option B produces production logging that is permanently valuable but is not testable with `pnpm eval` alone.

The decision between A and B should be made during planning.

---

## Pitfalls & Risks

### Pitfall A: Double Reddit-Only Guard — Filter Removal Is Not Enough

`ingest.ts` has TWO hard-coded Reddit guards: the `.eq('type', 'reddit')` DB filter in `fetchActiveSources` (line 16) AND the `sources.filter((s) => s.type === 'reddit')` in-memory filter inside `runIngestionCycle` (line 37). Removing only the DB filter still silently drops TheBump sources at the in-memory filter. Both must be removed.

**Detection:** After removing only the DB filter, add a `console.log(sources.map(s => s.type))` to `runIngestionCycle` — TheBump sources will appear but then be filtered out. The test suite will not catch this because no test exercises `runIngestionCycle`.

### Pitfall B: `createAdapterForSource` Must Throw on Unknown Types (ROADMAP Note)

The factory's `default` branch must throw `new Error(\`Unknown source type: \${source.type}\`)`, not silently return `undefined` or skip. A future source type added to the DB without a factory entry must fail loudly, not silently produce zero posts. This is a critical correctness requirement stated in the ROADMAP.

### Pitfall C: Atomic Reddit Migration — No Interim Commit Where Both Paths Exist

The ROADMAP explicitly requires (Success Criterion 5) that old `createRedditAdapter` direct call and new factory dispatch land in the same commit. If Step 1 (filter removal) and Step 2 (factory introduction) are split into separate commits, there is a window where `runIngestionCycle` iterates all sources but calls `createRedditAdapter` for every source type — including `'bump'` sources, which will fail (the Reddit credentials are meaningless for TheBump). Step 1 and Step 2 must be combined into a single commit, or Step 1 is a standalone safe change (it only affects the DB query — the in-memory filter at line 37 still prevents TheBump sources from reaching the `createRedditAdapter` call). The cleanest approach: Steps 1 and 2 in a single commit.

### Pitfall D: `source-adapter.ts` JSDoc Still Says "Reddit Only"

Line 16 of `source-adapter.ts` reads: `* Implementations: RedditAdapter (apps/worker/src/ingestion/reddit-adapter.ts)`. This needs updating to list both adapters. Minor but should not be forgotten.

### Pitfall E: `pnpm eval` Script Path Requires `ANTHROPIC_API_KEY`

The eval script uses `@anthropic-ai/sdk` directly and exits 1 if `ANTHROPIC_API_KEY` is not set. If extending `run-eval.ts` for dedup cosine scores via Option A, it will also need `VOYAGE_API_KEY`. The eval script comment already acknowledges the `ai_calls` exemption. Both keys must be available in the dev environment running `pnpm eval`.

### Pitfall F: Cross-Source Dedup Threshold Empirical Unknowns

The 0.85 cosine threshold was set for Reddit-vs-Reddit dedup. The TheBump community posts use a different register (first-person conversational vs. Reddit's link-sharing style). A post like "Pampers sent me free newborn diapers!" on TheBump vs. "FREE Pampers newborn sample — no CC required" on Reddit may embed at 0.78–0.82 cosine similarity, falling below the 0.85 threshold and creating a duplicate offer record. The threshold is in `config.ts` as `EMBEDDING_SIMILARITY_THRESHOLD = 0.85` and is trivially adjustable without a DB migration. The empirical question cannot be answered until real Voyage embeddings are computed for the cross-source pairs — this is the core deliverable of the eval extension.

### Pitfall G: No Test for `createAdapterForSource` Itself

The existing test suite has no coverage of `runIngestionCycle` or any factory dispatch. Success Criterion 3 ("Existing Reddit Vitest tests all pass") is guaranteed by design — the adapter implementations are unchanged — but there is no positive assertion that `createAdapterForSource('bump')` returns a `TheBumpAdapter`. Adding a minimal unit test for the factory (testing all three branches: `'reddit'`, `'bump'`, and unknown type throwing) would close this gap.

### Pitfall H: `ingestion_loop_stopped` Log Event Asymmetry

After renaming `runRedditIngestionLoop` to `runIngestionLoop`, the log event on line 115 (`logger.info('ingestion_loop_stopped')`) remains `ingestion_loop_stopped` — no change needed. However, the `ingestion_loop_error` event on line 104 and any Axiom dashboard panels filtering for `ingestion_loop_*` events will still work correctly. No Axiom panel config changes are needed.

### Pitfall I: `run-eval.ts` Tier 2 Execution — Scope Clarification

The comment in `run-eval.ts` says "Tier 2 eval execution deferred to Phase 6." The ROADMAP success criterion 4 says "`pnpm eval` reports dedup cosine scores to Axiom." These are two different things. Tier 2 execution (running the Sonnet extractor against pass-labeled posts and comparing against `tier2_expected`) is distinct from dedup cosine score reporting (computing Voyage embedding similarity between cross-source pairs). Both are Phase 6 scope, but they require different extensions to `run-eval.ts`. The planner must decide whether both are in scope or just the dedup cosine portion.

---

## Key Decisions Needed

### Decision 1: Factory Shape — Function vs. Map

Two design options for `createAdapterForSource`:

**Option A — Switch statement (simpler):**
```ts
function createAdapterForSource(source: Source): SourceAdapter {
  switch (source.type) {
    case 'reddit': return createRedditAdapter(source.identifier);
    case 'bump': return createTheBumpAdapter(source.identifier);
    default: throw new Error(`Unknown source type: ${source.type}`);
  }
}
```

**Option B — Registry Map (extensible):**
```ts
type AdapterFactory = (source: Source) => SourceAdapter;
const ADAPTER_REGISTRY: Record<string, AdapterFactory> = {
  reddit: (s) => createRedditAdapter(s.identifier),
  bump: (s) => createTheBumpAdapter(s.identifier),
};

function createAdapterForSource(source: Source): SourceAdapter {
  const factory = ADAPTER_REGISTRY[source.type];
  if (!factory) throw new Error(`Unknown source type: ${source.type}`);
  return factory(source);
}
```

Option A is simpler, satisfies the ROADMAP requirement (explicit `default` throw), and is appropriate for two adapter types. Option B is more extensible but adds indirection for no current benefit. Recommendation: Option A unless FORUM-01/02/03 adapters are imminent.

### Decision 2: Dedup Cosine Reporting — Eval Script vs. Production Logging

As described in Step 5 above:

- **Option A (eval script):** Extend `run-eval.ts` to call Voyage API on cross-source pairs and compute cosine similarity, printing scores to stdout. Keeps the eval self-contained, requires `VOYAGE_API_KEY` at eval time, does not add production logging.
- **Option B (production logging):** Add `dedup_cosine_score` structured log field to `findSimilarOffer()` in `embedding-dedup.ts` when a match is found or just below the threshold. Run worker in dev mode to observe in Axiom. No changes to `run-eval.ts`.

Both satisfy "report dedup cosine scores" but serve different audiences. Recommendation: Option A for the eval file (explicit, testable, deterministic), AND Option B for production monitoring value. They are not mutually exclusive.

### Decision 3: Tier 2 Eval Execution — In or Out of Phase 6

The `run-eval.ts` comment says Tier 2 execution is deferred to Phase 6. The ROADMAP success criteria do not mention Tier 2 eval execution explicitly — only dedup cosine scores. If Tier 2 eval (running Sonnet extractor on pass-labeled posts, comparing `tier2_expected`) is included, it adds significant scope (API cost, prompt loading, response parsing for structured extraction). Recommendation: defer Tier 2 eval execution; focus Phase 6 on dedup cosine score validation per the ROADMAP success criteria.

### Decision 4: Should `fetchActiveSources` Accept a Type Filter Parameter?

The ROADMAP success criterion 1 says `fetchActiveSources` "returns all active source rows regardless of type." Two implementation paths:

- **Remove filter entirely:** `fetchActiveSources` returns everything in `sources` — including any future source types that do not yet have a factory. The `default` throw in `createAdapterForSource` provides safety.
- **Accept type array parameter:** `fetchActiveSources(db, types?: string[])` defaults to no filter, but callers can restrict. More flexible, but unnecessary complexity for two known types.

Recommendation: Remove filter entirely, rely on factory's `default` throw. The simplest implementation that satisfies the ROADMAP.

### Decision 5: Unit Test for `createAdapterForSource`?

The ROADMAP does not explicitly require a new test for the factory — Success Criterion 3 only requires existing tests to pass. However, adding a 3-case unit test (reddit → RedditAdapter, bump → TheBumpAdapter, unknown → throws) would close the coverage gap noted in Pitfall G. This test would require mocking `createRedditAdapter` and `createTheBumpAdapter` (following the established `vi.mock` pattern). Recommendation: add the test — it is low effort and provides the only explicit validation of the factory's correctness.

---

## File Inventory

### Files Modified in Phase 6

**`apps/worker/src/ingestion/ingest.ts`** — Primary migration target
- Current state: imports `createRedditAdapter`, has `.eq('type', 'reddit')` DB filter, has `sources.filter((s) => s.type === 'reddit')` in-memory filter, calls `createRedditAdapter(source.identifier)` directly
- Changes: add `createTheBumpAdapter` import, add `createAdapterForSource()` function, remove both Reddit-only filters, replace direct `createRedditAdapter` call with `createAdapterForSource(source)`, update JSDoc
- Risk: medium (touches production ingestion path, but no existing tests cover it)

**`apps/worker/src/index.ts`** — Loop rename
- Current state: `runRedditIngestionLoop` defined at line 93, called at line 228, referenced in comments at lines 90, 164, 226
- Changes: rename function to `runIngestionLoop`, update all 4 references, no logic changes
- Risk: low (pure rename, no behavior change)

**`evals/labeled-posts.json`** — Cross-source eval pairs
- Current state: 10 TheBump-only entries
- Changes: add 10+ Reddit+TheBump cross-source pairs with `"source": "reddit"` or `"source": "thebump"` and a linking `"cross_source_pair_id"` field. Must include both a `"pass"` and equivalent for Tier 1 labeling.
- Risk: low (data file, no code impact)

**`evals/run-eval.ts`** — Dedup cosine reporting (if Option A chosen)
- Current state: Tier 1 classification only, reads `labeled-posts.json`
- Changes: add a second pass over entries with `cross_source_pair_id`, call `embedText()` on each, compute cosine similarity, print scores, log whether the score is above/below `EMBEDDING_SIMILARITY_THRESHOLD`
- Risk: low (standalone dev script, no production code path)

### Files Possibly Modified (threshold adjustment only)

**`apps/worker/src/config.ts`**
- Current state: `EMBEDDING_SIMILARITY_THRESHOLD = 0.85`
- Changes: adjust value if empirical cross-source cosine distribution warrants it, with a documented rationale in a JSDoc comment
- Risk: low (single constant, no DB migration required)

### Files That Should NOT Be Modified in Phase 6

- `apps/worker/src/ingestion/reddit-adapter.ts` — adapter implementation is complete, `createRedditAdapter` stays exported
- `apps/worker/src/ingestion/thebump-adapter.ts` — adapter implementation is complete from Phase 5
- `apps/worker/src/ingestion/base-forum-adapter.ts` — base class is complete
- `apps/worker/src/ingestion/scraping-utils.ts` — utilities are complete
- `apps/worker/src/ingestion/source-adapter.ts` — interface is final (JSDoc comment update is the only allowed change)
- `apps/worker/src/dedup/` — dedup pipeline is source-type agnostic, no changes needed
- `packages/db/src/` — schema and types are not changing
- `apps/worker/vitest.config.ts` — no new env vars being added (no new `getEnvOrThrow` calls in Phase 6)

### Files Created in Phase 6

No new source files. The phase is purely a migration + eval data extension.

---

## Additional Context

### `source-adapter.ts` JSDoc Gap

Line 16 of `source-adapter.ts`:
```ts
 * Implementations: RedditAdapter (apps/worker/src/ingestion/reddit-adapter.ts)
```
Should be updated to list both adapters:
```ts
 * Implementations: RedditAdapter (reddit-adapter.ts), TheBumpAdapter (thebump-adapter.ts)
```

### `ingest.ts` Comment Gap

Line 26 JSDoc says "Run one full ingestion cycle across all active Reddit sources." After migration it should read "Run one full ingestion cycle across all active sources."

Line 10 JSDoc says "Fetch all active Reddit sources." After migration it should read "Fetch all active sources."

### Cross-Source Eval Pair Construction

The eval pairs must be believable but do not need to be exact duplicates. They represent the same physical offer described on two different platforms. Example pair:

Reddit entry:
```json
{
  "id": "reddit-abc123",
  "source": "reddit",
  "cross_source_pair_id": "pair-001",
  "url": "https://reddit.com/r/FreeSamples/comments/abc123/free_pampers_newborn_samples",
  "title": "FREE Pampers newborn samples — just requested mine!",
  "body": "Pampers is giving away free newborn diaper samples again. No CC needed, just fill out the form. Got mine in about 2 weeks. Zero shipping cost.",
  "label": "pass"
}
```

TheBump entry:
```json
{
  "id": "thebump-10234567",
  "source": "thebump",
  "cross_source_pair_id": "pair-001",
  "url": "https://community.thebump.com/discussion/10234567/free-diaper-samples-in-the-mail",
  "title": "Free diaper samples — just got mine in the mail!",
  "body": "Wanted to share — I requested free diaper samples from Pampers a couple weeks ago and they finally arrived today. Totally free, no shipping charge...",
  "label": "pass"
}
```

Note: Some of the existing 10 TheBump entries in `labeled-posts.json` can be reused as one side of a pair — add the matching Reddit entry. The `cross_source_pair_id` field is new to the schema.

### Cosine Similarity Computation for Eval

If Option A for dedup reporting is chosen, the cosine similarity formula for two normalized 1024-dim vectors is:

```ts
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

Voyage embeddings are not pre-normalized by the API, so the normalization step matters. The pgvector `<=>` operator (cosine distance = 1 - similarity) handles this internally in the production dedup SQL, but a standalone script must compute it manually.

### `ingest.ts` — Secondary In-Memory Filter

The current `runIngestionCycle` body (lines 36–154) has this structure:

```ts
export async function runIngestionCycle(db: DbClient, sources: Source[]): Promise<void> {
  const redditSources = sources.filter((s) => s.type === 'reddit');  // LINE 37: REMOVE
  for (const source of redditSources) {  // LINE 39: change to `sources`
    ...
    const adapter = createRedditAdapter(source.identifier);  // LINE 50: replace
```

After migration:
```ts
export async function runIngestionCycle(db: DbClient, sources: Source[]): Promise<void> {
  for (const source of sources) {
    ...
    const adapter = createAdapterForSource(source);
```

The `createAdapterForSource` function is defined in the same file (not exported unless tests need it). It can be a module-private function since it is only called from `runIngestionCycle`.

---

## RESEARCH COMPLETE
