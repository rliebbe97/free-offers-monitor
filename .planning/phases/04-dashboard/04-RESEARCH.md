# Phase 4: Dashboard — Research

**Researched:** 2026-04-20
**Phase:** 04-dashboard
**Requirements:** DSH-01, DSH-02, DSH-03, DSH-04

---

## 1. Critical Next.js 16 Breaking Change: Middleware → Proxy

The `middleware.ts` file convention is **deprecated and renamed to `proxy.ts`** in Next.js 16. The exported function must also be named `proxy`, not `middleware`.

- File: `proxy.ts` at the project root (same level as `app/`)
- Export: `export function proxy(request: NextRequest)` — named export, not default
- Config object with `matcher` remains the same pattern
- Migration codemod available: `npx @next/codemod@canary middleware-to-proxy .`

This is the mechanism for session-based auth redirects. The proxy runs before routes are rendered and reads the session cookie to redirect unauthenticated users to `/login`.

**Critical warning from the Next.js docs:** "Server Functions are not separate routes in this chain. Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone." — Server actions must independently check the session, the proxy is only a first line of defense for page navigation.

---

## 2. Auth Architecture: Supabase SSR + Session Cookie Pattern

### Chosen approach (from D-01 to D-04)
- `@supabase/ssr` for server-side session management
- Login via email/password form → Supabase Auth → session cookie
- Proxy (`proxy.ts`) checks cookie on every request, redirects unauthenticated requests to `/login`
- Email allowlist validation runs server-side after Supabase auth succeeds; non-allowlisted users are signed out immediately with an inline error on the login page
- Service role key used server-side only (server components + server actions)

### Packages not yet installed
Neither `@supabase/ssr` nor `@supabase/supabase-js` are in `apps/dashboard/node_modules`. They must be added to `apps/dashboard/package.json`.

### `@repo/db` client limitation
The existing `packages/db/src/client.ts` creates a generic service role client (`createClient()` with `persistSession: false`). For the dashboard, a second client factory is needed that uses `@supabase/ssr` to handle session cookie reading/writing — the existing factory cannot manage browser-session cookies. The plan needs two Supabase clients:
1. `createClient()` from `@repo/db` — service role, no session, for data reads in server components/actions
2. A new `@supabase/ssr` client (in `apps/dashboard/lib/supabase/`) — anon key for auth flows, SSR session management

### Session cookie pattern (Next.js 16 docs)
`cookies()` from `next/headers` is async — must be `await cookies()`. All session read/write code needs this.

---

## 3. Database Schema — What the Dashboard Queries

### Offer list (DSH-02)
Query `offers` table. Columns available: `id`, `title`, `destination_url`, `status`, `extraction_confidence`, `created_at`, `category`, `brand`, `offer_type`. Source name requires a join through `post_offers` → `posts` → `sources` (for subreddit identifier). Pagination via Supabase `.range(from, to)` with `.count('exact')` for total pages.

Filters: `status` column — values are `'active' | 'expired' | 'unverified' | 'review_pending'`. The UI spec has 4 options: All, Active, Expired, Check Failed. "Check Failed" maps to `status = 'check_failed'` — **note: this value is used in Phase 3's offer lifecycle but does not appear explicitly in the schema DDL's status comment**. The Phase 3 validation cron sets `status = 'check_failed'` after one failure and `status = 'expired'` after two consecutive failures (from Phase 3 context). The plan must handle this value in the filter.

Sort options from UI spec: `created_at DESC` (default), `created_at ASC`, `extraction_confidence DESC`.

### Review queue (DSH-03)
Query `human_review_queue` WHERE `decision IS NULL`. Columns: `id`, `post_id`, `tier2_result` (JSONB), `confidence`, `created_at`. Need to join `posts` to get `url` (source post link) and `tier1_result` (for AI reasoning).

Approve action:
1. Insert into `offers` from `tier2_result` fields, status = `'active'`
2. Insert into `post_offers` linking the post to the new offer
3. Update `human_review_queue` SET `decision = 'approved'`, `reviewer_id = <uid>`, `reviewed_at = now()`

Reject action:
1. Update `human_review_queue` SET `decision = 'rejected'`, `reviewer_id = <uid>`, `reviewed_at = now()`
2. No offer record created

Both are server actions. Must re-check session inside the action (proxy alone is not sufficient). Use `revalidatePath('/dashboard/review')` after mutation to refresh the server component.

### AI call log (DSH-04)
Query `ai_calls` table. All columns: `id`, `tier`, `model`, `prompt_version`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `created_at`, `post_id`, `error`. Default sort `created_at DESC`. Column sort via URL params `?sort=<column>&dir=asc|desc`.

---

## 4. Route Structure & File Layout

Decision D-07 specifies:
- `/` → redirect to `/dashboard/offers`
- `/login` — public, no auth required
- `/dashboard/offers` — auth-gated
- `/dashboard/review` — auth-gated
- `/dashboard/ai-logs` — auth-gated

Recommended App Router layout:

```
apps/dashboard/
├── proxy.ts                          # session check, redirect to /login
├── app/
│   ├── layout.tsx                    # root layout (Geist fonts, html/body)
│   ├── page.tsx                      # redirect → /dashboard/offers
│   ├── login/
│   │   └── page.tsx                  # login form (public)
│   └── dashboard/
│       ├── layout.tsx                # auth check + sidebar/header shell
│       ├── offers/
│       │   └── page.tsx              # offer list (RSC, URL search params)
│       ├── review/
│       │   └── page.tsx              # review queue (RSC + client actions)
│       └── ai-logs/
│           └── page.tsx              # AI call log (RSC, URL search params)
├── lib/
│   ├── supabase/
│   │   ├── server.ts                 # createServerClient() using @supabase/ssr
│   │   └── client.ts                 # createBrowserClient() for login form
│   └── actions/
│       └── review.ts                 # approve/reject server actions
└── components/
    ├── ui/                           # shadcn components (added via npx shadcn add)
    ├── layout/
    │   ├── sidebar.tsx
    │   └── header.tsx
    ├── offers/
    │   ├── offers-table.tsx
    │   ├── offers-filters.tsx
    │   └── offers-pagination.tsx
    ├── review/
    │   ├── review-table.tsx
    │   └── review-row.tsx            # collapsible row with approve/reject
    └── ai-logs/
        └── ai-logs-table.tsx
```

---

## 5. shadcn Components — Installation Required

Currently installed: only `Button`. All others must be added via `npx shadcn add <name>`. From the UI-SPEC.md component inventory:

```
npx shadcn add table badge select pagination sidebar form input label sonner skeleton collapsible separator
```

Note: `sonner` is the toast library. The shadcn `toast` component wraps Sonner. The sidebar component from shadcn is a full feature-complete compound component — review its API before wiring it up as the layout shell (it has Sheet, Trigger, Content, Group, Menu, MenuItem sub-components).

---

## 6. Server Actions & Revalidation Pattern (Next.js 16)

Server functions use `'use server'` directive, not `'use client'`. Pattern:

```ts
// app/lib/actions/review.ts
'use server'
import { revalidatePath } from 'next/cache'

export async function approveReviewItem(id: string) {
  // 1. verify session inside action (mandatory)
  // 2. mutate DB
  // 3. revalidatePath('/dashboard/review')
}
```

For approve/reject actions, the button component must be a Client Component (`'use client'`) that:
- Calls the server action via `startTransition` or by passing it as `action` prop
- Shows a disabled + spinner state while the action is in-flight (`useTransition` hook)
- Displays toast (Sonner) on success/error

After the action succeeds, `revalidatePath` causes the server component to re-render with fresh data, removing the reviewed item from the table without a manual client-side state update.

---

## 7. URL Search Params Pattern (Next.js 16 RSC)

Page components receive `searchParams` as a prop (async in Next.js 16):

```tsx
// app/dashboard/offers/page.tsx
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; sort?: string }>
}) {
  const params = await searchParams;
  const status = params.status ?? 'active';
  const page = Number(params.page ?? '1');
  // fetch data with status/page/sort filters
}
```

**Note:** In Next.js 15+, `searchParams` is a Promise and must be awaited. This is a change from Next.js 14 where it was a plain object. The plan must await `searchParams`.

Filter/sort changes use `<Link>` components with updated `href` query strings, or `router.push()` from a Client Component. The decision (D-11) specifies URL search params for all state — no client-side state for filters/pagination.

---

## 8. Dependencies to Add

