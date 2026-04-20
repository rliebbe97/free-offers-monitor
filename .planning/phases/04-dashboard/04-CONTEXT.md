# Phase 4: Dashboard - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the auth-gated Next.js dashboard with three views: offer list (paginated, filterable, sortable), human review queue (approve/reject actions), and AI call log viewer (cost, latency, prompt version). Requirements: DSH-01, DSH-02, DSH-03, DSH-04. Depends on Phase 1 (DB) and Phase 2 (worker pipeline producing data).

</domain>

<decisions>
## Implementation Decisions

### Auth Integration
- **D-01:** Supabase Auth via `@supabase/ssr` for server-side session management. Middleware checks session on every request and redirects unauthenticated users to `/login`.
- **D-02:** Login page with email/password form using shadcn/ui form components. No social login — email allowlist is the access control mechanism.
- **D-03:** Email allowlist validated server-side after successful Supabase Auth login. If user authenticates but is not on the allowlist, sign them out immediately and display a clear error message on the login page.
- **D-04:** Dashboard uses the Supabase service role key server-side only (via Next.js server components and server actions) — consistent with Phase 1 decision D-06.

### Navigation & Layout
- **D-05:** Fixed sidebar navigation with icon+label for each section: Offers, Review Queue, AI Logs. Standard internal dashboard pattern.
- **D-06:** Minimal header bar with app name ("Free Offers Monitor") and sign-out button.
- **D-07:** Three route groups under `/dashboard/`: `/dashboard/offers`, `/dashboard/review`, `/dashboard/ai-logs`. Root `/` redirects to `/dashboard/offers`.

### Offer List Display
- **D-08:** Server-rendered table using shadcn/ui Table component. Columns: title, source (subreddit), status, destination URL, confidence score, created date.
- **D-09:** Pagination via page numbers in URL search params (`?page=1`). 25 items per page. Server-side pagination with Supabase `.range()`.
- **D-10:** Status filter dropdown (active, expired, all) via URL search param (`?status=active`). Sort by created date, newest first by default.
- **D-11:** All filter/sort/page state lives in URL search params — no client-side state for these. Enables shareable URLs and matches success criteria requirement.

### Review Queue Interaction
- **D-12:** Table of pending review items with inline Approve/Reject buttons per row. No confirmation dialog — single-click action for review speed.
- **D-13:** Approve sets offer status to `active` and removes from `human_review_queue`. Reject sets status to `expired` and removes from queue. Implemented via server actions.
- **D-14:** Expandable table rows showing full context: extracted offer data, AI reasoning/confidence, source post link. Collapsed by default, click to expand.
- **D-15:** No bulk actions for v1 — MOD-01 (bulk approve/reject) is v2 scope.

### AI Call Log Viewer
- **D-16:** Simple sortable table. Columns: timestamp, model, tier, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms.
- **D-17:** Default sorted by timestamp descending. Columns sortable via URL search params.
- **D-18:** No drill-down or expandable rows for v1 — table provides sufficient cost/performance monitoring visibility.

### Claude's Discretion
- Exact shadcn/ui components to use for table, forms, sidebar (e.g., specific Radix primitives)
- Loading states and skeleton patterns for server components
- Empty state design for each view
- Error handling UI patterns (toast, inline, etc.)
- Dark mode support (layout already has dark mode classes)
- Responsive behavior (mobile sidebar collapse pattern)
- Whether to use Next.js parallel routes or simple nested layouts

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Database Schema & Types
- `packages/db/src/schema.sql` — DDL for `offers`, `human_review_queue`, `ai_calls`, `post_offers` tables with all column definitions and indexes
- `packages/db/src/types.ts` — Generated TypeScript types for all tables (Database interface)
- `packages/db/src/client.ts` — `createClient()` factory function

### Prior Phase Decisions
- `.planning/phases/01-db-foundation-shared-package/01-CONTEXT.md` — DB client pattern (D-05, D-06: service role key server-side only for dashboard)
- `.planning/phases/02-worker-pipeline-ingestion-classification-dedup-logging/02-CONTEXT.md` — AI call logging schema (D-19), prompt versioning (D-12), offer creation pipeline
- `.planning/phases/03-offer-validation-cron/03-CONTEXT.md` — Offer status lifecycle (active → check_failed → expired)

### Project Rules
- `CLAUDE.md` — Code style, critical rules, repo structure, dashboard stack (Next.js 14 App Router + shadcn/ui)
- `apps/dashboard/AGENTS.md` — Next.js 16 breaking changes warning — read `node_modules/next/dist/docs/` before writing code

### Requirements
- `.planning/REQUIREMENTS.md` §Dashboard — DSH-01 through DSH-04 full specifications

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/dashboard/components/ui/button.tsx` — shadcn/ui Button component (only UI component installed so far)
- `apps/dashboard/lib/utils.ts` — `cn()` utility for Tailwind class merging
- `apps/dashboard/components.json` — shadcn/ui config: radix-nova style, neutral base color, CSS variables, Lucide icons

### Established Patterns
- Next.js 16 App Router with RSC (rsc: true in components.json)
- Tailwind CSS v4 with PostCSS
- Geist font family (sans + mono) configured in layout.tsx
- shadcn/ui component aliases: `@/components/ui`, `@/lib`, `@/hooks`

### Integration Points
- `apps/dashboard/package.json` — needs `@supabase/supabase-js`, `@supabase/ssr`, and `@repo/db` as dependencies
- `apps/dashboard/app/layout.tsx` — root layout ready for sidebar/nav wrapper
- `apps/dashboard/app/page.tsx` — currently default template, will be replaced with redirect to /dashboard/offers

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for internal dashboard patterns.

</specifics>

<deferred>
## Deferred Ideas

- Bulk approve/reject in review queue — v2 requirement MOD-01
- Offer edit capability — v2 requirement MOD-02
- AI cost tracking dashboard with aggregates — v2 requirement ANL-02
- Real-time notifications — explicitly out of scope for v1

</deferred>

---

*Phase: 04-dashboard*
*Context gathered: 2026-04-20*
