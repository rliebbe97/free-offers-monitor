# Phase 1: DB Foundation & Shared Package - Research

**Phase:** 1
**Researched:** 2026-04-20

---

## Schema SQL

Complete DDL for `packages/db/src/schema.sql`. Extensions must appear first in this exact order (vector before anything that references its type, pgmq and pg_cron after).

```sql
-- ============================================================
-- EXTENSIONS
-- Must be run once in Supabase SQL editor before applying
-- any table DDL. Order matters: vector must precede tables
-- that use the vector type; pgmq and pg_cron can follow.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL,                    -- 'reddit' | 'discourse'
  identifier     text NOT NULL UNIQUE,             -- subreddit name or base URL
  config         jsonb NOT NULL DEFAULT '{}',      -- polling config, auth config
  last_polled_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  external_id     text NOT NULL,                   -- Reddit post/comment ID
  url             text NOT NULL,
  title           text,
  body            text,
  author          text,
  posted_at       timestamptz,
  tier0_passed    boolean,                         -- null = not yet run
  tier1_result    jsonb,                           -- {decision, confidence, reason, prompt_version}
  tier2_result    jsonb,                           -- structured offer extraction
  pipeline_status text NOT NULL DEFAULT 'pending',
    -- 'pending' | 'tier0_rejected' | 'tier1_rejected' | 'tier2_done'
    -- | 'dedup_matched' | 'published' | 'review_queued' | 'error'
  error_detail    text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT posts_source_external_unique UNIQUE (source_id, external_id)
);

CREATE INDEX posts_pipeline_status_idx ON posts(pipeline_status);
CREATE INDEX posts_source_id_idx ON posts(source_id);

CREATE TABLE offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_url       text NOT NULL,
  destination_url_hash  text NOT NULL,             -- sha256 of normalized URL
  title                 text NOT NULL,
  description           text,
  brand                 text,
  category              text,                      -- 'baby_gear' | 'formula' | etc.
  offer_type            text,                      -- 'sample' | 'full_product' | etc.
  shipping_cost         numeric,                   -- must be 0 for published
  restrictions          text[],
  embedding             vector(1024),              -- Voyage AI embedding (voyage-2)
  status                text NOT NULL DEFAULT 'active',
    -- 'active' | 'expired' | 'unverified' | 'review_pending'
  last_verified_at      timestamptz,
  next_check_at         timestamptz,
  extraction_confidence numeric,                   -- Tier 2 confidence score
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Hash lookup for URL dedup (O(1) exact match)
CREATE INDEX offers_url_hash_idx ON offers(destination_url_hash);

-- ANN search for semantic dedup (cosine similarity >= 0.85)
-- lists=100 is correct for <50k vectors; tune with sqrt(row_count) at scale
-- IMPORTANT: run ANALYZE offers after bulk insert or index will have poor recall
CREATE INDEX offers_embedding_ivfflat_idx
  ON offers USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Validation cron query — only active offers with a due check
CREATE INDEX offers_next_check_active_idx
  ON offers(next_check_at)
  WHERE status = 'active';

CREATE TABLE post_offers (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  offer_id   uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (post_id, offer_id)
);

CREATE INDEX post_offers_offer_id_idx ON post_offers(offer_id);

CREATE TABLE verification_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id     uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  http_status  integer,
  is_live      boolean NOT NULL,
  dead_signals text[],                             -- detected expiry phrases
  raw_response text                                -- truncated page text for debug
);

CREATE INDEX verification_log_offer_id_idx ON verification_log(offer_id);

CREATE TABLE human_review_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES posts(id),
  tier2_result jsonb NOT NULL,
  confidence   numeric NOT NULL,
  reviewer_id  uuid,                               -- Supabase auth uid
  decision     text,                               -- 'approved' | 'rejected'
  review_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz
);

CREATE INDEX human_review_queue_unreviewed_idx
  ON human_review_queue(created_at)
  WHERE decision IS NULL;

CREATE TABLE ai_calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid REFERENCES posts(id),
  tier             integer NOT NULL,               -- 1 or 2
  model            text NOT NULL,                  -- full dated model string
  prompt_version   text NOT NULL,                  -- git commit hash of prompt file
  input_tokens     integer NOT NULL,
  output_tokens    integer NOT NULL,
  cost_usd         numeric(10,6) NOT NULL,
  latency_ms       integer NOT NULL,
  request_payload  jsonb,                          -- truncated for cost analysis
  response_payload jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_calls_post_id_idx ON ai_calls(post_id);
CREATE INDEX ai_calls_tier_idx ON ai_calls(tier);
CREATE INDEX ai_calls_created_at_idx ON ai_calls(created_at DESC);

-- ============================================================
-- QUEUES
-- ============================================================
-- Run after tables are created.
-- pgmq.create() is idempotent in recent versions, but
-- wrapping in a DO block guards against older behavior.

SELECT pgmq.create('tier1_queue');
SELECT pgmq.create('tier2_queue');
```

---

## Extension Setup

### Required order

