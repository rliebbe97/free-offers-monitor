# Phase 06 Patterns: Shared Adapter Infrastructure + Reddit Migration

**Mapped:** 2026-04-21

---

## File: `apps/worker/src/ingestion/ingest.ts`

**Role:** Orchestrates the full ingestion cycle — fetches all active sources from the DB, creates an adapter per source, fetches new posts, runs Tier 0 keyword filter, upserts posts, and enqueues tier1 jobs. Also exports `fetchActiveSources()` for use in `index.ts`.

**Changes:** Remove two Reddit-only guards (`.eq('type', 'reddit')` DB filter and `sources.filter((s) => s.type === 'reddit')` in-memory filter). Add `createAdapterForSource(source: Source): SourceAdapter` factory function. Replace direct `createRedditAdapter(source.identifier)` call with the factory. Add `createTheBumpAdapter` import. Update JSDoc comments.

**Analog:** `apps/worker/src/ingestion/thebump-adapter.ts` — `createTheBumpAdapter()` and `apps/worker/src/ingestion/reddit-adapter.ts` — `createRedditAdapter()` are the two concrete factories that `createAdapterForSource` will dispatch to.

### Current State

```ts
// ingest.ts — imports (lines 1-6)
import type { createClient, Source } from '@repo/db';
import { logger } from '../logger.js';
import { passesKeywordFilter } from '../tiers/tier0.js';
import { enqueueTier1 } from '../queue/producer.js';
import { createRedditAdapter } from './reddit-adapter.js';

// Guard 1 — DB filter inside fetchActiveSources (line 16):
.eq('type', 'reddit');

// Guard 2 — in-memory filter inside runIngestionCycle (line 37):
const redditSources = sources.filter((s) => s.type === 'reddit');

// Guard 3 — direct adapter instantiation (line 50):
const adapter = createRedditAdapter(source.identifier);
```

### Pattern to Follow

Both adapter factories follow the same shape — a function that takes a string identifier and returns the adapter instance:

```ts
// reddit-adapter.ts (lines 207-210)
export function createRedditAdapter(subredditName: string): RedditAdapter {
  const reddit = createRedditClient();
  return new RedditAdapter(reddit, subredditName);
}

// thebump-adapter.ts (lines 177-179)
export function createTheBumpAdapter(sourceIdentifier: string): TheBumpAdapter {
  return new TheBumpAdapter(sourceIdentifier);
}
```

The new `createAdapterForSource` factory dispatches to these via a switch on `source.type`. The RESEARCH doc (Decision 1) recommends Option A — a switch statement over a registry map — for simplicity at two known types. The `default` branch MUST throw (Pitfall B):

```ts
// Pattern to implement (from 06-RESEARCH.md Decision 1 / Option A)
function createAdapterForSource(source: Source): SourceAdapter {
  switch (source.type) {
    case 'reddit': return createRedditAdapter(source.identifier);
    case 'bump':   return createTheBumpAdapter(source.identifier);
    default:       throw new Error(`Unknown source type: ${source.type}`);
  }
}
```

Import pattern — both named exports, `.js` extension (ESM), from sibling files:

```ts
import { createRedditAdapter } from './reddit-adapter.js';
import { createTheBumpAdapter } from './thebump-adapter.js';
```

Error handling pattern inside `runIngestionCycle` for adapter fetch failures — catch per source, log with `source_id` + `identifier`, `continue` to next source (lines 53-61). This pattern is already in place and must remain unchanged:

```ts
try {
  posts = await adapter.fetchNewPosts(since);
} catch (err) {
  logger.error('ingestion_fetch_error', {
    source_id: source.id,
    identifier: source.identifier,
    error: String(err),
  });
  continue;
}
```

### Data Flow

`index.ts` → `fetchActiveSources(db)` → `runIngestionCycle(db, sources)` → `createAdapterForSource(source)` → `RedditAdapter | TheBumpAdapter` → `fetchNewPosts(since)` → upsert to `posts` table → `passesKeywordFilter()` → `enqueueTier1(db, postId)`.

---