`apps/dashboard/package.json` needs:

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2",
    "@supabase/ssr": "^0.5",
    "@repo/db": "workspace:*"
  }
}
```

The `@repo/db` workspace reference gives access to the `Database` types and `createClient()` factory. The dashboard needs its own SSR-aware Supabase client for the login auth flow; the `@repo/db` client (service role, no session) is used for all data queries in server components.

---

## 9. Email Allowlist Implementation

The allowlist must be stored somewhere accessible server-side. Options:
1. Environment variable: `ALLOWED_EMAILS=email1@foo.com,email2@foo.com` — simple, works for small lists, no DB changes needed
2. Supabase table: query at login time — adds complexity

The context (D-03) says "validated server-side after successful Supabase Auth login." The simplest approach for v1 is an env var: `ALLOWED_EMAILS`. The server action after login checks `process.env.ALLOWED_EMAILS?.split(',').includes(user.email)`. If not included, call `supabase.auth.signOut()` and return an error to display on the login page.

---

## 10. `check_failed` Status Value

The schema DDL comment lists: `'active' | 'expired' | 'unverified' | 'review_pending'`. The UI-SPEC status filter includes "Check Failed." Phase 3's validation logic sets offers to `check_failed` after one failed liveness check. The TypeScript types file (`packages/db/src/types.ts`) types `status` as `string`, so there is no type-level gap — but the plan must explicitly handle `status = 'check_failed'` in the filter query. The plan should note this as an implicit value from Phase 3.

---

## 11. Supabase Client Pattern for Dashboard

Two clients needed in `apps/dashboard/lib/supabase/`:

**`server.ts`** — for server components, server actions, proxy:
- Uses `@supabase/ssr` `createServerClient()` with anon key + cookie store from `next/headers`
- For data queries that need RLS bypassed, use service role key (same as `@repo/db`)

**`client.ts`** — for login form client component:
- Uses `@supabase/ssr` `createBrowserClient()` with anon key
- Only used for `signInWithPassword()` and `signOut()` calls

The `proxy.ts` session check uses the SSR server client to read the Supabase auth cookie and verify the session.

---

## 12. Key Gotchas / Risks

1. **`proxy.ts` not `middleware.ts`**: Next.js 16 renamed this. Any code examples from training data using `middleware.ts` / `export function middleware()` will fail silently or be ignored.

2. **`searchParams` is async**: Must `await searchParams` in page components. Forgetting this breaks filter/pagination.

3. **`cookies()` is async**: Must `await cookies()` in server components and actions. Synchronous access throws in Next.js 15+.

4. **Server actions must re-check session**: Proxy is not a security boundary for server actions. Every mutation action must independently verify the session.

5. **`@supabase/ssr` not installed**: Neither `@supabase/supabase-js` nor `@supabase/ssr` are in the dashboard's `node_modules`. The plan must include a dependency installation step.

6. **`revalidatePath` after mutations**: Without explicit `revalidatePath`, server component data will be stale after approve/reject actions. Must be called at the end of each server action.

7. **Approve action must build offer from `tier2_result` JSONB**: The `tier2_result` column in `human_review_queue` is `Json` type. The plan must define how to map fields from `tier2_result` to the `offers` table insert. The structure comes from the Tier 2 Sonnet extraction (Phase 2 output) — fields include `title`, `destination_url`, `brand`, `category`, `offer_type`, `description`, `shipping_cost`, `restrictions`. A `destination_url_hash` must be computed (sha256 of normalized URL) as it is NOT NULL in the schema.

8. **`destination_url_hash` on approve**: The `offers` table requires `destination_url_hash text NOT NULL`. The dashboard approve action must compute this hash. The worker uses a custom redirect-following normalizer before hashing (DDP-01). The dashboard can use a simpler inline sha256 without redirect-following for the review-approved path, since the URL was already normalized by the worker during pipeline processing.

9. **`radix-nova` shadcn style**: The `components.json` uses `style: "radix-nova"` which is a newer preset. `npx shadcn add` will respect this. All component primitives import from `radix-ui` (not `@radix-ui/react-*` individual packages), consistent with the existing Button component which uses `import { Slot } from "radix-ui"`.

10. **No `@repo/db` in dashboard yet**: `apps/dashboard/package.json` does not list `@repo/db` as a dependency. The workspace reference must be added before importing types.

---

## 13. Success Criteria Mapping

| Criterion | Implementation Path |
|-----------|---------------------|
| Unauthenticated redirect to `/login` | `proxy.ts` reads Supabase session cookie; no session → `NextResponse.redirect('/login')` |
| Allowlist rejection | Server action in login form: after `signInWithPassword`, check email against `ALLOWED_EMAILS` env; sign out + return error if not listed |
| Offer list pagination/filter/sort via URL params | RSC page awaits `searchParams`, queries Supabase with `.eq('status', ...)`, `.range()`, `.order()`; filter controls use `<Link>` with updated href |
| Approve → active + out of queue | Server action: insert into `offers` (status=active), insert `post_offers`, update `human_review_queue` decision; `revalidatePath` |
| Reject → expired + out of queue | Server action: update `human_review_queue` decision='rejected'; `revalidatePath` |
| AI call log with cost/latency/prompt_version | RSC page queries `ai_calls` with sort from URL params; table renders all required columns |

---

## 14. Files to Read Before Planning

- `/Users/robyliebbe/Development/Work/free-offers-monitor/apps/dashboard/AGENTS.md` — Next.js 16 breaking changes warning
- `/Users/robyliebbe/Development/Work/free-offers-monitor/packages/db/src/schema.sql` — DDL, column names, nullability
- `/Users/robyliebbe/Development/Work/free-offers-monitor/packages/db/src/types.ts` — TypeScript types for all tables
- `/Users/robyliebbe/Development/Work/free-offers-monitor/packages/db/src/client.ts` — existing service role client factory
- `/Users/robyliebbe/Development/Work/free-offers-monitor/apps/dashboard/package.json` — current deps (missing Supabase packages)
- `/Users/robyliebbe/Development/Work/free-offers-monitor/apps/dashboard/components.json` — shadcn config (radix-nova, aliases)
- `/Users/robyliebbe/Development/Work/free-offers-monitor/apps/dashboard/app/layout.tsx` — root layout (Geist fonts)
- `/Users/robyliebbe/Development/Work/free-offers-monitor/.planning/phases/04-dashboard/04-UI-SPEC.md` — component inventory, copy, layout spec, interaction contracts
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` — proxy.ts API (replaces middleware.ts)
- `node_modules/next/dist/docs/01-app/02-guides/authentication.md` — auth patterns, DAL, session management
- `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md` — server actions / server functions

---

*Research complete: 2026-04-20*
