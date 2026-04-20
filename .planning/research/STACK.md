# Stack Research

**Domain:** Reddit/forum monitoring with AI classification pipeline
**Researched:** 2026-04-20
**Confidence:** HIGH

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|---|---|---|---|
| pnpm | 10.33.0 | Package manager + workspace orchestration | Native monorepo workspaces, strict hoisting, faster than npm/yarn |
| Turborepo | 2.9.6 | Monorepo task runner + build cache | Remote cache, dependency graph awareness, first-class pnpm support |
| Node.js | 22.x LTS | Worker runtime | LTS with built-in fetch, `--env-file`, native `crypto.hash()` |
| TypeScript | 6.0.3 | Type-safe JavaScript | Strict mode, latest `satisfies`, no `any` policy |
| Next.js | 16.2.4 | Dashboard frontend | App Router, RSC, built-in Vercel deployment, no config deploys |
| React | 19.2.5 | UI library (peer dep of Next.js) | Required by Next.js 16; concurrent features, server actions |
| Supabase JS | 2.104.0 | Database client (Postgres + Auth + Vault) | Single SDK for DB, Auth, realtime, Vault — avoids direct pg wiring |
| @anthropic-ai/sdk | 0.90.0 | Haiku classifier + Sonnet extractor | Official SDK, streaming, tool use, typed responses — no wrappers |
| voyageai | 0.2.1 | 1024-dim semantic embeddings for dedup | Superior retrieval quality vs OpenAI at lower cost per token |
| snoowrap | 1.23.0 | Reddit API client | Most mature Node.js Reddit wrapper; handles OAuth + rate-limit backoff |
| Cheerio | 1.2.0 | HTML parsing/scraping | Lightweight jQuery-like API, no headless browser overhead |
| Vitest | 4.1.4 | Test runner | Native ESM, TypeScript-first, compatible with pnpm workspaces |
| Tailwind CSS | 4.2.2 | Utility-first CSS | Required by shadcn/ui; zero-runtime, purges unused styles |
| shadcn/ui | 4.3.1 | Component library (CLI-installed) | Copies source into repo, no upstream runtime dependency |

---

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---|---|---|---|
| zod | 4.3.6 | Runtime schema validation + type inference | Validate AI tool-use responses, API inputs, env vars |
| normalize-url | 9.0.0 | URL normalization (strips UTM, trailing slashes) | Before URL hashing for dedup — does NOT follow redirects |
| dotenv | 17.4.2 | Load `.env.local` in dev | Worker dev mode; Supabase Vault replaces this in prod |
| @supabase/ssr | 0.10.2 | Supabase Auth helpers for Next.js App Router | Cookie-based session handling in Server Components + middleware |
| @axiomhq/js | 1.6.0 | Structured log shipping to Axiom | Worker ingestion events, pipeline metrics, error traces |
| p-limit | 7.3.0 | Concurrency limiter for async operations | Throttle Reddit API calls and embedding requests |
| p-retry | 8.0.0 | Retry with exponential backoff | Wrap Voyage AI and Anthropic calls for transient failures |
| lucide-react | 1.8.0 | Icon set for dashboard UI | Consistent with shadcn/ui design system |
| class-variance-authority | 0.7.1 | Type-safe CSS variant composition | Used internally by shadcn/ui components |
| clsx | 2.1.1 | Conditional className utility | Combine Tailwind classes conditionally |
| tailwind-merge | 3.5.0 | Merge conflicting Tailwind classes safely | Prevent duplicate utility conflicts in component variants |
| @types/node | 22.15.3 | Node.js type definitions | Worker TypeScript compilation |
| @types/snoowrap | 1.19.0 | Incomplete snoowrap type stubs | Use `@ts-ignore` where stubs are wrong — see Gotchas |

---

### Development Tools

| Tool | Purpose | Notes |
|---|---|---|
| ESLint 9 | Linting with flat config (`eslint.config.js`) | Use `typescript-eslint` v8 flat config format; no `.eslintrc` |
| Prettier 3.8.3 | Consistent code formatting | Run via `pnpm format`; pair with `eslint-config-prettier` |
| tsx 4.21.0 | Run TypeScript files directly in Node.js | Use for worker dev mode (`pnpm dev --filter worker`) |
| Playwright | Conditional — only if JS rendering required | Do not include by default; add only when Cheerio is insufficient |
| Supabase CLI | DB migrations, type generation, local dev | `pnpm db:generate` invokes this for schema → TypeScript types |

---

## What NOT to Use

| Library | Why to Avoid |
|---|---|
| LangChain | Over-abstraction, version churn, hides token costs, incompatible with direct `ai_calls` logging requirement |
| Vercel AI SDK | Wraps `@anthropic-ai/sdk`, prevents direct control of tool-use schema and logging; explicitly out of scope |
| OpenAI SDK | Wrong provider — Anthropic only via `@anthropic-ai/sdk` |
| OpenAI Embeddings | Voyage AI selected for higher retrieval quality at lower cost; do not mix embedding providers |
| Prisma | Supabase JS client is the data layer; Prisma adds friction with pgvector and pgmq extensions |
| Drizzle ORM | Same reason as Prisma — raw Supabase client + typed schema from `@repo/db` is sufficient |
| SQS / RabbitMQ / BullMQ | pgmq keeps queuing in Postgres — no extra infra, no separate connection pool |
| node-cron | pg_cron handles scheduled validation inside Postgres — no in-process scheduler needed |
| node-fetch | Node 22 has native `fetch` built in — no polyfill required |
| winston / pino | Axiom (`@axiomhq/js`) is the structured log destination; local `console.*` is fine for non-prod |
| next-auth | Supabase Auth with email allowlist is the auth layer; next-auth conflicts with `@supabase/ssr` |