Extensions must be created in this exact sequence in the Supabase SQL editor before running any table DDL:

```sql
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector — must come first
CREATE EXTENSION IF NOT EXISTS pgmq;      -- Postgres-native queue
CREATE EXTENSION IF NOT EXISTS pg_cron;   -- scheduled validation jobs
```

`vector` must precede all other statements because the `offers.embedding` column depends on the `vector` type existing. If the type is missing, every DDL statement that references it will fail.

### Worker startup verification query

The worker must assert all three extensions are present before starting any consumers. If any are missing, throw a descriptive error immediately rather than failing cryptically during processing:

```typescript
// In apps/worker/src/index.ts — call before starting consumers
export async function assertExtensions(db: SupabaseClient): Promise<void> {
  const { data, error } = await db
    .from('pg_extension')
    .select('extname')
    .in('extname', ['vector', 'pgmq', 'pg_cron']);

  if (error) throw new Error(`Extension check failed: ${error.message}`);

  const found = new Set((data ?? []).map((r: { extname: string }) => r.extname));
  const missing = ['vector', 'pgmq', 'pg_cron'].filter(ext => !found.has(ext));

  if (missing.length > 0) {
    throw new Error(
      `Required Postgres extensions not installed: ${missing.join(', ')}. ` +
      `Run CREATE EXTENSION IF NOT EXISTS <name> in the Supabase SQL editor.`
    );
  }
}
```

Note: Supabase JS client may not expose `pg_extension` via the standard table API since it is a system catalog. An alternative is a raw RPC call:

```typescript
const { data } = await db.rpc('check_extensions'); // or use raw SQL via a helper function
```

The simplest reliable approach is a small Postgres function deployed in schema.sql:

```sql
CREATE OR REPLACE FUNCTION check_required_extensions()
RETURNS TABLE(extname text, installed boolean)
LANGUAGE sql
AS $$
  SELECT e.extname, TRUE
  FROM pg_extension e
  WHERE e.extname IN ('vector', 'pgmq', 'pg_cron');
$$;
```

Then call it via `db.rpc('check_required_extensions')` at worker startup.

---

## Queue Setup

### Queue creation SQL

```sql
SELECT pgmq.create('tier1_queue');
SELECT pgmq.create('tier2_queue');
```

These are idempotent in recent pgmq versions. Include in `schema.sql` after table definitions.

### Visibility timeouts

Visibility timeout is set at read time (per message batch), not at queue creation time. The architecture specifies:

- `tier1_queue`: vt = 30s (Haiku calls are fast)
- `tier2_queue`: vt = 60s (Sonnet calls take longer; the PITFALLS doc recommends 120s for Sonnet under load — use 120s to be safe)

```typescript
// Tier 1 consumer read
const { data } = await db.rpc('pgmq_read', {
  queue_name: 'tier1_queue',
  vt: 30,
  qty: 5,
});

// Tier 2 consumer read
const { data } = await db.rpc('pgmq_read', {
  queue_name: 'tier2_queue',
  vt: 120,   // 120s: safer for Sonnet under network contention
  qty: 5,
});
```

### pgmq function name note

The Supabase JS client calls pgmq functions via `.rpc()`. The function names exposed may be either `pgmq.read` / `pgmq.archive` (called via raw SQL) or `pgmq_read` / `pgmq_archive` (as RPC-callable wrappers). Verify on the actual Supabase project by running `\df pgmq*` in the SQL editor and use whatever form is available. The schema.sql consumer pattern examples use the `pgmq.` schema-qualified form which works directly in SQL.

---

## Type Generation

### Supabase CLI command

```bash
npx supabase gen types typescript \
  --project-id <PROJECT_ID> \
  --schema public \
  > packages/db/src/types.ts
```

`<PROJECT_ID>` is the Supabase project reference (found in Project Settings → General).

### pnpm script

Add to the **root** `package.json` scripts (the root already has a placeholder `db:generate` intent per CONTEXT.md):

```json
"db:generate": "npx supabase gen types typescript --project-id $SUPABASE_PROJECT_ID --schema public > packages/db/src/types.ts"
```

The `SUPABASE_PROJECT_ID` can be loaded from `.env.local` using `--env-file .env.local` in Node 22, or simply hardcoded in the script for local dev since project IDs are not secrets.

### Commit generated types

Per D-04, `packages/db/src/types.ts` is committed to git. This means downstream packages (dashboard, worker) can build without Supabase CLI access. The types must be regenerated and recommitted whenever the schema changes.

### Initial placeholder types

Until the CLI is wired and the schema is deployed, a minimal hand-written `types.ts` is needed to unblock `@repo/db` builds. At minimum:

```typescript
// packages/db/src/types.ts
// Generated by: pnpm db:generate
// DO NOT EDIT MANUALLY — regenerate with pnpm db:generate

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      sources: { Row: Source; Insert: SourceInsert; Update: Partial<SourceInsert> };
      posts: { Row: Post; Insert: PostInsert; Update: Partial<PostInsert> };
      offers: { Row: Offer; Insert: OfferInsert; Update: Partial<OfferInsert> };
      post_offers: { Row: PostOffer; Insert: PostOfferInsert; Update: Partial<PostOfferInsert> };
      verification_log: { Row: VerificationLog; Insert: VerificationLogInsert; Update: Partial<VerificationLogInsert> };
      human_review_queue: { Row: HumanReviewItem; Insert: HumanReviewItemInsert; Update: Partial<HumanReviewItemInsert> };
      ai_calls: { Row: AiCall; Insert: AiCallInsert; Update: Partial<AiCallInsert> };
    };
  };
}
```

The actual Supabase CLI output is more verbose; replace the stub once schema is deployed and CLI is run.

---

## Client Pattern

### `packages/db/src/client.ts`

Per D-05 and D-06: no singleton, fresh client per call, service role key for both worker and dashboard server-side.

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
      persistSession: false,     // server-side: no session storage needed
      autoRefreshToken: false,   // service role key doesn't expire
    },
  });
}
```

### `packages/db/src/index.ts`

```typescript
export { createClient } from './client.js';
export type { Database, Source, Post, Offer, PostOffer, VerificationLog, HumanReviewItem, AiCall } from './types.js';
```

### Usage in worker

```typescript
import { createClient } from '@repo/db';

const db = createClient();  // called once at startup, reused across calls
```

The CONTEXT.md says "no singleton" for testability, but in practice the worker creates one client at startup and passes it into functions. The key point is that `createClient()` is not a module-level side effect — it's called explicitly, making it mockable in tests.

### Browser client for dashboard (future)

The dashboard will also need a browser client using the anon key (for Supabase Auth). This is not in scope for Phase 1 but a `createBrowserClient()` export can be added to `client.ts` in Phase 4:

```typescript
// Phase 4 addition — do not implement in Phase 1
import { createBrowserClient as createSupabaseBrowserClient } from '@supabase/ssr';

export function createBrowserClient() {
  return createSupabaseBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

---

## Dependencies

### `packages/db/package.json` additions needed

The current `packages/db/package.json` has no runtime dependencies — only `devDependencies`. Add:

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.104.0"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "tsup": "^8.5.0",
    "typescript": "^5"
  }
}
```

`@supabase/supabase-js` is the only runtime dependency needed for Phase 1. The `@supabase/ssr` package (`0.10.2`) is needed in Phase 4 for the dashboard browser client but not here.

### Root-level additions (optional convenience)

The `supabase` CLI is a dev tool, not a package dep. Install globally or use `npx`:
```bash
npx supabase@latest gen types typescript ...
```

No changes needed to the root `package.json` for Phase 1 beyond the `db:generate` script.

---

## Pitfalls

### Extension order (critical)

`CREATE EXTENSION IF NOT EXISTS vector` must run before any DDL that references the `vector` type. If pgmq or pg_cron are created first without vector, the table creation will fail with `ERROR: type "vector" does not exist`. The schema.sql preamble always puts vector first.

### pgmq queue creation timing

`SELECT pgmq.create(...)` must run after the pgmq extension is enabled. If the schema.sql is applied before the extension, this call will fail with `ERROR: function pgmq.create(unknown) does not exist`. The `IF NOT EXISTS` guard on the extension prevents this as long as the extension was installed first.

### ivfflat requires data before it is useful

The ivfflat index on `offers.embedding` is created empty. It will produce correct (but slow, sequential-scan-equivalent) results until enough rows exist. For v1 with < 1000 offers, this is fine. Run `ANALYZE offers` after the first bulk insert of embeddings to update planner statistics.

### pgmq archive is mandatory

Messages not archived after processing re-deliver after the visibility timeout. This is the single most common pgmq mistake. The archive call must be in a `finally` block — this is enforced in Phase 2, but the schema.sql comment should document it.

### Tier 2 visibility timeout

The CONTEXT.md says 60s for tier2_queue, but PITFALLS.md (section 2.2) recommends 120s because Sonnet calls can take 8–15 seconds and a network hiccup can push processing past 60s. Use 120s in the consumer read call — the queue creation itself has no timeout setting.

### `@supabase/supabase-js` ESM compatibility

The package is published as both CJS and ESM. Since `packages/db/package.json` has `"type": "module"`, imports must use the ESM path. The `@supabase/supabase-js` v2 package handles this correctly with its exports map. No special configuration needed, but tsup must be configured to output ESM (already set: `--format esm`).

### Generated types must be kept in sync

If `schema.sql` changes and `pnpm db:generate` is not re-run, TypeScript types will diverge from the actual DB schema. This causes silent runtime failures (inserting fields that don't exist, missing required fields). Add a note in the schema.sql header to always run `pnpm db:generate` after schema changes.

### No seed data for sources in schema.sql

The sources table stores subreddit configurations. Do not embed seed data in schema.sql — subreddit config is operational data, not schema. It will be inserted by the worker's startup configuration in Phase 2.

---

*Phase: 01-db-foundation-shared-package*
*Research written: 2026-04-20*
