# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-04-21
**Phases:** 4 | **Plans:** 7

### What Was Built
- Full Supabase DB foundation with pgvector, pgmq, pg_cron extensions and 7 tables with typed shared client
- End-to-end Reddit ingestion pipeline with three-tier AI classification (keyword -> Haiku -> Sonnet)
- URL hash + Voyage embedding dedup pipeline with pgvector cosine similarity
- Offer validation cron with HEAD/GET liveness, Cheerio dead signals, two-failure expiry
- Auth-gated Next.js dashboard with offer list, review queue, and AI call log viewer

### What Worked
- Coarse-grained phasing (4 phases for full MVP) kept planning overhead minimal while delivering complete features per phase
- pgmq consumer pattern with shouldArchive/finally-block archive and DLQ routing proved clean and reusable across Tier 1, Tier 2, and validation loops
- Forced tool use for Tier 2 Sonnet extraction eliminated parsing ambiguity — Zod validation catches malformed outputs reliably
- Separating runValidationCycle from runValidationLoop enabled clean unit testing without fighting while-loop timing

### What Was Inefficient
- Hand-written DB types required multiple patches (Relationships arrays, pgmq RPC types, pgmq_create) — `pnpm db:generate` against a live schema would have avoided this
- REQUIREMENTS.md traceability table was never updated during phase execution (all stayed "Pending") — automating status updates at phase completion would keep it accurate
- shadcn CLI npm conflict with pnpm workspace:* protocol required a manual workaround each time

### Patterns Established
- pgmq consumer: read -> process -> shouldArchive flag -> archive in finally block -> DLQ after 3 retries
- Validation cycle/loop separation for testability
- WAF detection (403/429) as distinct from real failures — prevents false expiry
- Server action session re-verification independent of proxy (defense-in-depth)
- Sort column allowlist for SQL injection prevention on dynamic order-by

### Key Lessons
1. Write DB type stubs with Relationships arrays from the start — postgrest-js requires them and the error manifests as `never` types deep in query chains
2. Vitest config needs dummy env vars when config modules validate at import time — discovered during Phase 3
3. snoowrap types are genuinely incomplete — plan for @ts-ignore and consider raw Reddit API for v2

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 4 | 7 | Initial MVP — coarse-grained phases with 1-3 plans each |

### Cumulative Quality

| Milestone | Tests | Key Metric |
|-----------|-------|------------|
| v1.0 | 13 | Validation module fully tested; dashboard code-verified 12/12 |

### Top Lessons (Verified Across Milestones)

1. Hand-written Supabase types diverge quickly — generate from live schema early
2. pgmq consumer pattern is reusable and reliable — keep shouldArchive/finally/DLQ pattern