## File: `apps/worker/src/index.ts`

**Role:** Worker entry point. Loads prompts, initializes clients, asserts Postgres extensions, starts the HTTP health endpoint, registers graceful shutdown, and runs all concurrent loops via `Promise.all`.

**Changes:** Rename `runRedditIngestionLoop` to `runIngestionLoop` — pure rename, zero logic changes. Update the function definition (line 93), its JSDoc (line 90), the `Promise.all` call site (line 228), and the comment at line 226. The log event `ingestion_loop_stopped` (line 115) contains no "Reddit" text and needs no change.

**Analog:** The sibling loop functions `runTier1ConsumerLoop` and `runTier2ConsumerLoop` (lines 121-160) are the established pattern for naming and structure. They use a non-source-specific naming convention — `run[Stage]Loop` — which `runIngestionLoop` now joins.

### Current State

```ts
// index.ts (lines 90-116)
/**
 * Reddit polling loop — fetches sources and runs one ingestion cycle per interval.
 * Catches errors per cycle so a transient failure does not crash the process.
 */
async function runRedditIngestionLoop(
  db: DbClient,
  shutdown: { stop: boolean },
): Promise<void> {
  while (!shutdown.stop) {
    // ...
  }
  logger.info('ingestion_loop_stopped');
}

// index.ts (lines 226-232) — the Promise.all call site
// Run Reddit polling loop, Tier 1 consumer, Tier 2 consumer, and validation loop concurrently
await Promise.all([
  runRedditIngestionLoop(db, shutdown),
  runTier1ConsumerLoop(db, anthropic, tier1Prompt, promptVersion, shutdown),
  runTier2ConsumerLoop(db, anthropic, tier2Prompt, promptVersion, shutdown),
  runValidationLoop(db, shutdown),
]);
```

### Pattern to Follow

The naming convention for the other loop functions in the same file:

```ts
// index.ts (lines 121-138)
async function runTier1ConsumerLoop(
  db: DbClient,
  anthropic: Anthropic,
  prompt: string,
  promptVersion: string,
  shutdown: { stop: boolean },
): Promise<void> { ... }

// index.ts (lines 143-160)
async function runTier2ConsumerLoop(
  db: DbClient,
  anthropic: Anthropic,
  prompt: string,
  promptVersion: string,
  shutdown: { stop: boolean },
): Promise<void> { ... }
```

The rename follows the same convention: drop the source-specific qualifier, keep `run[Noun]Loop`. All four locations that reference `runRedditIngestionLoop` must be updated in a single atomic change:

1. Function definition (line 93)
2. JSDoc description (line 91 — "Reddit polling loop")
3. `Promise.all` call (line 228)
4. Inline comment at line 226 ("Run Reddit polling loop...")

### Data Flow

`main()` → `Promise.all([runIngestionLoop(...), ...])` → `fetchActiveSources(db)` + `runIngestionCycle(db, sources)` (imported from `./ingestion/ingest.js`).

---

## File: `evals/labeled-posts.json`

**Role:** Ground-truth dataset for the eval runner. Contains labeled posts (`pass` / `reject`) used to measure Tier 1 classification accuracy. Phase 6 extends it with cross-source pairs to validate dedup cosine behavior.

**Changes:** Add 10+ entries with `"source": "reddit"` alongside matching TheBump entries (some existing entries can be reused as one side of a pair). Each cross-source entry adds a new `"cross_source_pair_id"` field linking the two entries that describe the same offer. Existing 10 TheBump-only entries are left unchanged.

**Analog:** The existing 10 TheBump entries are the direct pattern analog. The Reddit entries follow the same JSON schema, with `"source": "reddit"` and Reddit-style URLs/bodies.

### Current State

All 10 entries follow this schema (TheBump source only):

