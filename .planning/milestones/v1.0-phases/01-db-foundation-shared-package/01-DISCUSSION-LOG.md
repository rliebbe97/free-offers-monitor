# Phase 1: DB Foundation & Shared Package - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-20
**Phase:** 1-DB Foundation & Shared Package
**Areas discussed:** Schema deployment, Type generation, Client pattern, Queue config
**Mode:** --auto (all decisions auto-selected)

---

## Schema Deployment

| Option | Description | Selected |
|--------|-------------|----------|
| Raw SQL in schema.sql | Version-controlled, no ORM, apply via Supabase CLI/editor | ✓ |
| Migration tool (e.g., dbmate) | Incremental migrations with up/down | |
| Supabase dashboard only | Manual schema management | |

**User's choice:** [auto] Raw SQL in schema.sql (recommended default)
**Notes:** Matches CLAUDE.md project spec. Architecture research provides full DDL.

---

## Type Generation

| Option | Description | Selected |
|--------|-------------|----------|
| Supabase CLI codegen | `npx supabase gen types typescript`, automated via pnpm script | ✓ |
| Hand-maintained types | Manual TypeScript interfaces | |
| Schema-first with Zod | Zod schemas as source of truth | |

**User's choice:** [auto] Supabase CLI codegen (recommended default)
**Notes:** Standard Supabase workflow. Types committed to git for downstream builds.

---

## Client Pattern

| Option | Description | Selected |
|--------|-------------|----------|
| Factory function createClient() | Reads env vars, fresh client per call, testable | ✓ |
| Singleton module | Single client instance, simpler but harder to test | |
| Context-based (React) | Provider pattern for dashboard | |

**User's choice:** [auto] Factory function createClient() (recommended default)
**Notes:** Worker and dashboard both use service role key. Factory allows test injection.

---

## Queue Config

| Option | Description | Selected |
|--------|-------------|----------|
| 30s/60s visibility timeouts | 30s for tier1 (Haiku fast), 60s for tier2 (Sonnet slower) | ✓ |
| Uniform 60s | Same timeout for both queues | |
| Configurable via env | Timeout values from environment variables | |

**User's choice:** [auto] 30s/60s visibility timeouts (recommended default)
**Notes:** Per architecture research recommendations. Tier 2 needs longer due to Sonnet latency.

---

## Claude's Discretion

- Exact column types and defaults
- Index naming conventions
- Seed data for sources table

## Deferred Ideas

None — discussion stayed within phase scope.
