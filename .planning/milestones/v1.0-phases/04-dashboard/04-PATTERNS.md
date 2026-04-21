# Phase 4: Dashboard — Pattern Map

**Mapped:** 2026-04-20
**Files analyzed:** 22 new/modified files
**Analogs found:** 18 / 22

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/dashboard/proxy.ts` | middleware | request-response | `packages/db/src/client.ts` (env guard pattern) | partial |
| `apps/dashboard/app/page.tsx` | route | request-response | existing `apps/dashboard/app/page.tsx` | exact (replace) |
| `apps/dashboard/app/login/page.tsx` | route + component | request-response | existing `apps/dashboard/app/page.tsx` (RSC shell) | role-match |
| `apps/dashboard/app/dashboard/layout.tsx` | layout | request-response | `apps/dashboard/app/layout.tsx` | exact |
| `apps/dashboard/app/dashboard/offers/page.tsx` | route | CRUD+request-response | `apps/worker/src/validation/validation-loop.ts` (Supabase query pattern) | partial |
| `apps/dashboard/app/dashboard/review/page.tsx` | route | CRUD+request-response | `apps/worker/src/validation/validation-loop.ts` | partial |
| `apps/dashboard/app/dashboard/ai-logs/page.tsx` | route | CRUD+request-response | `apps/worker/src/validation/validation-loop.ts` | partial |
| `apps/dashboard/lib/supabase/server.ts` | utility | request-response | `packages/db/src/client.ts` | role-match |
| `apps/dashboard/lib/supabase/client.ts` | utility | request-response | `packages/db/src/client.ts` | role-match |
| `apps/dashboard/lib/actions/review.ts` | service | CRUD | `apps/worker/src/tiers/tier2.ts` (DB mutation pattern) | role-match |
| `apps/dashboard/components/layout/sidebar.tsx` | component | event-driven | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/components/layout/header.tsx` | component | event-driven | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/components/offers/offers-table.tsx` | component | CRUD | `apps/dashboard/components/ui/button.tsx` (shadcn pattern) | partial |
| `apps/dashboard/components/offers/offers-filters.tsx` | component | event-driven | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/components/offers/offers-pagination.tsx` | component | event-driven | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/components/review/review-table.tsx` | component | CRUD | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/components/review/review-row.tsx` | component | event-driven | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/components/ai-logs/ai-logs-table.tsx` | component | CRUD | `apps/dashboard/components/ui/button.tsx` | partial |
| `apps/dashboard/package.json` | config | — | existing `apps/dashboard/package.json` | exact (modify) |
| `packages/db/src/types.ts` | model | — | existing `packages/db/src/types.ts` | exact (read-only reference) |
| `packages/db/src/client.ts` | utility | — | existing `packages/db/src/client.ts` | exact (read-only reference) |
| `apps/dashboard/app/globals.css` | config | — | existing `apps/dashboard/app/globals.css` | exact (no change) |

---

## Pattern Assignments

### `apps/dashboard/proxy.ts` (middleware, request-response)

**Analog:** `packages/db/src/client.ts` (env guard pattern) + Next.js 16 docs
**Note:** No existing `middleware.ts` / `proxy.ts` in the codebase — this is entirely new. Use research patterns. The file is `proxy.ts`, export is named `proxy` (NOT `middleware`).

**Import pattern** (from Next.js 16 conventions):
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
```

**Core session-check pattern** (Next.js 16 proxy.ts):
```typescript
export function proxy(request: NextRequest) {
  // Must use NextResponse to forward cookies for session refresh
  const response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // Verify session — getUser() makes a server-side call
  const { data: { user } } = await supabase.auth.getUser();

  if (!user && !request.nextUrl.pathname.startsWith('/login')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

**Env guard pattern** (`packages/db/src/client.ts` lines 5–9):
```typescript
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error('SUPABASE_URL environment variable is not set');
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is not set');
```
Apply same pattern for `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — but throw at module load or at runtime with clear messages.