```json
{
  "id": "thebump-10234567",
  "source": "thebump",
  "url": "https://community.thebump.com/discussion/10234567/free-diaper-samples-in-the-mail",
  "external_id": "10234567",
  "title": "Free diaper samples — just got mine in the mail!",
  "body": "Wanted to share — I requested free diaper samples from Pampers...",
  "author": "MamaOf2Soon",
  "posted_at": "2026-02-15T14:22:00Z",
  "label": "pass",
  "tier2_expected": {
    "is_valid_offer": true,
    "item": "diaper samples (newborn and size 1)",
    "shipping_cost": "free"
  },
  "label_reason": "Genuinely free physical diaper samples mailed to home...",
  "notes": "Clear pass — classic sample request with no payment barrier"
}
```

Reject entries have `"tier2_expected": null`.

### Pattern to Follow

The RESEARCH doc provides the exact cross-source pair structure. New entries add one field (`cross_source_pair_id`) to the existing schema. Reddit entries use `reddit-[alphanumeric]` IDs and `https://reddit.com/r/[subreddit]/comments/[id]/[slug]` URLs:

```json
{
  "id": "reddit-abc123",
  "source": "reddit",
  "cross_source_pair_id": "pair-001",
  "url": "https://reddit.com/r/FreeSamples/comments/abc123/free_pampers_newborn_samples",
  "external_id": "abc123",
  "title": "FREE Pampers newborn samples — just requested mine!",
  "body": "Pampers is giving away free newborn diaper samples again. No CC needed, just fill out the form. Got mine in about 2 weeks. Zero shipping cost.",
  "author": "some_reddit_user",
  "posted_at": "2026-02-16T09:00:00Z",
  "label": "pass",
  "tier2_expected": {
    "is_valid_offer": true,
    "item": "diaper samples (newborn)",
    "shipping_cost": "free"
  },
  "label_reason": "Same Pampers sample offer as pair-001 TheBump entry, described from a Reddit perspective.",
  "notes": "Cross-source pair — Reddit side of pair-001"
}
```

The matching TheBump entry in the same pair gets `"cross_source_pair_id": "pair-001"` added to the existing object. The existing entry `"thebump-10234567"` (free diaper samples) is the natural TheBump side of `pair-001`.

### Data Flow

`evals/run-eval.ts` reads this file with `JSON.parse(readFileSync(...))`. The `LabeledPost` interface in `run-eval.ts` will need `cross_source_pair_id?: string` added to accept the new field without a type error.

---

## File: `evals/run-eval.ts`

**Role:** Standalone dev-time eval script. Currently runs Tier 1 classification against all labeled posts, prints a per-entry result table and confusion matrix, exits 1 if accuracy falls below `PASS_THRESHOLD`. Phase 6 extends it to also compute dedup cosine scores for cross-source pairs using the Voyage API directly (RESEARCH Option A).

**Changes:** Add a second eval pass that groups entries by `cross_source_pair_id`, calls `embedText()` on each pair member's combined text, computes cosine similarity, prints a dedup score table, and reports whether each score is above or below `EMBEDDING_SIMILARITY_THRESHOLD`. The Tier 1 pass is unchanged.

**Analog:** `apps/worker/src/dedup/embedding-dedup.ts` — `embedText()` is the direct function to reuse (or inline the same fetch pattern). The cosine similarity formula from the RESEARCH doc is the reference implementation. The existing `run-eval.ts` console output pattern (header + per-row table + summary block) is the style to follow.

### Current State

```ts
// run-eval.ts (lines 1-5) — imports
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

// run-eval.ts (lines 19-38) — interfaces
interface Tier2Expected {
  is_valid_offer: boolean;
  item: string;
  shipping_cost?: string;
}

interface LabeledPost {
  id: string;
  source: string;
  // ... (no cross_source_pair_id field yet)
  label: 'pass' | 'reject';
  tier2_expected: Tier2Expected | null;
}

// run-eval.ts (lines 46-47) — thresholds
const PASS_THRESHOLD = 0.7;
const MODEL = 'claude-haiku-4-20250514';

// run-eval.ts (lines 74-76) — Tier 1 table header pattern
console.log(`Running Tier 1 eval on ${posts.length} posts with model ${MODEL}\n`);
console.log('ID                      | Expected | Predicted | Confidence | Match');
console.log('------------------------|----------|-----------|------------|------');

// run-eval.ts (lines 121-142) — summary block pattern
console.log('\n--- Summary ---');
console.log(`Total:       ${total}`);
console.log(`Accuracy:    ${accuracy.toFixed(2)}`);
// ... (precision, recall, F1, threshold, confusion matrix)

// run-eval.ts (lines 144-149) — exit code gate
if (accuracy < PASS_THRESHOLD) {
  console.error(`\nFAIL: accuracy ${accuracy.toFixed(2)} below threshold ${PASS_THRESHOLD}`);
  process.exit(1);
}
process.exit(0);
```

