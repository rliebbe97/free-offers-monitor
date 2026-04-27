# Free Offers Monitor — Architecture Whitepaper

## 1. Purpose

Free Offers Monitor is an automated discovery pipeline that surfaces *genuinely free physical goods* for new mothers and families with babies — product samples, full-size freebies, and bundles with zero shipping cost and no purchase required. It scans public communities (Reddit subreddits and Discourse-style web forums), filters aggressively for false positives (coupons, trials, sweepstakes, shipping fees, services), extracts structured offer records, deduplicates across sources, and continuously verifies that each offer is still live.

The system is designed to run unattended at low cost. Keyword filtering rejects the majority of non-offers before any model call; a cheap Haiku classifier handles the remaining volume; an expensive Sonnet extractor only fires on high-probability candidates.

## 2. System Overview

```
┌─────────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐
│  Ingestion  │ ───► │  Tier 0  │ ───► │  Tier 1  │ ───► │  Tier 2  │
│  adapters   │      │ keywords │      │  Haiku   │      │  Sonnet  │
│ (Reddit,    │      │ (inline) │      │(pgmq job)│      │(pgmq job)│
│  TheBump)   │      └──────────┘      └──────────┘      └──────────┘
└─────────────┘                                                │
                                                               ▼
                                                          ┌──────────┐
                                                          │  Dedup   │
                                                          │ URL hash │
                                                          │ + Voyage │
                                                          │embeddings│
                                                          └──────────┘
                                                               │
                                                               ▼
                                              ┌────────────────────────────┐
                                              │  offers (published) │ human_│
                                              │                     │review │
                                              └────────────────────────────┘
                                                               │
                                                               ▼
                                                          ┌──────────┐
                                                          │Validation│
                                                          │  (cron)  │
                                                          └──────────┘
```

Two independent processes sit on top of a shared Supabase Postgres database:

- **Worker** (Node.js, long-running) — runs ingestion, classification, extraction, dedup, and validation loops concurrently. Deployed to Railway.
- **Dashboard** (Next.js 14 App Router) — auth-gated UI for browsing active offers, reviewing low-confidence extractions, and inspecting AI call logs. Deployed to Vercel.

The database does more than store rows: pgmq provides the queue primitive between tiers, pgvector holds 1024-dim Voyage embeddings for semantic dedup, and pg_cron triggers scheduled revalidation.

## 3. Components

### 3.1 Ingestion Layer

Every source implements a single interface:

```ts
interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
```

A factory (`createAdapterForSource`) dispatches on `sources.type`. Two adapters ship today:

- **RedditAdapter** — calls Reddit's public JSON endpoints (`/r/<sub>/new.json`, `/r/<sub>/comments/<id>.json`) over plain `fetch`. No OAuth, no client ID, no refresh token. Fetches the 25 newest posts per configured subreddit, then ingests top-level comments plus one reply deep, filtering out AutoModerator / `[deleted]` / bot accounts and moderator-distinguished items. Identification to Reddit is via a descriptive `User-Agent` (`free-offers-monitor/1.0 (by /u/Alternative-Owl-7042)` by default, overridable via `REDDIT_USER_AGENT`). Retries with exponential backoff on transient errors, aborts immediately on 404/410. This path was chosen because Reddit's `/prefs/apps` registration is currently effectively closed for new applicants — the redditdev community recommends public-endpoint polling, and steady-state usage (~2.4 req/min across 12 subs) sits comfortably under unauthenticated rate caps.
- **TheBumpAdapter** — extends a `BaseForumAdapter` abstract class that implements template-method pagination for Discourse-shaped forums. Uses `fetch` + Cheerio with polite 1–3s delays, detects Cloudflare challenges, and terminates when pages exceed the `since` watermark or a hard page cap.

New sources are added by implementing `SourceAdapter`, registering in the factory, and inserting a row into the `sources` table.

### 3.2 Tier 0 — Keyword Filter

Runs inline inside the ingestion loop (no queue round-trip). A hand-maintained list of ~25 high-recall terms (e.g. "free sample", "freebie", "no cost") is matched against title + body. Posts that fail are persisted with `tier0_passed = false` and never cost a model call. The keyword list is deliberately append-only-by-human — the system may *surface* suggestions, but never auto-adds terms.

### 3.3 Tier 1 — Haiku Binary Classifier

A pgmq consumer with a 30s visibility timeout reads from `tier1_queue`, calls **Claude Haiku 4** with the prompt at `prompts/tier1-classify.md`, and parses a small JSON payload:

```json
{ "decision": "pass" | "reject", "confidence": 0.0–1.0, "reason": "…" }
```

Passing posts are enqueued to `tier2_queue`. Failures retry up to 3 times before routing to `tier1_dlq`. Every call is logged to the `ai_calls` table with token counts, USD cost, latency, and the prompt's git short-SHA as `prompt_version`.

### 3.4 Tier 2 — Sonnet Structured Extractor

A pgmq consumer with a 120s visibility timeout reads from `tier2_queue` and calls **Claude Sonnet 4.5** with forced tool use. The single tool, `extract_offer`, defines a strict JSON schema with ten fields (title, brand, destination_url, category, offer_type, shipping_cost, restrictions, confidence, is_excluded, exclusion_reason). The tool response is validated against a Zod schema — any deviation routes to error state.

Routing rules after extraction:

- `is_excluded = true` → post marked `tier2_done`, no offer created.
- `confidence >= 0.7 && !is_excluded` → proceed to dedup.
- `confidence < 0.7` → inserted into `human_review_queue` for manual approval.

The exclusion criteria enforced by the prompt mirror the product rules: no coupons, no services, no paid shipping, no trials, no sweepstakes, no digital products, no referral barriers, no required purchases.

### 3.5 Dedup

Two layers in order, both bypass-early:

1. **URL hash** — destination URL is normalized (lowercased, fragment stripped, one-level redirect followed), hashed with SHA-256, and looked up against `offers.destination_url_hash` (unique index, O(1)). `normalize-url` handles UTM stripping but does not follow redirects, so the worker does a single-hop follow manually before hashing.
2. **Semantic embedding** — if URL dedup misses, `title + description + normalized_url` is embedded via Voyage AI (1024-dim), and a pgvector ANN search (`ivfflat.probes=10`) queries for cosine similarity ≥ 0.85.

A match links the new post to the existing offer via the `post_offers` junction. A miss inserts a new `offers` row (with `ON CONFLICT (destination_url_hash) DO NOTHING` as a race guard) and sets `next_check_at = now() + 7 days`.

### 3.6 Validation

A worker loop (and daily pg_cron, `0 0 * * *`) queries for active offers where `next_check_at <= now()`. Each is fetched with a 10s timeout and up to 5 redirect hops. The page is inspected for:

- Dead signals in text: `expired`, `out of stock`, `no longer available`.
- HTTP status: 404 / 410 → dead; 403 / 429 → WAF block (no failure increment).

Outcomes:

- Live → `consecutive_failures = 0`, next check in 7 days + jitter.
- First failure → `consecutive_failures = 1`, recheck in 24 hours.
- Second consecutive failure → `status = 'expired'`, stops checking.
- WAF block → recheck in 6 hours, no failure increment.

Every check writes a row to `verification_log` with HTTP status, is_live, dead signals, and a 2000-char truncated response body.

### 3.7 Dashboard

Next.js App Router app with three authenticated routes:

- `/dashboard/offers` — paginated, filterable, sortable list of active offers.
- `/dashboard/review` — human review queue with approve / reject actions.
- `/dashboard/ai-logs` — table of AI calls, sortable by model, tier, cost, latency, and tokens.

Auth is Supabase email/password with an allowlist enforced via an RLS policy. SSR session sync is handled by `@supabase/ssr` middleware.

## 4. Data Model

All tables live in one Postgres schema (`packages/db/src/schema.sql`):

| Table | Role |
|-------|------|
| `sources` | Configured Reddit subs and forum bases. `type`, `identifier`, `config` (jsonb), `last_polled_at`. |
| `posts` | Raw ingested posts. `tier0_passed`, `tier1_result` (jsonb), `tier2_result` (jsonb), `pipeline_status`. Unique on `(source_id, external_id)`. |
| `offers` | Canonical deduped offers. `destination_url_hash` (unique), `embedding vector(1024)`, `status`, `next_check_at`, `consecutive_failures`. |
| `post_offers` | Many-to-many join between posts and the offer they contributed to. |
| `verification_log` | Append-only history of liveness checks. |
| `human_review_queue` | Low-confidence Tier 2 extractions awaiting human decision. |
| `ai_calls` | Every Haiku/Sonnet call with tokens, USD cost, latency, prompt git SHA. |