---

### `apps/dashboard/app/page.tsx` (route, redirect)

**Analog:** existing `apps/dashboard/app/page.tsx` (replace entirely)

**Core pattern:**
```typescript
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/dashboard/offers');
}
```

No imports needed beyond `redirect`. Named function, no default export of `Home` — but Next.js page convention requires `export default`. This is the only case where default export is acceptable per Next.js router convention.

---

### `apps/dashboard/app/login/page.tsx` (route, request-response)

**Analog:** `apps/dashboard/app/layout.tsx` (RSC shell structure) + `apps/dashboard/components/ui/button.tsx` (shadcn pattern)

**Import pattern** (`apps/dashboard/app/layout.tsx` lines 1–3):
```typescript
import type { Metadata } from "next";
```
Follow same `import type` style for Next.js metadata.

**Core RSC shell pattern** (`apps/dashboard/app/layout.tsx` lines 15–33):
```typescript
export const metadata: Metadata = {
  title: "Sign in — Free Offers Monitor",
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Login form client component */}
        <LoginForm />
      </div>
    </div>
  );
}
```

**Login form is a Client Component** (separate file e.g. `components/auth/login-form.tsx`) using `'use client'` + `useTransition` + `createBrowserClient()` for `signInWithPassword`.

---

### `apps/dashboard/app/dashboard/layout.tsx` (layout, request-response)

**Analog:** `apps/dashboard/app/layout.tsx`

**Import pattern** (`apps/dashboard/app/layout.tsx` lines 1–4):
```typescript
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
```

**Core layout pattern** (`apps/dashboard/app/layout.tsx` lines 20–33):
```typescript
export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex flex-col h-screen">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
```

**Auth check in layout** — the layout is an RSC, but session verification here is a second defence line after proxy. Use the server Supabase client:
```typescript
import { createServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

// At top of layout function body:
const supabase = await createServerClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) redirect('/login');
```

---

### `apps/dashboard/app/dashboard/offers/page.tsx` (RSC page, CRUD)

**Analog:** `apps/worker/src/validation/validation-loop.ts` (Supabase query with filters)

**Supabase query pattern** (`apps/worker/src/validation/validation-loop.ts` lines 118–122):
```typescript
const { data: dueOffers, error: queryError } = await db
  .from('offers')
  .select('id, destination_url, consecutive_failures')
  .eq('status', 'active')
  .lte('next_check_at', new Date().toISOString());
```

**Adapted for dashboard** — pagination via `.range()`, filters from search params:
```typescript
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; sort?: string }>;
}) {
  const params = await searchParams;  // MUST await — Next.js 16
  const status = params.status ?? 'active';
  const page = Number(params.page ?? '1');
  const PAGE_SIZE = 25;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const db = createClient();  // service role, from @repo/db
  let query = db
    .from('offers')
    .select('id, title, status, destination_url, extraction_confidence, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error, count } = await query;
  // ...render table
}
```

**Error handling pattern** (from tier1.ts lines 95–98):
```typescript
if (queryError) {
  throw new Error(`Failed to fetch offers: ${queryError.message}`);
}
```
In RSC pages, thrown errors bubble to the nearest `error.tsx` boundary.

---

### `apps/dashboard/app/dashboard/review/page.tsx` (RSC page, CRUD)

**Analog:** `apps/worker/src/tiers/tier2.ts` (human_review_queue query)

**Query pattern** — join posts table for source URL and tier1_result:
```typescript
const { data, error } = await db
  .from('human_review_queue')
  .select(`
    id,
    post_id,
    tier2_result,
    confidence,
    created_at,
    posts!inner(url, title, tier1_result)
  `)
  .is('decision', null)
  .order('created_at', { ascending: false });
```

