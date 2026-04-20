# Architecture Research: Free Offers Monitor

*Researched: 2026-04-20*

---

## 1. Component Boundaries

### `apps/worker` — Long-running Node.js service (Railway)

The worker owns the entire pipeline. It is the only component that writes to `posts`, `offers`, `post_offers`, `ai_calls`, `human_review_queue`, and `verification_log`. It never exposes HTTP endpoints in production — it drives itself via polling loops and pgmq consumers.

**Responsibilities:**
- Ingestion adapters (Reddit via snoowrap, future Discourse)
- Tier 0 inline keyword filter
- Tier 1 pgmq consumer — Haiku binary classifier
- Tier 2 pgmq consumer — Sonnet structured extractor
- Dedup logic (URL hash lookup, Voyage embedding cosine check)
- Validation cron handler (URL liveness, dead signal scan)
- Logging all AI calls to `ai_calls` table
- Routing low-confidence Tier 2 results to `human_review_queue`

**Does NOT own:**
- Auth, sessions, or dashboard rendering
- Reading from `human_review_queue` to approve/reject (that's dashboard territory)
- Serving any external HTTP traffic

**Internal module layout (to be built):**
```
apps/worker/src/
  ingestion/         # SourceAdapter implementations
  tiers/             # tier0.ts, tier1.ts, tier2.ts
  dedup/             # url-hash.ts, embedding-dedup.ts
  queue/             # pgmq consumer/producer wrappers
  validation/        # recheck cron handler
  index.ts           # bootstrap: start consumers + ingestion loop
```

### `apps/dashboard` — Next.js 14 App Router (Vercel)

Read-heavy UI. Reads from `offers`, `posts`, `human_review_queue`, `ai_calls`, `sources`. Only writes back for human review actions (approve/reject queue items) and keyword suggestions.

**Responsibilities:**
- Supabase Auth gate (email allowlist)
- Offer list with status, source link, last verified date
- Human review queue: display flagged Tier 2 items, accept/reject
- AI call log viewer (cost, latency, prompt version)
- Keyword suggestion surface (does NOT auto-apply — human decides)

**Does NOT own:**
- Any pipeline logic
- Direct Voyage or Anthropic API calls
- pgmq producers/consumers

**Internal layout:**
```
apps/dashboard/
  app/
    (auth)/         # login page
    offers/         # offer list + detail
    review/         # human review queue
    ai-calls/       # cost/latency log
  components/
  lib/
    supabase.ts     # browser + server client helpers
```

### `packages/db` — Shared types, schema, client (`@repo/db`)

Single source of truth for database types and the Supabase client factory. Both `worker` and `dashboard` import from here.

**Responsibilities:**
- `schema.sql` — canonical DDL (tables, indexes, extensions)
- `types.ts` — TypeScript types generated from Supabase schema (or hand-written until codegen is wired)
- `client.ts` — exports `createClient()` for server-side use and `createBrowserClient()` for dashboard
- Re-exports: `Database`, `Post`, `Offer`, `Source`, `AiCall`, `HumanReviewItem`

**Rule:** No application logic here. Pure data layer.

---

## 2. Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WORKER (Railway)                               │
│                                                                             │
│  ┌──────────────┐    ┌─────────────────────────────────────────────────┐   │
│  │  Ingestion   │    │                   Pipeline                       │   │
│  │  loop        │    │                                                  │   │
│  │  (snoowrap)  │    │  ┌──────────┐   ┌──────────┐   ┌────────────┐  │   │
│  │              │───▶│  │  Tier 0  │──▶│  Tier 1  │──▶│   Tier 2   │  │   │
│  │  polls every │    │  │ keyword  │   │  Haiku   │   │   Sonnet   │  │   │
│  │  ~5 min      │    │  │ filter   │   │ classify │   │  extract   │  │   │
│  └──────┬───────┘    │  └────┬─────┘   └────┬─────┘   └─────┬──────┘  │   │
│         │            │       │ fail          │ fail          │          │   │
│         │            │       │               │               │          │   │
│         │            │       ▼               ▼               ▼          │   │
│         │            │  rejected        rejected        confidence      │   │
│         │            │  (stored)        (stored)        < 0.7 →        │   │
│         │            │                                human_review_     │   │
│         │            │                                queue            │   │
│         │            └──────────────────────────────────────────────┘  │   │
│         │                                                    │          │   │
│         ▼                                                    ▼          │   │
│  ┌─────────────┐                                    ┌──────────────┐   │   │
│  │   posts     │                                    │    Dedup     │   │   │
│  │   table     │                                    │ URL hash +   │   │   │
│  │  (Supabase) │                                    │ Voyage embed │   │   │
│  └─────────────┘                                    └──────┬───────┘   │   │
│                                                             │           │   │
│                                              match ◄────────┴────► new  │   │
│                                                │                    │   │   │
│                                                ▼                    ▼   │   │
│                                         link to existing       offers   │   │
│                                         offer via              table    │   │
│                                         post_offers                     │   │
│                                                                         │   │
│  ┌──────────────────────────────────────────────────────────────────┐  │   │
│  │  Validation cron (pg_cron daily + per-offer weekly)              │  │   │
│  │  → fetches URL → checks liveness → checks dead signals          │  │   │
│  │  → updates offers.status + verification_log                     │  │   │
│  └──────────────────────────────────────────────────────────────────┘  │   │
└─────────────────────────────────────────────────────────────────────────────┘

Queue flow (pgmq):
  Tier 0 pass  →  enqueue tier1_queue
  Tier 1 pass  →  enqueue tier2_queue
  Tier 2 done  →  archive message (prevents re-delivery)

┌─────────────────────────────────────────────────────────┐
│                  DASHBOARD (Vercel)                     │
│                                                         │
│  Supabase Auth → reads offers, posts, human_review_     │
│  queue, ai_calls → human reviewer approves/rejects     │
│  flagged items                                          │
└─────────────────────────────────────────────────────────┘
```

### Queue message lifecycle

```
enqueue(tier1_queue, { post_id })
  └─▶ consumer reads message (visibility_timeout = 30s)
        ├─ success → archive(msg_id)          ← must be explicit
        ├─ soft fail → nack / let timeout     ← re-delivers up to max_delivery_count
        └─ hard fail → archive + write error  ← log to ai_calls, mark post failed
```

---

## 3. Database Schema

### Extensions (one-time setup)
```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector (1024-dim embeddings)
CREATE EXTENSION IF NOT EXISTS pgmq;       -- Postgres-native queue
CREATE EXTENSION IF NOT EXISTS pg_cron;    -- scheduled validation jobs
```

### Tables

#### `sources`
Tracks ingestion sources (subreddits, Discourse instances).
```sql
CREATE TABLE sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,                   -- 'reddit' | 'discourse'
  identifier    text NOT NULL UNIQUE,            -- subreddit name or base URL
  config        jsonb NOT NULL DEFAULT '{}',     -- polling config, auth config
  last_polled_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

#### `posts`
Raw scraped content. One row per unique post/comment from a source.
```sql
CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  external_id     text NOT NULL,                 -- Reddit post/comment ID
  url             text NOT NULL,
  title           text,
  body            text,
  author          text,
  posted_at       timestamptz,
  tier0_passed    boolean,                       -- null = not yet run
  tier1_result    jsonb,                         -- {decision, confidence, reason, prompt_version}
  tier2_result    jsonb,                         -- structured offer extraction
  pipeline_status text NOT NULL DEFAULT 'pending',
    -- 'pending' | 'tier0_rejected' | 'tier1_rejected' | 'tier2_done'
    -- | 'dedup_matched' | 'published' | 'review_queued' | 'error'
  error_detail    text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT posts_source_external_unique UNIQUE (source_id, external_id)
);

CREATE INDEX posts_pipeline_status_idx ON posts(pipeline_status);
CREATE INDEX posts_source_id_idx ON posts(source_id);
```

#### `offers`
Deduplicated, validated free offers. Populated by Tier 2 + dedup.
```sql
CREATE TABLE offers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_url      text NOT NULL,
  destination_url_hash text NOT NULL,            -- sha256 of normalized URL
  title                text NOT NULL,
  description          text,
  brand                text,
  category             text,                     -- 'baby_gear' | 'formula' | etc.
  offer_type           text,                     -- 'sample' | 'full_product' | etc.
  shipping_cost        numeric,                  -- must be 0 for published
  restrictions         text[],
  embedding            vector(1024),             -- Voyage AI embedding
  status               text NOT NULL DEFAULT 'active',
    -- 'active' | 'expired' | 'unverified' | 'review_pending'
  last_verified_at     timestamptz,
  next_check_at        timestamptz,
  extraction_confidence numeric,                 -- Tier 2 confidence score
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Hash lookup for URL dedup (O(1) exact match)
CREATE INDEX offers_url_hash_idx ON offers(destination_url_hash);

-- ANN search for semantic dedup (cosine similarity ≥ 0.85)
-- lists=100 is a reasonable starting point; tune after data volume grows
CREATE INDEX offers_embedding_ivfflat_idx
  ON offers USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Validation cron query — only active offers with due check
CREATE INDEX offers_next_check_active_idx
  ON offers(next_check_at)
  WHERE status = 'active';
```

#### `post_offers` (join table)
Many posts can map to one offer (duplicates share an offer).
```sql
CREATE TABLE post_offers (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  offer_id   uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (post_id, offer_id)
);

CREATE INDEX post_offers_offer_id_idx ON post_offers(offer_id);
```

#### `verification_log`
Audit trail for every validation check.
```sql
CREATE TABLE verification_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id     uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  http_status  integer,
  is_live      boolean NOT NULL,
  dead_signals text[],                           -- detected expiry phrases
  raw_response text                              -- truncated page text for debug
);

CREATE INDEX verification_log_offer_id_idx ON verification_log(offer_id);
```

#### `human_review_queue`
Holds Tier 2 extractions with confidence < 0.7.
```sql
CREATE TABLE human_review_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES posts(id),
  tier2_result    jsonb NOT NULL,
  confidence      numeric NOT NULL,
  reviewer_id     uuid,                          -- Supabase auth uid
  decision        text,                          -- 'approved' | 'rejected'
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz
);

CREATE INDEX human_review_queue_unreviewed_idx
  ON human_review_queue(created_at)
  WHERE decision IS NULL;
```

#### `ai_calls`
Immutable log of every Tier 1 and Tier 2 AI call.
```sql
CREATE TABLE ai_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid REFERENCES posts(id),
  tier            integer NOT NULL,              -- 1 or 2
  model           text NOT NULL,                 -- 'claude-haiku-...' | 'claude-sonnet-...'
  prompt_version  text NOT NULL,                 -- git commit hash of prompt file
  input_tokens    integer NOT NULL,
  output_tokens   integer NOT NULL,
  cost_usd        numeric(10,6) NOT NULL,
  latency_ms      integer NOT NULL,
  request_payload jsonb,                         -- truncated for cost analysis
  response_payload jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_calls_post_id_idx ON ai_calls(post_id);
CREATE INDEX ai_calls_tier_idx ON ai_calls(tier);
CREATE INDEX ai_calls_created_at_idx ON ai_calls(created_at DESC);
```

### pgmq queues (created via SQL, not DDL migrations)
```sql
SELECT pgmq.create('tier1_queue');
SELECT pgmq.create('tier2_queue');
```

---

## 4. Queue Patterns

### Producer pattern (worker — after Tier 0 pass)
```typescript
// In worker/src/queue/producer.ts
export async function enqueueTier1(postId: string): Promise<void> {
  await supabase.rpc('pgmq_send', {
    queue_name: 'tier1_queue',
    msg: { post_id: postId },
  });
}
```

### Consumer pattern (worker — Tier 1 loop)
```typescript
// In worker/src/queue/consumer.ts
export async function runTier1Consumer(): Promise<void> {
  while (true) {
    const messages = await supabase.rpc('pgmq_read', {
      queue_name: 'tier1_queue',
      vt: 30,       // visibility timeout in seconds
      qty: 5,       // batch size
    });

    if (!messages.data?.length) {
      await sleep(2000);
      continue;
    }

    for (const msg of messages.data) {
      try {
        await processTier1(msg.message.post_id);
        // CRITICAL: must archive or message re-delivers after vt expires
        await supabase.rpc('pgmq_archive', {
          queue_name: 'tier1_queue',
          msg_id: msg.msg_id,
        });
      } catch (err) {
        // Log error, do NOT archive — allows up to max_delivery_count retries
        await logError('tier1', msg.message.post_id, err);
      }
    }
  }
}
```

### Error handling strategy

| Scenario | Handling |
|---|---|
| Transient network/API error | Do not archive — message re-delivers after `vt` (30s default) |
| Anthropic API 5xx | Same as above — snoowrap-style backoff, max 3 retries |
| Tier 2 confidence < 0.7 | Archive message + insert into `human_review_queue` |
| Parsing / schema error | Archive message + mark post `pipeline_status = 'error'` + log |
| pgmq `max_delivery_count` exceeded | Message moves to dead-letter; alert via Axiom |

### Retry visibility timeout tuning

- Tier 1 (Haiku): vt = 30s — fast calls, aggressive retry acceptable
- Tier 2 (Sonnet): vt = 60s — longer calls, avoid duplicate concurrent processing
- Batch size: start at 5, tune based on Railway instance memory

### Dead-letter handling
pgmq does not automatically dead-letter — messages that exceed `max_delivery_count` stay visible. Implement a separate drain job:
```sql
-- Periodically query for messages exceeding threshold
SELECT * FROM pgmq.q_tier1_queue WHERE read_ct > 5;
```
Archive these and write to `posts.pipeline_status = 'error'` with `error_detail`.

---

## 5. Build Order

Build in dependency order — each phase unblocks the next.

### Phase 1: Foundation (must be first)
**`packages/db`** — everything else imports from here.
- `schema.sql` with all tables, indexes, extensions
- `types.ts` mirroring the schema
- `client.ts` exporting `createClient()`
- Deploy schema to Supabase; create pgmq queues

### Phase 2: Core pipeline (sequential, each depends on prior)
**`apps/worker` — Ingestion + Tier 0**
- `SourceAdapter` interface
- Reddit adapter (snoowrap)
- Tier 0 keyword filter (inline, no queue)
- Writes `posts` table, enqueues to `tier1_queue`

**`apps/worker` — Tier 1**
- pgmq consumer scaffolding (read/archive pattern)
- Haiku classifier (tool use, `@anthropic-ai/sdk` direct)
- Logs to `ai_calls`, stores result in `posts.tier1_result`
- Enqueues Tier 1 passes to `tier2_queue`

**`apps/worker` — Tier 2 + Dedup**
- Sonnet extractor (tool use / structured output)
- Exclusion checks inline
- URL normalization + hash dedup
- Voyage embedding + pgvector cosine dedup
- Writes `offers` and `post_offers`
- Routes low-confidence to `human_review_queue`

### Phase 3: Validation
**`apps/worker` — Validation cron**
- pg_cron triggers worker endpoint (or worker polls `next_check_at`)
- URL liveness fetch + dead signal detection
- Updates `offers.status` + inserts `verification_log`

### Phase 4: Dashboard
**`apps/dashboard`**
- Supabase Auth (email allowlist gate)
- Offer list page (read from `offers` + `post_offers`)
- Human review queue page (read/write `human_review_queue`)
- AI calls log page
- Keyword suggestion surface (read-only, no writes to Tier 0 list)

Dashboard can be built in parallel with Phase 3 once the DB schema is stable (after Phase 2 first pass).

### Phase 5: Evals + hardening
- `evals/labeled-posts.json` + `evals/run-eval.ts`
- Prompt versioning wired to git hash
- Axiom structured logging
- Railway + Vercel environment wiring

---

## Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| pgmq message re-delivery causing duplicate AI calls | Always check `posts.pipeline_status` before processing; idempotent tier handlers |
| ivfflat index requires `ANALYZE` after bulk insert | Run `ANALYZE offers` after first batch; document in schema.sql comments |
| Voyage API rate limits during bulk backfill | Batch embedding calls; add per-request latency tracking in `ai_calls` |
| snoowrap incomplete types causing runtime errors | Wrap all Reddit API calls in try/catch; `@ts-ignore` with comments |
| Supabase pgvector `CREATE EXTENSION vector` not done | Add to schema.sql preamble with `IF NOT EXISTS` guard |
| Redirect-following before URL hashing adds latency | Run redirect follow async, cache in `posts` metadata before hashing |