Critical indexes: `UNIQUE(source_id, external_id)` on posts, unique hash index on `offers.destination_url_hash`, IVFFLAT on `offers.embedding`, and a partial `INDEX(next_check_at) WHERE status='active'` for cheap validation scans.

Required Postgres extensions (must be enabled on the Supabase project): `vector`, `pgmq`, `pg_cron`.

## 5. Deployment Topology

```
┌──────────────┐        ┌──────────────────────────────┐
│   Vercel     │        │          Supabase            │
│  Dashboard   │◄──────►│  Postgres + pgvector + pgmq  │
│  (Next.js)   │  SSR   │  + pg_cron + Auth + Vault    │
└──────────────┘        └──────────────────────────────┘
                                   ▲
                                   │ service role
                                   │
                        ┌──────────┴───────────┐
                        │      Railway         │
                        │   Worker (Node.js)   │
                        └──────────┬───────────┘
                                   │
             ┌─────────────────────┼─────────────────────┐
             ▼                     ▼                     ▼
      ┌────────────┐       ┌────────────┐       ┌─────────────┐
      │ Anthropic  │       │   Voyage   │       │   Reddit    │
      │ Haiku +    │       │ embeddings │       │ public JSON │
      │ Sonnet     │       │            │       │ (no OAuth)  │
      └────────────┘       └────────────┘       └─────────────┘

           optional:   Axiom (logging)    TheBump (HTML scrape)
```

- **Supabase** holds *all* durable state: relational data, queues (pgmq), vectors (pgvector), secrets (Vault, in prod), and auth. No other persistence layer exists.
- **Railway** runs the worker as a single long-lived Node.js process. Health endpoint on `PORT` (default 3001).
- **Vercel** serves the dashboard. It reads from Supabase via anon key on the client and service role on server components where needed.
- **Axiom** receives structured logs if `AXIOM_TOKEN` is set; otherwise the worker logs to stdout.

## 6. Operational Characteristics

- **Cost shape.** Tier 0 is free. Tier 1 (Haiku) is $0.80 / M input, $4 / M output — cheap per call but the volume pivot. Tier 2 (Sonnet) is $3 / M input, $15 / M output — fires only on pre-filtered candidates. Every call persists `cost_usd` to `ai_calls`, so spend is queryable per tier, per day, per prompt version.
- **Observability.** Prompt versioning is baked in: every AI call records the git SHA of the prompt file, enabling regression analysis when a prompt changes. Pipeline state on each post (`pipeline_status`) makes it trivial to bucket stuck work.
- **Resilience.** pgmq visibility timeouts auto-redeliver messages whose workers crash. Tier 1 and Tier 2 each have a DLQ. URL dedup uses `ON CONFLICT DO NOTHING` as a race guard. Validation uses exponential-ish backoff (24h → expired) and distinguishes WAF blocks from real failures.
- **Model pinning.** Model IDs are pinned to dated versions (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`) — never unversioned aliases — so extraction behavior is reproducible across deploys.
- **Evaluation.** `evals/labeled-posts.json` holds 21 labeled posts (11 Reddit, 10 TheBump, with cross-source duplicate pairs). `pnpm eval` runs the Tier 1 classifier against ground truth and computes cross-source extraction cosine similarity (target ≥ 0.85). This is the regression harness for prompt or model changes.

## 7. Extending the System

- **New ingestion source.** Implement `SourceAdapter`, register in the factory, insert a `sources` row. Forum-shaped sources should extend `BaseForumAdapter` to inherit pagination.
- **New exclusion rule.** Edit `prompts/tier2-extract.md`, add a labeled counter-example to `evals/labeled-posts.json`, run `pnpm eval`, commit. The git SHA will propagate into `ai_calls.prompt_version` automatically.
- **New category.** Add the enum value to the `extract_offer` tool schema in `apps/worker/src/tiers/tier2.ts` *and* the Zod schema in `apps/worker/src/tiers/schemas.ts` *and* the `offers.category` check constraint in `schema.sql`. All three must stay in sync.
- **Tighter dedup.** Raise `EMBEDDING_SIMILARITY_THRESHOLD` in config, retune `ivfflat.probes` as the offer table grows (rule of thumb: `sqrt(row_count)`).

## 8. Non-Goals

- No wrapper frameworks (LangChain, Vercel AI SDK) — direct `@anthropic-ai/sdk` only.
- No auto-learning of Tier 0 keywords — suggestions surface to humans, humans decide.
- No mobile app — dashboard is web-only.
- No public API — all reads go through the dashboard with allowlisted auth.