**Type narrowing pattern** (`apps/worker/src/tiers/tier2.ts` lines 159–175):
```typescript
if (!postCheck) {
  throw new Error(`Post not found: ${postId}`);
}
```
Apply same null guard after `.single()` or `.maybeSingle()`.

---

### `apps/dashboard/app/dashboard/ai-logs/page.tsx` (RSC page, CRUD)

**Analog:** `apps/worker/src/validation/validation-loop.ts` (simple Supabase select)

**Sort-from-URL-params pattern** (follows research §7):
```typescript
const params = await searchParams;
const sortCol = params.sort ?? 'created_at';
const sortDir = params.dir === 'asc';

const { data, error } = await db
  .from('ai_calls')
  .select('id, tier, model, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms, created_at, error')
  .order(sortCol, { ascending: sortDir })
  .range(from, to);
```

---

### `apps/dashboard/lib/supabase/server.ts` (utility, request-response)

**Analog:** `packages/db/src/client.ts`

**Existing factory pattern** (`packages/db/src/client.ts` lines 1–17):
```typescript
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types.js';

export function createClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL environment variable is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is not set');

  return createSupabaseClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
```

**Adapted SSR server client** — wraps `@supabase/ssr` with `cookies()` from `next/headers` (async in Next.js 15+):
```typescript
import { createServerClient as createSsrClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@repo/db';

export async function createServerClient() {
  const cookieStore = await cookies();  // MUST await — Next.js 15+

  return createSsrClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    },
  );
}
```

---

### `apps/dashboard/lib/supabase/client.ts` (utility, request-response)

**Analog:** `packages/db/src/client.ts` (factory function pattern)

**Browser client pattern:**
```typescript
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@repo/db';

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```
Used only in the login form Client Component for `signInWithPassword()` and `signOut()`.

---

### `apps/dashboard/lib/actions/review.ts` (service, CRUD)

**Analog:** `apps/worker/src/tiers/tier2.ts` (DB mutation sequence with error handling)

**'use server' + session re-check + mutation pattern** (research §6 + tier2.ts lines 323–335):
```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { createHash } from 'node:crypto';
import { createClient } from '@repo/db';
import { createServerClient } from '@/lib/supabase/server';
import type { Json } from '@repo/db';

export async function approveReviewItem(id: string): Promise<{ error?: string }> {
  // 1. Re-verify session inside action — proxy alone is not a security boundary
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const db = createClient();  // service role for data mutations

  // 2. Fetch the review item
  const { data: item, error: fetchError } = await db
    .from('human_review_queue')
    .select('post_id, tier2_result, confidence')
    .eq('id', id)
    .single();

  if (fetchError || !item) return { error: 'Review item not found' };

  // 3. Extract offer fields from tier2_result JSONB
  const t2 = item.tier2_result as Record<string, Json>;
  const destinationUrl = String(t2['destination_url'] ?? '');

  // 4. Compute URL hash inline (simple sha256, URL already normalized by worker)
  const urlHash = createHash('sha256').update(destinationUrl).digest('hex');

  // 5. Insert offer
  const { data: newOffer, error: insertError } = await db
    .from('offers')
    .insert({
      destination_url: destinationUrl,
      destination_url_hash: urlHash,
      title: String(t2['title'] ?? ''),
      description: t2['description'] ? String(t2['description']) : null,
      brand: t2['brand'] ? String(t2['brand']) : null,
      category: t2['category'] ? String(t2['category']) : null,
      offer_type: t2['offer_type'] ? String(t2['offer_type']) : null,
      shipping_cost: t2['shipping_cost'] ? Number(t2['shipping_cost']) : null,
      restrictions: Array.isArray(t2['restrictions']) ? t2['restrictions'] as string[] : null,
      extraction_confidence: item.confidence,
      status: 'active',
    })
    .select('id')
    .single();

  if (insertError || !newOffer) return { error: 'Failed to create offer' };

  // 6. Insert post_offers join
  await db.from('post_offers').insert({
    post_id: item.post_id,
    offer_id: newOffer.id,
  });

  // 7. Update review queue record
  await db
    .from('human_review_queue')
    .update({
      decision: 'approved',
      reviewer_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  revalidatePath('/dashboard/review');
  return {};
}

export async function rejectReviewItem(id: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const db = createClient();

  const { error } = await db
    .from('human_review_queue')
    .update({
      decision: 'rejected',
      reviewer_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) return { error: 'Failed to reject item' };

  revalidatePath('/dashboard/review');
  return {};
}
```