### Pattern to Follow

The `embedText()` function signature and Voyage API call from `apps/worker/src/dedup/embedding-dedup.ts`:

```ts
// embedding-dedup.ts (lines 15-37)
export async function embedText(text: string): Promise<number[]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model: 'voyage-2' }),
  });
  // ...
  return embedding; // number[], length === 1024
}
```

The cosine similarity formula from the RESEARCH doc — must be computed manually in the eval script since pgvector is not available:

```ts
// 06-RESEARCH.md — Cosine Similarity Computation
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

The dedup section follows the existing per-row table + summary block pattern already in `run-eval.ts`. `EMBEDDING_SIMILARITY_THRESHOLD` should be imported (or duplicated with the same value `0.85`) from config context — the eval script cannot import from `../apps/worker/src/config.js` directly, so inline the constant with a comment referencing its source. The env guard pattern from the existing Tier 1 section:

```ts
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
  process.exit(1);
}
```

Replicate for `VOYAGE_API_KEY` before the dedup pass:

```ts
const voyageKey = process.env.VOYAGE_API_KEY;
if (!voyageKey) {
  console.error('ERROR: VOYAGE_API_KEY environment variable is not set');
  process.exit(1);
}
```

The `LabeledPost` interface needs `cross_source_pair_id?: string` added. The dedup pass groups pairs using a `Map<string, LabeledPost[]>` keyed on `cross_source_pair_id`, filtering out entries where the field is absent.

### Data Flow

`pnpm eval` (root `package.json`) → `tsx ../../evals/run-eval.ts` → reads `evals/labeled-posts.json` → Tier 1 pass (Anthropic API) → dedup pass (Voyage API, cosine similarity) → stdout table + summary → `process.exit(0 | 1)`.

---

## File: `apps/worker/src/ingestion/source-adapter.ts`

**Role:** Defines the `RawPost` data shape and the `SourceAdapter` interface that all ingestion adapters must implement. This is the contract layer — no logic, no imports other than types.

**Changes:** JSDoc update only. Line 16 currently lists only `RedditAdapter` as an implementation. After Phase 6 migration, both `RedditAdapter` and `TheBumpAdapter` are live implementations and the JSDoc should reflect this.

**Analog:** No code analog needed — this is a JSDoc-only change. The existing comment at line 16 is the exact text to update.

### Current State

```ts
// source-adapter.ts (lines 1-20)
/**
 * A raw post fetched from an external source (Reddit, Discourse, etc.)
 * before any normalization or DB writes.
 */
export interface RawPost {
  external_id: string;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  posted_at: Date | null;
}

/**
 * Contract that every ingestion adapter must implement.
 * Implementations: RedditAdapter (apps/worker/src/ingestion/reddit-adapter.ts)
 */
export interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
```

### Pattern to Follow

The JSDoc comment on line 16 follows a single-line `Implementations:` convention. The update adds TheBumpAdapter using the same format:

```ts
/**
 * Contract that every ingestion adapter must implement.
 * Implementations: RedditAdapter (reddit-adapter.ts), TheBumpAdapter (thebump-adapter.ts)
 */
