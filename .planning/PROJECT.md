# Free Offers Monitor

## What This Is

An automated pipeline that scans Reddit and forums for genuinely free physical goods offerings for new mothers and families with babies. It uses a three-tier AI classification system (keyword filter, Haiku classifier, Sonnet extractor) with deduplication via URL hashing and Voyage embeddings, surfacing verified offers through a dashboard.

## Core Value

Reliably surface genuinely free physical goods (zero shipping, no coupons, no trials, no sweepstakes) from noisy forum data — false negatives cost missed offers, false positives erode trust.

## Requirements

### Validated

- [x] Offer validation cron (URL liveness + dead signal detection) — Validated in Phase 3: Offer Validation Cron

### Active

- [ ] Reddit ingestion pipeline polls subreddits and extracts posts with comments
- [ ] Tier 0 keyword filter with high-recall hand-maintained list
- [ ] Tier 1 Haiku binary classifier via pgmq worker
- [ ] Tier 2 Sonnet structured extraction with exclusion checks via pgmq worker
- [ ] Deduplication via URL hash matching and Voyage embedding cosine similarity
- [ ] Dashboard with auth-gated offer list, status, and human review queue
- [ ] All AI calls logged with tokens, cost, latency, prompt version
- [ ] Low-confidence Tier 2 results route to human review queue

### Out of Scope

- Discourse/forum adapters beyond Reddit — deferred to future milestone
- Mobile app — web dashboard first
- Public-facing UI — internal/allowlist auth only
- Auto-adding keywords to Tier 0 — human decides, system only suggests
- Real-time notifications — polling-based dashboard is sufficient for v1

## Context

- Monorepo already scaffolded: pnpm workspaces + Turborepo
- Dashboard app exists (Next.js 14 App Router + shadcn/ui, deploying to Vercel)
- Worker app scaffolded (Node.js/TypeScript, deploying to Railway)
- Shared `@repo/db` package scaffolded for Supabase client + types
- Database: Supabase (Postgres + pgvector + pgmq + pg_cron)
- AI: `@anthropic-ai/sdk` directly — no LangChain, no Vercel AI SDK
- Embeddings: Voyage AI, 1024-dim vectors in pgvector
- Reddit: snoowrap (types are incomplete, expect `@ts-ignore` on some responses)
- Queue: pgmq (Postgres-native, messages need explicit `archive()`)
- Auth: Supabase Auth with email allowlist
- Testing: Vitest

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
| Three-tier classification (keyword → Haiku → Sonnet) | Balances cost and accuracy — cheap filter first, expensive extraction only on candidates | — Pending |
| pgmq over external queue (SQS/RabbitMQ) | Keeps everything in Postgres, no extra infra, native pg_cron integration | — Pending |
| Voyage AI for embeddings over OpenAI | Better quality for semantic dedup at competitive pricing | — Pending |
| snoowrap for Reddit API | Most mature Node.js Reddit wrapper despite incomplete types | — Pending |
| Supabase over raw Postgres | Auth, Vault, pgvector, pgmq, pg_cron all in one managed platform | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-20 after Phase 3 completion*
