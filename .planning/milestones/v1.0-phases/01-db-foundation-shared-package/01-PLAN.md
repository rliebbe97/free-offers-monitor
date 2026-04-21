---
phase: 1
plan: 1
name: "DB Setup"
wave: 1
depends_on: []
files_modified:
  - packages/db/src/schema.sql
  - packages/db/src/types.ts
  - packages/db/src/client.ts
  - packages/db/src/index.ts
  - packages/db/package.json
  - package.json
requirements: [DB-01, DB-02, DB-03, DB-04]
autonomous: true
---

# Plan 01-01: DB Setup

<objective>
Enable pgvector, pgmq, and pg_cron extensions in Supabase. Deploy full schema with all 7 tables and prescribed indexes. Create pgmq queues. Export typed createClient() factory from @repo/db. Wire up pnpm db:generate for type regeneration.
</objective>

<context>
Key decisions from CONTEXT.md and RESEARCH.md that affect implementation:

- **D-01:** Schema lives as raw SQL in `packages/db/src/schema.sql`, applied directly via Supabase SQL editor or CLI. No ORM, no migration tool.
- **D-02:** All 7 tables with prescribed indexes from architecture research.
- **D-03:** Types generated via Supabase CLI and committed to git so downstream packages build without CLI access.
- **D-04:** Generated types committed to git (placeholder until first real generation).
- **D-05:** `createClient()` is a factory (not a singleton) reading `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from env. Fresh client per call for testability.
- **D-07:** Two pgmq queues: `tier1_queue` and `tier2_queue`. Visibility timeouts are set at read time, not creation time.
- **D-08:** Queue creation SQL included in schema.sql after table definitions.

Pitfalls:
- Extension order is critical: `vector` must precede any DDL referencing the `vector` type.
- pgmq queue creation must run after the pgmq extension is enabled.
- ivfflat index is created empty; run `ANALYZE offers` after first bulk insert.
- The `@supabase/supabase-js` package is ESM-compatible; `packages/db` has `"type": "module"` so imports use ESM paths automatically.
- The env var for the service key is `SUPABASE_SERVICE_ROLE_KEY` (standard Supabase convention), not `SUPABASE_SERVICE_KEY`.
</context>

<tasks>

## Task 1: Create schema.sql with extensions, tables, indexes, and queues

<read_first>
- .planning/phases/01-db-foundation-shared-package/01-RESEARCH.md (complete DDL in "Schema SQL" section)
- .planning/research/ARCHITECTURE.md (schema design reference)
- .planning/research/PITFALLS.md (extension order, pgmq archive, ivfflat probes)
- CLAUDE.md (DB table list, index requirements, gotchas)
</read_first>

<action>
Create `packages/db/src/schema.sql` with the complete DDL from the RESEARCH.md "Schema SQL" section. The file must contain:

1. **Header comment** noting this is the canonical schema and that `pnpm db:generate` must be re-run after any changes.

2. **Extension setup** (order matters — vector first):
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pgmq;
   CREATE EXTENSION IF NOT EXISTS pg_cron;
   ```

3. **All 7 tables** with full column definitions per the research DDL:
   - `sources` — id (uuid PK), type (text NOT NULL), identifier (text NOT NULL UNIQUE), config (jsonb), last_polled_at (timestamptz), created_at (timestamptz)
   - `posts` — id (uuid PK), source_id (uuid FK→sources), external_id (text), url (text), title (text), body (text), author (text), posted_at (timestamptz), tier0_passed (boolean nullable), tier1_result (jsonb), tier2_result (jsonb), pipeline_status (text, default 'pending'), error_detail (text), created_at (timestamptz). UNIQUE constraint on (source_id, external_id).
   - `offers` — id (uuid PK), destination_url (text), destination_url_hash (text), title (text), description (text), brand (text), category (text), offer_type (text), shipping_cost (numeric), restrictions (text[]), embedding (vector(1024)), status (text, default 'active'), last_verified_at (timestamptz), next_check_at (timestamptz), extraction_confidence (numeric), created_at (timestamptz), updated_at (timestamptz)
   - `post_offers` — post_id (uuid FK→posts), offer_id (uuid FK→offers), created_at (timestamptz). PK(post_id, offer_id). ON DELETE CASCADE on both FKs.
   - `verification_log` — id (uuid PK), offer_id (uuid FK→offers ON DELETE CASCADE), checked_at (timestamptz), http_status (integer), is_live (boolean), dead_signals (text[]), raw_response (text)
   - `human_review_queue` — id (uuid PK), post_id (uuid FK→posts), tier2_result (jsonb), confidence (numeric), reviewer_id (uuid), decision (text), review_note (text), created_at (timestamptz), reviewed_at (timestamptz)
   - `ai_calls` — id (uuid PK), post_id (uuid FK→posts), tier (integer), model (text), prompt_version (text), input_tokens (integer), output_tokens (integer), cost_usd (numeric(10,6)), latency_ms (integer), request_payload (jsonb), response_payload (jsonb), error (text), created_at (timestamptz)

