# Free Offers Monitor

## What This Is

An automated pipeline that scans Reddit for genuinely free physical goods offerings for new mothers and families with babies. It uses a three-tier AI classification system (keyword filter, Haiku classifier, Sonnet extractor) with deduplication via URL hashing and Voyage embeddings, validates offer liveness daily, and surfaces verified offers through an auth-gated Next.js dashboard with review queue capabilities.

## Core Value

Reliably surface genuinely free physical goods (zero shipping, no coupons, no trials, no sweepstakes) from noisy forum data — false negatives cost missed offers, false positives erode trust.

## Current Milestone: v1.1 Forum Adapters

**Goal:** Expand ingestion beyond Reddit with a TheBump community adapter and reusable adapter infrastructure.

**Target features:**
- TheBump community adapter (freebies/deals subforums, Cheerio scraping, feeds into existing 3-tier pipeline)
- Shared adapter infrastructure (base classes, shared scraping utilities, config-driven source registration extracted from Reddit + TheBump patterns)

## Current State

**Shipped:** v1.0 MVP (2026-04-21), v1.1 Forum Adapters (2026-04-22)
**Codebase:** ~27,365 LOC TypeScript across monorepo (pnpm workspaces + Turborepo)
**Tech stack:** Next.js 14, Supabase (Postgres + pgvector + pgmq + pg_cron), @anthropic-ai/sdk, Voyage AI, snoowrap, Cheerio

The full pipeline is built: multi-source ingestion (Reddit + TheBump) via type-agnostic dispatch factory -> Tier 0 keyword filter -> Tier 1 Haiku classifier -> Tier 2 Sonnet extractor -> URL hash + embedding dedup -> offer creation -> daily validation cron -> dashboard with auth, offer list, review queue, and AI call log viewer. Cross-source dedup validated with 10 Reddit+TheBump eval pairs.

## Requirements

### Validated

- ✓ Supabase DB with pgvector, pgmq, pg_cron and 7 tables — v1.0
- ✓ Shared @repo/db typed client package — v1.0
- ✓ Reddit ingestion pipeline with snoowrap OAuth — v1.0
- ✓ Tier 0 keyword filter (25 hand-maintained terms) — v1.0
- ✓ Tier 1 Haiku binary classifier via pgmq — v1.0
- ✓ Tier 2 Sonnet structured extraction with forced tool use — v1.0
- ✓ Exclusion checks (coupons, services, shipping, trials, sweepstakes) — v1.0
- ✓ URL hash + Voyage embedding cosine dedup — v1.0
- ✓ All AI calls logged with tokens, cost, latency, prompt version — v1.0
- ✓ Low-confidence routing to human review queue — v1.0
- ✓ Offer validation cron with two-failure expiry — v1.0
- ✓ Auth-gated dashboard with email allowlist — v1.0
- ✓ Offer list with pagination, filter, sort — v1.0
- ✓ Review queue with approve/reject actions — v1.0
- ✓ AI call log viewer with sortable columns — v1.0

### Active

- [ ] TheBump community adapter (freebies/deals subforums, Cheerio scraping)
- [ ] Shared adapter infrastructure (base classes, scraping utilities, config-driven source registration)

### Out of Scope

- Mobile app — web dashboard sufficient for internal use
- Public-facing UI — internal tool with email allowlist auth
- Auto-modifying Tier 0 keyword list — human decides, system only suggests
- LangChain / Vercel AI SDK / AI wrappers — use @anthropic-ai/sdk directly
- Auto-publishing low-confidence offers — < 0.7 confidence always routes to human review
- Email digest of new verified offers — deferred to future milestone
- Pipeline throughput metrics dashboard — deferred to future milestone
- AI cost tracking with daily/weekly aggregates — deferred to future milestone
- Bulk approve/reject in review queue — deferred to future milestone
- Offer edit capability for correcting extracted data — deferred to future milestone
- CLI adapter builder flow — deferred to backlog

## Context

Shipped v1.0 MVP with ~27,365 LOC TypeScript.
Tech stack: Next.js 14, Supabase, @anthropic-ai/sdk (Haiku + Sonnet), Voyage AI, snoowrap, Cheerio.
Worker runs 4 concurrent loops: Reddit ingestion, Tier 1, Tier 2, validation.
Dashboard deploys to Vercel, worker to Railway.
13 Vitest tests for validation module.
Hand-written DB types — run `pnpm db:generate` against live Supabase to reconcile.

## Constraints

- **AI SDK**: Must use `@anthropic-ai/sdk` directly — no wrapper libraries
- **Reddit rate limits**: 100 req/min with OAuth; snoowrap handles backoff but must log triggers
- **Embedding dimensions**: Voyage embeddings are 1024-dim — pgvector column must be `vector(1024)`
- **pgmq**: Messages need explicit `archive()` after processing or they re-deliver
- **URL normalization**: `normalize-url` strips UTM but doesn't follow redirects — custom one-level redirect follow required before hashing
- **Offer criteria**: Genuinely free physical goods, zero shipping cost, no coupons, no services, no trials, no sweepstakes
- **Tier 2 confidence**: < 0.7 routes to `human_review_queue`, never auto-published
- **Prompts**: Live in `prompts/` as markdown, versioned with git hash

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Three-tier classification (keyword -> Haiku -> Sonnet) | Balances cost and accuracy — cheap filter first, expensive extraction only on candidates | ✓ Good — clean separation of concerns, easy to tune each tier independently |
| pgmq over external queue (SQS/RabbitMQ) | Keeps everything in Postgres, no extra infra, native pg_cron integration | ✓ Good — simplified ops, DLQ pattern works well |
| Voyage AI for embeddings over OpenAI | Better quality for semantic dedup at competitive pricing | ✓ Good — 1024-dim embeddings with pgvector cosine works cleanly |
| snoowrap for Reddit API | Most mature Node.js Reddit wrapper despite incomplete types | ⚠️ Revisit — types incomplete, required @ts-ignore; consider raw API in v2 |
| Supabase over raw Postgres | Auth, Vault, pgvector, pgmq, pg_cron all in one managed platform | ✓ Good — rapid development, single platform for all needs |
| Next.js 16 proxy over middleware | Newer API replaces deprecated middleware for session gating | ✓ Good — cleaner request interception |
| Forced tool use for Tier 2 | Guarantees structured output from Sonnet without parsing ambiguity | ✓ Good — Zod validation catches malformed outputs reliably |
| Two-consecutive-failure expiry | Avoids false expiry from transient network issues | ✓ Good — WAF detection prevents false positives from 403/429 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-21 after v1.1 milestone start*