**URL hash pattern** (`apps/worker/src/dedup/url-hash.ts` lines 1–2, 87–89):
```typescript
import { createHash } from 'node:crypto';
// ...
const hash = createHash('sha256').update(normalizedUrl).digest('hex');
```
Dashboard approve action uses the same `node:crypto` sha256, but without redirect-following since the URL was already normalized by the worker during pipeline processing.

---

### `apps/dashboard/components/ui/button.tsx` (reference — already exists)

**This file is the canonical shadcn component pattern.** All new shadcn components must follow its conventions:

**Import pattern** (`apps/dashboard/components/ui/button.tsx` lines 1–5):
```typescript
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
```

**Key conventions:**
- Import `Slot` from `"radix-ui"` (not `"@radix-ui/react-slot"`) — radix-nova style uses the unified `radix-ui` package
- Use `cn()` from `@/lib/utils` for all className merging
- Named export only (no default export): `export { Button, buttonVariants }`
- `data-slot` attribute on root element for styling hooks

**cn() utility** (`apps/dashboard/lib/utils.ts` lines 1–6):
```typescript
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

---

### `apps/dashboard/components/layout/sidebar.tsx` (component, event-driven)

**Analog:** `apps/dashboard/components/ui/button.tsx` (shadcn component conventions)
**Additional reference:** shadcn sidebar compound component API (install via `npx shadcn add sidebar`)

**Import pattern** (follows button.tsx conventions):
```typescript
'use client';  // sidebar uses state for active route highlighting

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LayoutDashboard, ClipboardList, Bot } from 'lucide-react';
```

**Active route pattern:**
```typescript
const pathname = usePathname();
const isActive = pathname.startsWith(href);

<Link
  href={href}
  className={cn(
    'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
    isActive
      ? 'border-l-2 border-primary bg-accent text-foreground font-semibold'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted',
  )}
>
```

---

### `apps/dashboard/components/layout/header.tsx` (component, event-driven)

**Analog:** `apps/dashboard/components/ui/button.tsx`

**Sign-out pattern** (Client Component — uses browser Supabase client):
```typescript
'use client';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export function Header() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  return (
    <header className="h-14 border-b flex items-center px-4 justify-between">
      <span className="font-semibold text-sm">Free Offers Monitor</span>
      <Button variant="ghost" size="sm" onClick={handleSignOut}>
        Sign out
      </Button>
    </header>
  );
}
```

---

### `apps/dashboard/components/offers/offers-table.tsx` (component, CRUD)

**Analog:** shadcn Table component + `apps/dashboard/components/ui/button.tsx` (conventions)

**Import pattern** (follows shadcn conventions):
```typescript
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';
import type { Offer } from '@repo/db';
```

**Status badge color pattern** (from UI-SPEC.md color section):
```typescript
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'check_failed':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'expired':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
  }
}
```

**Confidence highlight pattern:**
```typescript
<TableCell className={cn(
  'font-mono text-xs',
  confidence < 0.7 ? 'text-amber-600' : '',
)}>
  {confidence?.toFixed(2) ?? '—'}
</TableCell>
```

---

### `apps/dashboard/components/review/review-row.tsx` (component, event-driven)

**Analog:** `apps/dashboard/components/ui/button.tsx` (Client Component with useTransition)

**Server action call + useTransition pattern** (from research §6):
```typescript
'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { approveReviewItem, rejectReviewItem } from '@/lib/actions/review';