4. **Indexes** per research DDL:
   - `posts_pipeline_status_idx` on posts(pipeline_status)
   - `posts_source_id_idx` on posts(source_id)
   - `offers_url_hash_idx` on offers(destination_url_hash)
   - `offers_embedding_ivfflat_idx` USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
   - `offers_next_check_active_idx` on offers(next_check_at) WHERE status = 'active'
   - `post_offers_offer_id_idx` on post_offers(offer_id)
   - `verification_log_offer_id_idx` on verification_log(offer_id)
   - `human_review_queue_unreviewed_idx` on human_review_queue(created_at) WHERE decision IS NULL
   - `ai_calls_post_id_idx` on ai_calls(post_id)
   - `ai_calls_tier_idx` on ai_calls(tier)
   - `ai_calls_created_at_idx` on ai_calls(created_at DESC)

5. **Extension verification function**:
   ```sql
   CREATE OR REPLACE FUNCTION check_required_extensions()
   RETURNS TABLE(extname text, installed boolean)
   LANGUAGE sql
   AS $$
     SELECT e.extname::text, TRUE
     FROM pg_extension e
     WHERE e.extname IN ('vector', 'pgmq', 'pg_cron');
   $$;
   ```

6. **pgmq queue creation** (after all table DDL):
   ```sql
   SELECT pgmq.create('tier1_queue');
   SELECT pgmq.create('tier2_queue');
   ```
</action>

<acceptance_criteria>
- packages/db/src/schema.sql exists and is valid SQL
- File contains CREATE EXTENSION IF NOT EXISTS for vector, pgmq, pg_cron (in that order, vector first)
- File contains CREATE TABLE for all 7 tables: sources, posts, offers, post_offers, verification_log, human_review_queue, ai_calls
- posts table has UNIQUE constraint on (source_id, external_id)
- offers table has INDEX on destination_url_hash
- offers table has column "embedding vector(1024)"
- offers table has ivfflat index using vector_cosine_ops with lists = 100
- offers table has partial INDEX on next_check_at WHERE status = 'active'
- human_review_queue has partial INDEX on created_at WHERE decision IS NULL
- ai_calls table has indexes on post_id, tier, and created_at DESC
- File contains check_required_extensions() function
- File contains pgmq.create('tier1_queue') and pgmq.create('tier2_queue')
- Header comment warns to run pnpm db:generate after schema changes
- No seed data for the sources table (operational data, not schema)
</acceptance_criteria>

## Task 2: Create placeholder types.ts with Database type

<read_first>
- .planning/phases/01-db-foundation-shared-package/01-RESEARCH.md ("Type Generation" and "Initial placeholder types" sections)
- packages/db/tsconfig.json (verify strict mode config)
- CLAUDE.md (code style: named exports, no default exports, strict TypeScript, no `any`)
</read_first>

<action>
Create `packages/db/src/types.ts` with a placeholder Database interface that:

1. Starts with a header comment noting it is generated by `pnpm db:generate` and should not be edited manually.

2. Defines a `Json` utility type used by Supabase:
   ```typescript
   export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
   ```

