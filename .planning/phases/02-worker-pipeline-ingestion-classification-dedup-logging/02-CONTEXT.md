# Phase 2: Worker Pipeline — Ingestion, Classification, Dedup & Logging - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the full end-to-end worker pipeline from Reddit ingestion through Tier 0 keyword filtering, Tier 1 Haiku classification, Tier 2 Sonnet extraction with deduplication, and AI call logging. This phase covers 20 requirements: ING-01–05, CLS-01–06, DDP-01–04, LOG-01–02, WRK-01–03.

</domain>

<decisions>
## Implementation Decisions

### Reddit Polling & Subreddit Configuration
- **D-01:** Poll interval is 5 minutes per subreddit. Stays well within 100 req/min OAuth rate limit while keeping offer freshness acceptable.
- **D-02:** Subreddit configuration lives in the `sources` table — each row represents one subreddit with `type='reddit'` and `identifier` set to the subreddit name. Runtime configurable without redeployment.
- **D-03:** Initial target subreddits: `freebies`, `BabyBumps`, `beyondthebump`. Seed these into `sources` at first run or via a seed script.
- **D-04:** Fetch 25 newest posts per subreddit per poll cycle. For each post, also fetch top-level comments and one reply deep per CLAUDE.md rules.
- **D-05:** Bot/deleted detection at the adapter boundary: hard-skip `AutoModerator`, accounts matching `*Bot`/`*_bot`/`*_official`, `author === null`, `selftext === '[deleted]'`/`'[removed]'`, and `post.distinguished === 'moderator'`. Log each skip with a structured event.

### Tier 0 Keyword Design
- **D-06:** Keyword list lives in a TypeScript file at `apps/worker/src/tiers/tier0-keywords.ts` — exported as a `string[]`. Version-controlled, reviewable in PRs, no DB roundtrip.
- **D-07:** Keywords imported at module load time, cached in memory. No runtime file reads.
- **D-08:** Initial keyword set targets free physical goods for babies/mothers: terms like `free`, `sample`, `giveaway`, `sign up`, `register`, `baby box`, `welcome kit`, `new mom`, `newborn`, `diaper`, `formula sample`, etc. Specific list finalized during planning.
- **D-09:** Tier 0 runs inline during ingestion (before enqueue to tier1_queue). Posts that fail Tier 0 are stored with `tier0_passed=false` and `pipeline_status='tier0_rejected'` — never enqueued.

### Prompt & Model Versioning
- **D-10:** AI model strings pinned to specific dated versions in a config module (`apps/worker/src/config.ts`). Use Haiku for Tier 1 and Sonnet for Tier 2 per project constraints. Never use unversioned aliases in production.
- **D-11:** Prompts live in `prompts/tier1-classify.md` and `prompts/tier2-extract.md`. Read from disk at worker startup, cached in memory for the process lifetime. No per-request file reads.
- **D-12:** `prompt_version` computed as `git rev-parse --short HEAD` at worker startup, injected into every `ai_calls` row. Computed once, not per-call.
- **D-13:** Tier 2 uses `tool_choice: { type: 'tool', name: 'extract_offer' }` to force tool use. Tool output validated with Zod before any DB insert.

### Worker Process Architecture
- **D-14:** Single Node.js process with three concurrent loops: (1) Reddit polling loop on a 5-min interval, (2) Tier 1 pgmq consumer loop polling `tier1_queue`, (3) Tier 2 pgmq consumer loop polling `tier2_queue`. All run concurrently via async scheduling.
- **D-15:** Graceful shutdown via SIGTERM/SIGINT handlers: set a shutdown flag, let current message processing complete, archive any in-flight pgmq messages, then exit cleanly. Railway sends SIGTERM on deploy.
- **D-16:** Simple HTTP health endpoint (e.g., `http://0.0.0.0:${PORT}/health`) returning 200 for Railway health checks. No framework — plain `http.createServer`.
- **D-17:** pgmq consumers call `archive()` in `finally` blocks on all code paths per WRK-01. Messages exceeding retry threshold (3 attempts) are sent to a DLQ (`tier1_dlq`/`tier2_dlq`) before archiving.
- **D-18:** Worker startup asserts all required Postgres extensions are present via `check_required_extensions()` RPC from schema. Fails fast with a clear error if any extension is missing.

### AI Call Logging
- **D-19:** Every Tier 1 and Tier 2 call logs to `ai_calls` table with: model, prompt_version, input_tokens, output_tokens, cost_usd (computed from token counts), latency_ms, post_id, tier, and request/response payloads (truncated for cost analysis).
- **D-20:** Cost computed client-side from token counts using known model pricing constants in config. Not relying on API response for cost.

### Claude's Discretion
- Exact polling implementation (setInterval vs recursive setTimeout)
- pgmq read batch size (1 vs small batch per consumer tick)
- Specific Zod schema shape for Tier 2 tool output (must cover all `offers` table fields)
- DLQ queue creation strategy (create alongside main queues or lazily)
- URL normalization library configuration details
- Voyage AI client setup and embedding call structure
- Whether to use a shared `SourceAdapter` interface file in `@repo/db` or keep it worker-local

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Schema
- `.planning/research/ARCHITECTURE.md` — Full DDL, component boundaries, pipeline flow diagram
- `packages/db/src/schema.sql` — Canonical schema with all 7 tables, indexes, queues, and extension verification function

### Pitfalls
- `.planning/research/PITFALLS.md` — snoowrap OAuth/types/rate-limit traps, pgmq archive patterns, pgvector dimension checks, AI classification parsing failures, URL normalization edge cases

### Stack
- `.planning/research/STACK.md` — Supabase JS version, pgvector/pgmq configuration, snoowrap setup notes

### Project Rules
- `CLAUDE.md` — Offer criteria (no coupons, no services, no shipping, no trials, no sweepstakes), AI SDK constraints, Reddit ingestion rules, code style, critical rules

### Phase 1 Context
- `.planning/phases/01-db-foundation-shared-package/01-CONTEXT.md` — DB client pattern, type generation, queue configuration decisions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/db/src/client.ts` — `createClient()` factory, ready to use from worker
- `packages/db/src/types.ts` — Full typed Database interface for all 7 tables
- `packages/db/src/index.ts` — Re-exports client + all row types (Source, Post, Offer, etc.)
- `packages/db/src/schema.sql` — `check_required_extensions()` RPC function for startup verification

### Established Patterns
- Monorepo workspace references via `workspace:*` protocol
- tsup for builds (ESM + DTS)
- TypeScript strict mode, no `any` — use `unknown` + type narrowing
- Named exports only, no default exports

### Integration Points
- `apps/worker/package.json` already depends on `@repo/db` — needs `@anthropic-ai/sdk`, `snoowrap`, `normalize-url`, `zod`, `cheerio` added as dependencies
- `apps/worker/src/index.ts` currently bare (`console.log`) — entry point for the worker process
- `.env.example` already lists all required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`
- `prompts/` directory does not exist yet — needs creation with `tier1-classify.md` and `tier2-extract.md`

</code_context>

<specifics>
## Specific Ideas

No specific requirements — follow architecture research, pitfalls guidance, and standard patterns for each component.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-worker-pipeline-ingestion-classification-dedup-logging*
*Context gathered: 2026-04-20*