```

No imports, no exports, no logic changes. The interface itself is final.

### Data Flow

`source-adapter.ts` is imported by every adapter (`reddit-adapter.ts`, `thebump-adapter.ts`, `base-forum-adapter.ts`) and by the ingestion orchestrator (`ingest.ts`). It is the root of the adapter type hierarchy.

---

## File: `apps/worker/src/config.ts`

**Role:** Validates required env vars at module load time (fast-fail), exports all pipeline constants, model strings, pricing tables, and the `computeCost()` helper. The threshold relevant to Phase 6 is `EMBEDDING_SIMILARITY_THRESHOLD = 0.85`.

**Changes:** Possibly adjust `EMBEDDING_SIMILARITY_THRESHOLD` if empirical cross-source cosine scores from the eval extension show that 0.85 is too strict for Reddit-vs-TheBump pairs (RESEARCH Pitfall F). Any adjustment must be accompanied by a JSDoc comment documenting the empirical rationale. No other changes expected.

**Analog:** The existing constant declaration pattern in `config.ts` itself. Adjacent constants in the same file use inline comments explaining the rationale:

```ts
export const VALIDATION_CHECK_INTERVAL_DAYS = 7;    // normal recheck cycle
export const VALIDATION_RETRY_INTERVAL_HOURS = 24;  // after first failure
```

### Current State

```ts
// config.ts (line 31)
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;
```

This value is read by `findSimilarOffer()` in `embedding-dedup.ts` as a default parameter:

```ts
// embedding-dedup.ts (lines 48-52)
export async function findSimilarOffer(
  db: DbClient,
  embedding: number[],
  threshold: number = EMBEDDING_SIMILARITY_THRESHOLD,
): Promise<string | null> { ... }
```

### Pattern to Follow

If the threshold is adjusted, the update follows the same export-with-comment pattern already used for the validation constants. Any change should include a JSDoc comment explaining why the value changed (empirical cosine distribution data from the eval run). Example:

```ts
// EMBEDDING_SIMILARITY_THRESHOLD: empirically validated against cross-source Reddit+TheBump
// pairs in Phase 6 eval. Reddit conversational register embeds at 0.78-0.82 similarity
// against equivalent TheBump posts; threshold lowered from 0.85 to 0.80 to capture these.
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.80;
```

If the threshold remains unchanged after the eval run, no edit to `config.ts` is made.

### Data Flow

`config.ts` → imported by `embedding-dedup.ts` (`findSimilarOffer` default parameter) → called from `dedup/index.ts` (`runDedup`) → called from `tiers/tier2.ts`. The eval script uses the threshold as an inline constant (cannot import from `config.ts` directly due to `getEnvOrThrow` side effects running at module load).

---

## Cross-Cutting Patterns

### Named Exports Only (CLAUDE.md)

Every file in this codebase uses named exports. No default exports anywhere. The new `createAdapterForSource` function in `ingest.ts` will be module-private (not exported) since only `runIngestionCycle` calls it. If a unit test for the factory is added (RESEARCH Decision 5), it must be exported: `export function createAdapterForSource(...)`.

### Import Path Convention

All intra-package imports use `.js` extension (ESM Node resolution). Cross-package imports use `@repo/db` (pnpm workspace alias). Example from `ingest.ts`:

```ts
import type { createClient, Source } from '@repo/db';
import { createRedditAdapter } from './reddit-adapter.js';
```

The new TheBump import follows the same pattern:

```ts
import { createTheBumpAdapter } from './thebump-adapter.js';
```

### Logger Event Naming

Structured log events use `snake_case` strings. Ingestion events follow the pattern `ingestion_[noun]_[state]`:

```ts
logger.info('ingestion_cycle_start', { source_id, identifier, since });
logger.error('ingestion_fetch_error', { source_id, identifier, error });
logger.info('ingestion_cycle_complete', { source_id, identifier, total, passed, rejected });
```

No new log events are needed for Phase 6 — the factory dispatch error (unknown source type) will surface via the existing `ingestion_fetch_error` catch block (the `throw` from `createAdapterForSource` propagates to the outer `try/catch`).

### TypeScript Strict Mode

`tsconfig.json` enforces strict mode. The `Source` type from `@repo/db` must be used for `source.type` — the switch statement cases `'reddit'` and `'bump'` must match the string literal union in the `Source` type definition. Verify the `type` column in `packages/db/src/types.ts` before writing the switch cases.