export function ReviewRow({ item }: { item: HumanReviewItem }) {
  const [isPending, startTransition] = useTransition();

  function handleApprove() {
    startTransition(async () => {
      const result = await approveReviewItem(item.id);
      if (result.error) {
        toast.error('Action failed. Please try again.');
      } else {
        toast.success('Offer approved and published.');
      }
    });
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectReviewItem(item.id);
      if (result.error) {
        toast.error('Action failed. Please try again.');
      } else {
        toast.success('Offer rejected.');
      }
    });
  }

  return (
    // ...
    <Button variant="default" size="sm" disabled={isPending} onClick={handleApprove}>
      {isPending ? <Loader2 className="size-4 animate-spin" /> : 'Approve'}
    </Button>
    <Button variant="outline" size="sm" disabled={isPending} onClick={handleReject}>
      Reject
    </Button>
  );
}
```

---

### `apps/dashboard/components/ai-logs/ai-logs-table.tsx` (component, CRUD)

**Analog:** shadcn Table + button.tsx conventions

**Monospace formatting pattern** (from UI-SPEC typography):
```typescript
// prompt_version: first 7 chars, Geist Mono
<TableCell className="font-mono text-xs">
  {row.prompt_version.slice(0, 7)}
</TableCell>

// cost_usd: 6 decimal places
<TableCell className="font-mono text-xs">
  ${row.cost_usd.toFixed(6)}
</TableCell>

// latency_ms: integer + ms suffix
<TableCell className="font-mono text-xs">
  {row.latency_ms}ms
</TableCell>
```

**Sortable column header pattern** — updates URL search params:
```typescript
import Link from 'next/link';

function SortableHeader({ column, label, currentSort, currentDir }: ...) {
  const nextDir = currentSort === column && currentDir === 'desc' ? 'asc' : 'desc';
  return (
    <TableHead>
      <Link href={`?sort=${column}&dir=${nextDir}`} className="flex items-center gap-1">
        {label}
        {/* ChevronUp/ChevronDown icon based on currentSort === column */}
      </Link>
    </TableHead>
  );
}
```

---

### `apps/dashboard/package.json` (config, modify)

**Analog:** existing `apps/dashboard/package.json`

**Dependencies to add** (from research §8):
```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2",
    "@supabase/ssr": "^0.5",
    "@repo/db": "workspace:*"
  }
}
```

---

## Shared Patterns

### Named Export Convention
**Source:** `apps/dashboard/components/ui/button.tsx` line 67, `packages/db/src/client.ts` line 4, `apps/worker/src/tiers/tier1.ts` line 85
**Apply to:** All new files
```typescript
// CORRECT — named export
export function MyComponent() { ... }
export { MyComponent }

// WRONG — never use default exports except where Next.js forces it (page.tsx, layout.tsx)
export default function MyComponent() { ... }
```

### Supabase Error Handling
**Source:** `apps/worker/src/tiers/tier1.ts` lines 95–97, `apps/worker/src/tiers/tier2.ts` lines 160–162
**Apply to:** All data-fetching RSC pages and server actions
```typescript
const { data, error } = await db.from('table').select(...);
if (error) {
  throw new Error(`Failed to fetch [resource]: ${error.message}`);
}
if (!data) {
  throw new Error('[Resource] not found');
}
```

### Import from @repo/db
**Source:** `apps/worker/src/tiers/tier1.ts` lines 2–3, `apps/worker/src/tiers/tier2.ts` lines 2–3
**Apply to:** All server-side data queries in the dashboard
```typescript
import type { createClient } from '@repo/db';
import type { Json } from '@repo/db';
import type { Offer, HumanReviewItem, AiCall } from '@repo/db';
```
The `@repo/db` package exports `createClient` (service role factory) and all typed row aliases (`Offer`, `HumanReviewItem`, `AiCall`, etc.).

### TypeScript Strict — No `any`
**Source:** CLAUDE.md "Code Style" section
**Apply to:** All new files
```typescript
// CORRECT
const t2 = item.tier2_result as Record<string, Json>;

