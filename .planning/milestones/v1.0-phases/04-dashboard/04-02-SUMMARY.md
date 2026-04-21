---
plan: 04-02
phase: 04-dashboard
status: complete
completed_at: 2026-04-21
---

# Plan 04-02 Summary — Data Views: Offers, Review Queue, AI Call Log

## What Was Built

Three tasks executed atomically, each committed individually.

### Task 1: Offer List Page (`/dashboard/offers`)

- `apps/dashboard/app/dashboard/offers/page.tsx` — RSC page with `await searchParams` (Next.js 15+ Promise API), status filter (all/active/expired/check_failed defaulting to 'active'), sort (newest/oldest/confidence), and 25-per-page pagination via Supabase `.range(from, to)` with `count: 'exact'`
- `apps/dashboard/components/offers/offers-table.tsx` — Server Component table with status badges (green/amber/muted/blue per UI-SPEC), ExternalLink icon, confidence in monospace with amber coloring below 0.70, URL truncated to 40 chars
- `apps/dashboard/components/offers/offers-filters.tsx` — `'use client'` component with two shadcn Select dropdowns for status and sort; on change builds new URLSearchParams preserving the other control, resets page to 1, calls `router.push()`
- `apps/dashboard/components/offers/offers-pagination.tsx` — `'use client'` component using shadcn Pagination with ellipsis logic (shows first, last, ±2 around current), preserves existing search params via `useSearchParams()`

### Task 2: Review Queue Page (`/dashboard/review`)

- `apps/dashboard/lib/actions/review.ts` — `'use server'` file with two named exports:
  - `approveReviewItem(id)`: re-verifies session via `createServerClient().auth.getUser()`, fetches queue item, casts JSONB fields with `String()`/`Number()`, recomputes SHA-256 URL hash server-side, inserts offer with `status: 'active'`, links `post_offers`, updates queue `decision: 'approved'`, calls `revalidatePath` for both `/dashboard/review` and `/dashboard/offers`
  - `rejectReviewItem(id)`: identical flow but inserts offer with `status: 'expired'` and sets `decision: 'rejected'`
- `apps/dashboard/app/dashboard/review/page.tsx` — RSC page querying `human_review_queue` with `posts!inner` join, `.is('decision', null)` to show only pending items; typed `RawReviewItem` to avoid implicit-any on Supabase join result
- `apps/dashboard/components/review/review-table.tsx` — Server Component table shell passing items to `ReviewRow`
- `apps/dashboard/components/review/review-row.tsx` — `'use client'` component with `useTransition` for pending state, `useState` for expand/collapse, Approve (primary) and Reject (outline) buttons disabled + Loader2 spinner during in-flight action, expandable detail panel showing extracted offer fields, confidence, AI reasoning (from `tier1_result.reason`), and source post link

### Task 3: AI Call Log Page (`/dashboard/ai-logs`)

- `apps/dashboard/app/dashboard/ai-logs/page.tsx` — RSC page with `await searchParams`, sort column validated against allowlist of 7 permitted column names (injection mitigation T-04-09), sort direction defaulting to descending, 25-per-page pagination reusing `OffersPagination`
- `apps/dashboard/components/ai-logs/ai-logs-table.tsx` — Server Component with sortable column headers rendered as `next/link` `<Link>` elements that toggle direction; all 8 required columns: Time (toLocaleString), Model, Tier, Input Tokens, Output Tokens, Cost USD (toFixed(6) with `$` prefix), Latency (integer with `ms` suffix), Prompt Version (slice(0,7) in monospace)

## Issues Encountered

- **Supabase join implicit-any**: The hand-written `Database` types in `packages/db/src/types.ts` have empty `Relationships: []` arrays, so Supabase's query builder cannot infer the joined `posts` shape. Fixed by defining a local `RawReviewItem` type and casting `data as RawReviewItem[]` in `review/page.tsx`.
- **Node_modules not in worktree**: The worktree has no `node_modules` — dependencies are hoisted to the main project root via pnpm workspaces. TypeScript checks run through the main project's turbo pipeline, not locally.

## Verification

All acceptance criteria pass:

- Task 1: `await searchParams`, `from('offers')`, `count: 'exact'`, `PAGE_SIZE = 25`, `range(from, to)`, `TableRow`, `bg-green-100`, `bg-amber-100`, `ExternalLink`, `toFixed(2)`, `'use client'` on filters, `check_failed`, `SelectItem`, `'use client'` on pagination, `PaginationLink`
- Task 2: `'use server'`, `approveReviewItem`, `rejectReviewItem`, `createHash('sha256')`, `destination_url_hash: urlHash`, `auth.getUser()`, `revalidatePath('/dashboard/review')`, `revalidatePath('/dashboard/offers')`, `status: 'active'`, `decision: 'rejected'`, `status: 'expired'`, `human_review_queue`, `is('decision', null)`, `'use client'` on row, `useTransition`, `toast.success`, `Offer approved and published.`, `Offer rejected.`, `Offer Details`
- Task 3: `await searchParams`, `from('ai_calls')`, `count: 'exact'`, `order(sortCol`, `cost_usd`, `toFixed(6)`, `latency_ms`, `slice(0, 7)`, `font-mono`, `ChevronUp`/`ChevronDown`, `sort=`

## Threat Mitigations Applied

- **T-04-07** (Spoofing): Both server actions call `createServerClient().auth.getUser()` independently before any mutation
- **T-04-08** (Tampering): All JSONB fields cast with `String()`/`Number()`; `destination_url_hash` recomputed server-side from the extracted URL
- **T-04-09** (Injection): Sort column validated against `ALLOWED_SORT_COLS` allowlist; invalid values default to `'created_at'`
- **T-04-11** (DoS): All queries use `.range(from, to)` with `PAGE_SIZE = 25`; page clamped to minimum 1
