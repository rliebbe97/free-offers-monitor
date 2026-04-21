---
plan: 04-01
phase: 04-dashboard
status: complete
completed_at: 2026-04-21
---

# Plan 04-01 Summary — Dashboard Auth Infrastructure & Shell Layout

## What Was Built

Three tasks executed atomically, each committed individually:

### Task 1: Dependencies and shadcn UI components
- Added `@supabase/ssr ^0.5`, `@supabase/supabase-js ^2`, `@repo/db workspace:*`, and `sonner ^2` to `apps/dashboard/package.json`
- Installed 13 shadcn components: `table`, `badge`, `select`, `pagination`, `sidebar`, `form`, `input`, `label`, `sonner`, `skeleton`, `collapsible`, `separator`, plus `tooltip` and `sheet` (pulled in as transitive deps)
- Workaround: shadcn CLI uses npm internally and cannot resolve `workspace:*` protocol — temporarily removed `@repo/db` from package.json during shadcn add, then restored it

### Task 2: Supabase client factories, proxy.ts, and login page
- `apps/dashboard/lib/supabase/server.ts` — async SSR server client using `await cookies()` (Next.js 15+ async cookies API)
- `apps/dashboard/lib/supabase/client.ts` — browser client via `createBrowserClient`
- `apps/dashboard/proxy.ts` — Next.js 16 `proxy` export (replaces deprecated `middleware`), redirects unauthenticated requests to `/login` and authenticated users away from `/login`
- `apps/dashboard/app/page.tsx` — root redirects to `/dashboard/offers`
- `apps/dashboard/app/login/page.tsx` — centered login card with metadata
- `apps/dashboard/components/auth/login-form.tsx` — client component with `useTransition`, email/password fields, Loader2 spinner
- `apps/dashboard/lib/actions/auth.ts` — server action `validateEmailAllowlist` that checks `process.env.ALLOWED_EMAILS` server-side and signs out unauthorized users

### Task 3: Dashboard layout shell
- `apps/dashboard/app/layout.tsx` — updated title/description, added `<Toaster />` from sonner
- `apps/dashboard/app/dashboard/layout.tsx` — async server component with defense-in-depth auth check, renders `<Header>` + `<Sidebar>` + content area
- `apps/dashboard/components/layout/sidebar.tsx` — client component, fixed 240px sidebar, `usePathname` for active state, nav items: Offers/Review Queue/AI Logs with Lucide icons, hidden below `md` breakpoint
- `apps/dashboard/components/layout/header.tsx` — client component, app name + sign-out button via browser Supabase client

## Issues Encountered

- **TypeScript strict mode**: `cookiesToSet` parameter in `setAll` callbacks was implicitly `any`. Fixed by importing `CookieOptions` from `@supabase/ssr` and adding explicit type annotation `{ name: string; value: string; options: CookieOptions }[]` in both `server.ts` and `proxy.ts`.
- **shadcn CLI npm conflict**: shadcn's `add` command internally uses npm which cannot resolve `workspace:*` protocol. Solved by temporarily removing `@repo/db` from package.json during shadcn add, then restoring with pnpm.

## Verification

- `pnpm build --filter dashboard` passes cleanly with no TypeScript errors
- All acceptance criteria for all three tasks verified with grep checks
- Build output confirms proxy (middleware) is registered and `/login` route renders as static
