# Phase 1: DB Foundation & Shared Package - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the Supabase database with all extensions (pgvector, pgmq, pg_cron), deploy the full schema with all 7 tables and prescribed indexes, create pgmq queues, and export a typed shared client from `@repo/db` that all other packages depend on.

</domain>

<decisions>
## Implementation Decisions

### Schema Deployment
- **D-01:** Schema lives as raw SQL in `packages/db/src/schema.sql`, version-controlled in git. No ORM, no migration tool — apply directly via Supabase SQL editor or CLI. Extensions (`CREATE EXTENSION IF NOT EXISTS`) are at the top of the file.
- **D-02:** Schema includes all 7 tables: `sources`, `posts`, `offers`, `post_offers`, `verification_log`, `human_review_queue`, `ai_calls` with all prescribed indexes from the architecture research.

### Type Generation
- **D-03:** TypeScript types generated via Supabase CLI (`npx supabase gen types typescript`) and output to `packages/db/src/types.ts`. The `pnpm db:generate` script automates this.
- **D-04:** Generated types are committed to git so downstream packages don't need Supabase CLI access to build.

### Client Pattern
- **D-05:** `packages/db/src/client.ts` exports a `createClient()` factory function that reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from environment. No singleton — each call creates a fresh client for testability.
- **D-06:** Worker uses the service role key (full access). Dashboard uses the service role key server-side only (via Next.js server components/actions).

### Queue Configuration
- **D-07:** Two pgmq queues: `tier1_queue` (visibility timeout 30s) and `tier2_queue` (visibility timeout 60s, longer for Sonnet calls).
- **D-08:** Queue creation SQL included in `schema.sql` after table definitions.

### Claude's Discretion
- Exact column types and defaults for tables (follow architecture research recommendations)
- Index naming conventions
- Whether to include seed data for the `sources` table

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Database Schema
- `.planning/research/ARCHITECTURE.md` — Full DDL for all 7 tables, indexes, queue creation SQL, and component boundaries
- `.planning/research/STACK.md` — Supabase JS version, pgvector/pgmq configuration notes

### Pitfalls
- `.planning/research/PITFALLS.md` — pgvector extension setup order, pgmq archive pattern, ivfflat probes default

### Project Spec
- `CLAUDE.md` — DB tables, indexes, code style rules, critical rules for the project

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/db/src/index.ts` — Exists with placeholder re-exports, ready to wire up
- `packages/db/package.json` — Already configured with tsup build, `@repo/typescript-config` extension
- `packages/db/tsconfig.json` — Extends shared base config

### Established Patterns
- Monorepo workspace references via `workspace:*` protocol
- tsup for library builds (ESM + DTS)
- TypeScript strict mode, no `any`

### Integration Points
- `apps/worker/package.json` already depends on `@repo/db`
- Root `pnpm db:generate` script defined (needs implementation)

</code_context>

<specifics>
## Specific Ideas

No specific requirements — follow architecture research DDL and standard Supabase patterns.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-db-foundation-shared-package*
*Context gathered: 2026-04-20*