3. Defines the `Database` interface with `public.Tables` containing all 7 tables. Each table entry must have `Row`, `Insert`, and `Update` subtypes. Use the column types from the schema DDL:
   - `sources`: Row type with id (string), type (string), identifier (string), config (Json), last_polled_at (string | null), created_at (string)
   - `posts`: Row type with all columns from schema, JSONB columns typed as Json | null
   - `offers`: Row type with all columns, embedding as string | null (pgvector serializes as string)
   - `post_offers`: Row type with post_id, offer_id, created_at
   - `verification_log`: Row type with all columns
   - `human_review_queue`: Row type with all columns
   - `ai_calls`: Row type with all columns

4. Export convenience type aliases for each table's Row type:
   ```typescript
   export type Source = Database['public']['Tables']['sources']['Row'];
   export type Post = Database['public']['Tables']['posts']['Row'];
   export type Offer = Database['public']['Tables']['offers']['Row'];
   export type PostOffer = Database['public']['Tables']['post_offers']['Row'];
   export type VerificationLog = Database['public']['Tables']['verification_log']['Row'];
   export type HumanReviewItem = Database['public']['Tables']['human_review_queue']['Row'];
   export type AiCall = Database['public']['Tables']['ai_calls']['Row'];
   ```

These are placeholder types that will be overwritten when `pnpm db:generate` runs against the live schema. They must be close enough to avoid type errors in downstream code during development.
</action>

<acceptance_criteria>
- packages/db/src/types.ts exists
- File has header comment stating it is generated and should not be edited manually
- Database interface is exported as a named export (not default)
- Database.public.Tables contains entries for all 7 tables
- Each table has Row, Insert, and Update subtypes
- Convenience type aliases exported for Source, Post, Offer, PostOffer, VerificationLog, HumanReviewItem, AiCall
- No use of `any` type — use `Json` or `unknown` as appropriate
- File compiles under strict TypeScript
</acceptance_criteria>

## Task 3: Create Supabase client factory

<read_first>
- .planning/phases/01-db-foundation-shared-package/01-RESEARCH.md ("Client Pattern" section — exact code)
- packages/db/package.json (current dependencies, verify "type": "module")
- packages/db/tsconfig.json (verify module resolution)
- CLAUDE.md (code style: named exports, no default exports, strict TypeScript)
</read_first>

<action>
1. Create `packages/db/src/client.ts` following the research client pattern exactly:
   ```typescript
   import { createClient as createSupabaseClient } from '@supabase/supabase-js';
   import type { Database } from './types.js';

   export function createClient() {
     const url = process.env.SUPABASE_URL;
     const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

     if (!url) throw new Error('SUPABASE_URL environment variable is not set');
     if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is not set');

     return createSupabaseClient<Database>(url, key, {
       auth: {
         persistSession: false,
         autoRefreshToken: false,
       },
     });
   }
   ```

   Key details:
   - Import uses `.js` extension (required for ESM with TypeScript)
   - `createClient` is renamed from `createSupabaseClient` to avoid name collision with our export
   - Env var names: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   - Throws descriptive errors if either env var is missing
   - `persistSession: false` (server-side, no session storage)
   - `autoRefreshToken: false` (service role key does not expire)
   - Named export only, no default export
</action>

<acceptance_criteria>
- packages/db/src/client.ts exists with named export `createClient`
- Imports `createClient` from `@supabase/supabase-js` (renamed to avoid collision)
- Imports `Database` type from `./types.js` (with .js extension for ESM)
- Returns `SupabaseClient<Database>` (typed with our Database interface)
- Throws descriptive error if `SUPABASE_URL` is missing
- Throws descriptive error if `SUPABASE_SERVICE_ROLE_KEY` is missing
- Passes `persistSession: false` in auth options
- Passes `autoRefreshToken: false` in auth options
- No default export
- No use of `any` type
</acceptance_criteria>

## Task 4: Update index.ts to re-export public API

<read_first>
- packages/db/src/index.ts (current placeholder with commented-out exports)
- .planning/phases/01-db-foundation-shared-package/01-RESEARCH.md ("Client Pattern" → index.ts section)
- CLAUDE.md (code style: named exports only)
</read_first>

<action>
Replace the contents of `packages/db/src/index.ts` with:

```typescript
export { createClient } from './client.js';
export type {
  Database,
  Json,
  Source,
  Post,
  Offer,
  PostOffer,
  VerificationLog,
  HumanReviewItem,
  AiCall,
} from './types.js';
```

Key details:
- Re-exports `createClient` function from client module
- Re-exports `Database` interface and all convenience type aliases from types module
- Uses `.js` extensions for ESM compatibility
- Uses `export type` for type-only re-exports (TypeScript isolatedModules compliance)
- Named exports only, no default export
</action>

<acceptance_criteria>
- packages/db/src/index.ts re-exports `createClient` from `./client.js`
- Re-exports `Database` and all 7 convenience types from `./types.js`
- Uses `export type` for type-only exports
- Uses `.js` extensions in import paths
- No default exports
- No commented-out code remaining
</acceptance_criteria>

## Task 5: Update package.json files with dependencies and scripts

<read_first>
- packages/db/package.json (current state — no runtime deps, only devDeps)
- package.json (root — current scripts, no db:generate yet)
- .planning/phases/01-db-foundation-shared-package/01-RESEARCH.md ("Dependencies" and "Type Generation" sections)
- .planning/research/STACK.md (Supabase JS version)
</read_first>

<action>
1. Update `packages/db/package.json`:
   - Add `@supabase/supabase-js` to `dependencies` (not devDependencies):
     ```json
     "dependencies": {
       "@supabase/supabase-js": "^2.104.0"
     }
     ```
   - Add `db:generate` script:
     ```json
     "db:generate": "npx supabase gen types typescript --project-id \"$SUPABASE_PROJECT_ID\" --schema public > src/types.ts"
     ```

2. Update root `package.json`:
   - Add `db:generate` script:
     ```json
     "db:generate": "pnpm --filter @repo/db db:generate"
     ```
</action>

<acceptance_criteria>
- packages/db/package.json has `@supabase/supabase-js` in `dependencies` (not devDependencies)
- packages/db/package.json has `db:generate` script that calls supabase CLI
- Root package.json has `db:generate` script that filters to `@repo/db`
- `pnpm install` resolves the new dependency without errors
- No other existing scripts or dependencies are removed or altered
</acceptance_criteria>

</tasks>

<verification>
After all tasks complete, run these checks in order:

1. `pnpm install` succeeds — new `@supabase/supabase-js` dependency resolves without errors
2. `pnpm build --filter @repo/db` succeeds — TypeScript compiles with tsup, produces `dist/index.js` and `dist/index.d.ts`
3. `pnpm build` succeeds — full monorepo build passes, including any packages that depend on `@repo/db`
4. Verify `packages/db/dist/index.js` exports `createClient` (inspect output or import check)
5. Verify `packages/db/src/schema.sql` is present and contains all 7 CREATE TABLE statements plus 3 CREATE EXTENSION statements
6. `pnpm check-types --filter @repo/db` passes — no type errors in the db package
</verification>

<rollback>
If build fails after changes:
1. Check that `types.ts` Database interface matches what `@supabase/supabase-js` expects (public.Tables structure)
2. Check `.js` extensions in all import paths (ESM requirement)
3. Check tsup output format is ESM (already configured in package.json build script)
4. If `@supabase/supabase-js` version has breaking changes, pin to exact version that works
</rollback>

<must_haves>
- [ ] All 3 Postgres extensions referenced in schema.sql (pgvector, pgmq, pg_cron) — covers DB-01
- [ ] All 7 tables created with correct columns, constraints, and indexes — covers DB-02
- [ ] check_required_extensions() function for worker startup verification — covers DB-01
- [ ] pgmq queues created (tier1_queue, tier2_queue) — covers DB-04
- [ ] Typed createClient() factory exported from @repo/db — covers DB-03
- [ ] Database type and convenience type aliases exported from @repo/db — covers DB-03
- [ ] pnpm db:generate script wired up at root and package level — covers DB-03
- [ ] Full monorepo build passes with no type errors
- [ ] No default exports anywhere (CLAUDE.md rule)
- [ ] No use of `any` type (CLAUDE.md rule)
- [ ] 2-space indentation, semicolons (CLAUDE.md rule)
</must_haves>