---

## Configuration Notes

### pgvector

```sql
-- Run once on fresh Supabase project (via SQL editor or migration)
CREATE EXTENSION IF NOT EXISTS vector;

-- Voyage embeddings are exactly 1024 dimensions — must match
ALTER TABLE offers ADD COLUMN embedding vector(1024);

-- IVFFlat index for approximate nearest-neighbor search
-- lists = sqrt(row_count) is a good starting value; tune after 10k+ rows
CREATE INDEX ON offers USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Cosine similarity query pattern (threshold >= 0.85 = duplicate)
SELECT id, 1 - (embedding <=> $1::vector) AS similarity
FROM offers
ORDER BY embedding <=> $1::vector
LIMIT 5;
```

Key points:
- `vector(1024)` is hardcoded to Voyage AI output — do not use a different embedding provider without a migration.
- `ivfflat` requires at least ~1000 rows to be useful; fall back to sequential scan in dev.
- Enable `pgvector` extension before running any migration that references the `vector` type.

---

### pgmq

pgmq is a Postgres extension available on Supabase. Messages are consumed via SQL functions.

```sql
-- Create queues (run once)
SELECT pgmq.create('tier1_queue');
SELECT pgmq.create('tier2_queue');

-- Produce a message (from app code via Supabase RPC)
SELECT pgmq.send('tier1_queue', '{"post_id": "abc123"}'::jsonb);

-- Consume (long-poll, visibility timeout = 30s)
SELECT * FROM pgmq.read('tier1_queue', 30, 10);

-- CRITICAL: Archive after successful processing (or message re-delivers after timeout)
SELECT pgmq.archive('tier1_queue', msg_id);

-- Delete instead of archive if you don't need the audit trail
SELECT pgmq.delete('tier1_queue', msg_id);
```

Key points:
- Always call `pgmq.archive(queue_name, msg_id)` after successful processing. Failure to do so causes re-delivery after the visibility timeout expires.
- Use `pgmq.read` with a conservative visibility timeout (30–60s) that exceeds your expected processing time.
- Set `max_retries` logic at the application level — pgmq does not have native DLQ; route failed messages to `human_review_queue` after N failures.
- `pg_cron` can trigger queue reads for scheduled jobs (e.g., daily validation sweep).

---

### snoowrap OAuth

snoowrap requires a Reddit OAuth "script" app for server-side use.

```typescript
import Snoowrap from 'snoowrap';

const reddit = new Snoowrap({
  userAgent: 'free-offers-monitor/1.0 by u/YourRedditUsername',
  clientId: process.env.REDDIT_CLIENT_ID,
  clientSecret: process.env.REDDIT_CLIENT_SECRET,
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
});

// Rate limit: 100 req/min with OAuth. snoowrap handles backoff automatically.
// Log when it triggers — check `reddit.ratelimitRemaining` after calls.
// @ts-ignore is expected on some API response shapes — types are incomplete.
```

Key points:
- Create a "script" type app at reddit.com/prefs/apps — not "web app" or "installed app".
- `userAgent` must be descriptive and include your Reddit username to avoid bans.
- snoowrap handles OAuth token refresh and rate-limit backoff automatically, but you must log when backoff triggers (check `ratelimitRemaining`).
- Ingest top-level comments and one reply deep only. Skip posts/comments by AutoModerator and known bot accounts.
- Types are incomplete — `@ts-ignore` on specific response fields is acceptable and expected.

---

### URL Normalization + Hashing Pattern

```typescript
import normalizeUrl from 'normalize-url';
import { createHash } from 'node:crypto';

async function normalizeAndHash(rawUrl: string): Promise<string> {
  // 1. Follow one level of redirects (normalize-url does NOT do this)
  const resolved = await followOneRedirect(rawUrl);

  // 2. Normalize: strips UTM params, trailing slashes, etc.
  const normalized = normalizeUrl(resolved, {
    stripWWW: true,
    removeQueryParameters: [/^utm_/i, 'ref', 'source'],
    sortQueryParameters: true,
  });

  // 3. Hash for dedup index lookup
  return createHash('sha256').update(normalized).digest('hex');
}
```

Key points:
- `normalize-url` v9 is ESM-only — use `import`, not `require`.
- Always follow one redirect level before normalizing — affiliate links and tracking URLs will mismatch otherwise.
- Store the hash in `offers.destination_url_hash` with a `UNIQUE` index for O(1) dedup lookups.

---

### Environment Variables

```
# Worker (.env.local)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
AXIOM_TOKEN=
AXIOM_DATASET=

# Dashboard (.env.local)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=   # server-only, never NEXT_PUBLIC_
AXIOM_TOKEN=
AXIOM_DATASET=
```

In production, sensitive keys (ANTHROPIC_API_KEY, VOYAGE_API_KEY, REDDIT_*) are stored in Supabase Vault and injected via Railway environment. Never commit `.env` or `.env.local`.