// WRONG
const t2 = item.tier2_result as any;
```

### cn() for className merging
**Source:** `apps/dashboard/lib/utils.ts` lines 1–6, `apps/dashboard/components/ui/button.tsx` line 8
**Apply to:** All React component files
```typescript
import { cn } from '@/lib/utils';
// Usage:
className={cn('base-classes', condition && 'conditional-class', props.className)}
```

### shadcn Radix Import Convention
**Source:** `apps/dashboard/components/ui/button.tsx` line 3
**Apply to:** All shadcn component additions
```typescript
// CORRECT — unified radix-ui package (radix-nova style)
import { Slot } from "radix-ui"

// WRONG — individual @radix-ui/* packages
import { Slot } from "@radix-ui/react-slot"
```

### Supabase Query Pattern — Select with Count
**Source:** `apps/worker/src/validation/validation-loop.ts` lines 118–122
**Apply to:** All paginated RSC pages (offers, ai-logs)
```typescript
const { data, error, count } = await db
  .from('offers')
  .select('id, title, status', { count: 'exact' })
  .eq('status', status)
  .order('created_at', { ascending: false })
  .range(from, to);
```
`count` is total rows matching the filter (ignoring `.range()`), needed to compute total pages.

### Server Action Return Type
**Source:** research §6 + tier2.ts mutation pattern
**Apply to:** `apps/dashboard/lib/actions/review.ts`
```typescript
// Return discriminated result, never throw from server actions — client needs to handle errors
export async function approveReviewItem(id: string): Promise<{ error?: string }> {
  // ...
  return {};           // success
  return { error: 'message' };  // failure
}
```

---

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md patterns + Next.js docs):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/dashboard/proxy.ts` | middleware | request-response | No middleware/proxy exists in codebase. Next.js 16 `proxy.ts` is entirely new pattern. |
| `apps/dashboard/app/login/page.tsx` (form subcomponent) | component | request-response | No auth forms exist. Login form is new — uses `@supabase/ssr` `createBrowserClient` + `useTransition`. |
| `apps/dashboard/components/offers/offers-pagination.tsx` | component | event-driven | No pagination component exists. Use shadcn `pagination` + Link-based URL param pattern. |

---

## Metadata

**Analog search scope:** `apps/dashboard/`, `apps/worker/src/`, `packages/db/src/`
**Files scanned:** 25
**Pattern extraction date:** 2026-04-20

### Critical Reminders for Planner

1. **`proxy.ts` not `middleware.ts`** — Next.js 16 breaking change. Export named `proxy`, not `middleware`.
2. **`searchParams` is async** — `const params = await searchParams` in every page component.
3. **`cookies()` is async** — `const cookieStore = await cookies()` in server.ts Supabase client.
4. **Server actions must re-check session** — proxy is not a security boundary for mutations.
5. **`@supabase/ssr` not installed** — plan must add `@supabase/supabase-js` and `@supabase/ssr` to `apps/dashboard/package.json` and run `pnpm install`.
6. **`@repo/db` not in dashboard deps yet** — must add `"@repo/db": "workspace:*"` to `apps/dashboard/package.json`.
7. **`destination_url_hash` required on approve** — use `createHash('sha256').update(url).digest('hex')` from `node:crypto` in the approve server action.
8. **`check_failed` status value** — valid status from Phase 3 validation cron; must be handled in the status filter even though it is not in the schema DDL comment.
9. **radix-nova shadcn style** — import from `"radix-ui"` (unified), not `"@radix-ui/react-*"` individual packages.
10. **`revalidatePath` after mutations** — required in both `approveReviewItem` and `rejectReviewItem` to refresh the RSC after the server action completes.
