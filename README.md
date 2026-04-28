# Free Offers Monitor

Automated discovery pipeline that surfaces *genuinely free physical goods* for new mothers and families with babies — product samples, full-size freebies, and bundles with zero shipping cost and no purchase required. Scans Reddit and forum sources, classifies posts through a tiered AI pipeline (cheap keyword filter → Haiku binary classifier → Sonnet structured extractor), dedups across sources via URL hashing and Voyage embeddings, and continuously revalidates that each offer is still live.

For full system design, see [`whitepaper.md`](./whitepaper.md). For adding new ingestion sources, see [`apps/worker/src/ingestion/ADDING-SOURCES.md`](./apps/worker/src/ingestion/ADDING-SOURCES.md).

## Architecture

Two long-running processes share a Supabase Postgres database:

```
┌─────────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Ingestion  │ ──► │  Tier 0  │ ──► │  Tier 1  │ ──► │  Tier 2  │ ──► │  Dedup   │
│  adapters   │     │ keywords │     │  Haiku   │     │  Sonnet  │     │ URL hash │
│ (Reddit,    │     │ (inline) │     │(pgmq job)│     │(pgmq job)│     │ + Voyage │
│  TheBump)   │     └──────────┘     └──────────┘     └──────────┘     └──────────┘
└─────────────┘                                                              │
                                                                             ▼
                                                                  ┌────────────────────┐
                                                                  │ offers (published) │
                                                                  │  human_review_queue │
                                                                  └──────────┬─────────┘
                                                                             │
                                                                             ▼
                                                                       ┌──────────┐
                                                                       │Validation│
                                                                       │  (cron)  │
                                                                       └──────────┘
```

- **Worker** (`apps/worker`) — Node.js long-running service deployed to Railway. Runs ingestion, Tier 1/2 classification, dedup, and validation loops concurrently.
- **Dashboard** (`apps/dashboard`) — Next.js App Router app deployed to Vercel. Auth-gated UI for browsing offers, reviewing low-confidence extractions, and inspecting AI call logs.
- **Database** (`packages/db`) — shared Supabase Postgres schema, types, and migrations. pgmq for queues, pgvector for embeddings, pg_cron for revalidation.

The core pipeline:

1. **Ingestion** polls Reddit (public JSON, no OAuth) and TheBump forums on a 5-minute cycle. Each adapter implements `SourceAdapter.fetchNewPosts(since)`. Posts upserted to `posts` table.
2. **Tier 0** runs inline — a hand-curated keyword filter rejects the bulk of non-offers before any model call.
3. **Tier 1** is a pgmq consumer calling Claude Haiku 4.5 for binary pass/reject. ~$0.001/post. Result stored as `tier1_result` JSONB.
4. **Tier 2** is a pgmq consumer calling Claude Sonnet 4.6 with forced tool use to extract a structured offer. Confidence < 0.7 routes to `human_review_queue`; `is_excluded = true` posts (coupons, services, paid shipping, trials, sweepstakes, digital, referral) drop without creating an offer.
5. **Dedup** matches by SHA-256 of the normalized destination URL, then falls back to Voyage embedding cosine ≥ 0.85 via pgvector. Misses create a new `offers` row; matches link via `post_offers` junction.
6. **Validation** runs daily via pg_cron and weekly per offer. Fetches each URL with a 10s timeout, looks for dead signals (`expired`, `out of stock`, 404/410). Two consecutive failures → `status = 'expired'`.

Every Anthropic call logs token counts, cost, latency, and the prompt's git SHA to the `ai_calls` table.

## Repo Layout

```
apps/
├── dashboard/        Next.js 16 App Router + shadcn/ui → Vercel
└── worker/           Node.js long-running service → Railway
    └── src/
        ├── ingestion/   Reddit, TheBump, BaseForumAdapter
        ├── tiers/       Tier 0 keywords, Tier 1, Tier 2
        ├── dedup/       URL norm + embedding dedup
        ├── validation/  Liveness recheck loop
        └── queue/       pgmq consumer/producer
packages/
└── db/               Shared Supabase client, types, schema, migrations
evals/                Labeled posts + Vitest-style harness
prompts/              Versioned markdown prompts (Tier 1, Tier 2)
```

## Prerequisites

- Node.js ≥ 18
- pnpm 9
- A Supabase project with extensions enabled: `vector`, `pgmq`, `pg_cron`
- API keys: Anthropic, Voyage AI, optional Axiom for logging

## Setup

```sh
# 1. Install dependencies (workspace-wide)
pnpm install

# 2. Copy the env template and fill in secrets
cp .env.example .env.local

# 3. Apply the schema and seed migrations to your Supabase project
psql "$SUPABASE_DB_URL" -f packages/db/src/schema.sql
psql "$SUPABASE_DB_URL" -f packages/db/src/migrations/001_seed_thebump_sources.sql

# 4. (Optional) regenerate DB types from your Supabase project
pnpm db:generate
```

### Required environment variables

Worker (`.env.local` at repo root):

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
AXIOM_TOKEN=                # optional — falls back to stdout
AXIOM_DATASET=free-offers-monitor
PORT=3001
REDDIT_USER_AGENT=free-offers-monitor/1.0 (by /u/<your-account>)
```

Dashboard (`apps/dashboard/.env.local`):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ALLOWED_EMAILS=you@example.com,teammate@example.com
```

## Commands

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace deps |
| `pnpm dev --filter dashboard` | Run Next.js dev server (defaults to `:3000`) |
| `pnpm dev --filter worker` | Run worker in watch mode (tsx watch) |
| `pnpm build` | Turbo build across all packages |
| `pnpm test` | Vitest across all packages |
| `pnpm test --filter worker` | Worker tests only |
| `pnpm lint` | ESLint across the monorepo |
| `pnpm check-types` | `tsc --noEmit` across all packages |
| `pnpm db:generate` | Regenerate `@repo/db` types from Supabase |
| `pnpm eval` | Run Tier 1 against `evals/labeled-posts.json` |
| `pnpm demo` | End-to-end demo: ingest sample posts → Tier 1 → Tier 2 |
| `pnpm format` | Prettier-format all `*.{ts,tsx,md}` |

## Key Constraints

- TypeScript strict mode, no `any` — use `unknown` + narrowing.
- Named exports only.
- Use the Supabase client from `@repo/db`. Never instantiate Supabase directly in app code.
- Direct `@anthropic-ai/sdk` only — no LangChain, no Vercel AI SDK, no wrappers.
- Every Tier 1/2 call **must** log to `ai_calls`.
- Every new ingestion adapter must implement `SourceAdapter`. See [`ADDING-SOURCES.md`](./apps/worker/src/ingestion/ADDING-SOURCES.md).
- Tier 0 keywords are append-only-by-human. The system can surface suggestions; humans decide.
- Tier 2 confidence < 0.7 routes to `human_review_queue`, never auto-publishes.
- Model IDs are pinned to dated versions (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`) — never unversioned aliases.
- Never commit `.env` or `.env.local`.

## Deployment

- **Worker → Railway.** Single long-lived Node.js process, health endpoint on `PORT` (default 3001). Deploys from `apps/worker`.
- **Dashboard → Vercel.** Next.js App Router. Set the env vars listed above in the Vercel project settings.
- **Database → Supabase.** All durable state lives here: relational tables, queues (pgmq), vectors (pgvector), schedules (pg_cron), secrets (Vault), and auth.

See [`whitepaper.md`](./whitepaper.md) §5 for the full deployment topology diagram.
