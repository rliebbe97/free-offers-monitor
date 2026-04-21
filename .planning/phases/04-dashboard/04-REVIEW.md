---
phase: 04-dashboard
reviewed: 2026-04-20T00:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - apps/dashboard/app/dashboard/ai-logs/page.tsx
  - apps/dashboard/app/dashboard/layout.tsx
  - apps/dashboard/app/dashboard/offers/page.tsx
  - apps/dashboard/app/dashboard/review/page.tsx
  - apps/dashboard/app/layout.tsx
  - apps/dashboard/app/login/page.tsx
  - apps/dashboard/app/page.tsx
  - apps/dashboard/components/ai-logs/ai-logs-table.tsx
  - apps/dashboard/components/auth/login-form.tsx
  - apps/dashboard/components/layout/header.tsx
  - apps/dashboard/components/layout/sidebar.tsx
  - apps/dashboard/components/offers/offers-filters.tsx
  - apps/dashboard/components/offers/offers-pagination.tsx
  - apps/dashboard/components/offers/offers-table.tsx
  - apps/dashboard/components/review/review-row.tsx
  - apps/dashboard/components/review/review-table.tsx
  - apps/dashboard/lib/actions/auth.ts
  - apps/dashboard/lib/actions/review.ts
  - apps/dashboard/lib/supabase/client.ts
  - apps/dashboard/lib/supabase/server.ts
  - apps/dashboard/proxy.ts
  - apps/dashboard/package.json
findings:
  critical: 3
  warning: 3
  info: 2
  total: 8
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-04-20T00:00:00Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Reviewed the full dashboard package: Next.js App Router pages, layout/auth guards, review queue action handlers, Supabase client wrappers, and middleware proxy. The overall structure is clean — server-side auth guards, no default exports, and correct use of `@anthropic-ai/sdk` patterns from CLAUDE.md are all respected. Three critical issues require fixes before the dashboard handles real data: a logic bug in `rejectReviewItem` that inserts offers on rejection, a missing allowlist check in middleware that allows allowlisted-bypass, and a `javascript:` URL injection vector in the review panel. Three warnings cover silent auth-error swallowing, a missing null guard on `prompt_version`, and an absent validation on `ALLOWED_EMAILS` env var. Two informational items cover code duplication and unsafe URL rendering in the offers table.

---

## Critical Issues

### CR-01: `rejectReviewItem` creates an offer record — reject should not persist an offer

**File:** `apps/dashboard/lib/actions/review.ts:100-122`
**Issue:** `rejectReviewItem` runs the same offer-insert block as `approveReviewItem` (lines 100–118), inserting a new row into `offers` with `status: 'expired'`. A rejection decision means the AI extraction was wrong or the item is not a legitimate offer — inserting an `expired` offer pollutes the offers table with junk data, inflates counts, and can trigger validation jobs unnecessarily. The function should only stamp the `human_review_queue` row with `decision: 'rejected'` and skip the offer + post_offers inserts entirely.

**Fix:**
```typescript
export async function rejectReviewItem(id: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const db = createClient();

  // No offer insert on rejection — just mark the review item.
  const { error: updateError } = await db
    .from('human_review_queue')
    .update({
      decision: 'rejected',
      reviewer_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) return { error: 'Failed to reject item' };

  revalidatePath('/dashboard/review');
  return {};
}
```

---

### CR-02: Middleware (`proxy.ts`) does not enforce email allowlist — allowlist check is login-only

**File:** `apps/dashboard/proxy.ts:42-53`
**Issue:** The middleware only checks `user !== null` (i.e. has a valid Supabase session) before granting access to dashboard routes. The `ALLOWED_EMAILS` allowlist is verified only during the login flow via `validateEmailAllowlist()` in `login-form.tsx`. A user who signs up via Supabase directly (or whose session pre-dates the allowlist) retains full dashboard access without re-validation. The middleware is the last line of defence — it must also verify the allowlist.

**Fix:** Add an allowlist check inside the middleware after confirming `user`:
```typescript
// proxy.ts — after const { data: { user } } = await supabase.auth.getUser();

if (user && !pathname.startsWith('/login')) {
  const allowedEmails =
    process.env.ALLOWED_EMAILS?.split(',').map((e) => e.trim()) ?? [];
  // If allowlist is configured, enforce it
  if (allowedEmails.length > 0 && !allowedEmails.includes(user.email ?? '')) {
    await supabase.auth.signOut();
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
}
```

---

### CR-03: `javascript:` URL injection via AI-extracted `destination_url` in review panel

**File:** `apps/dashboard/components/review/review-row.tsx:160-163`
**Issue:** `destinationUrl` is extracted directly from `tier2_result` JSONB (an AI-generated value) and placed into an `<a href>` without protocol validation. If the AI extracts or is manipulated into producing a `javascript:` URL, clicking the link executes arbitrary script in the reviewer's browser session. This is particularly dangerous in the human review panel where a reviewer is logged in with write-level permissions.

The same pattern exists in `offers-table.tsx:70-77` for `offer.destination_url` (see WR-03) but is lower severity there because offers are post-dedup and post-approval.

**Fix:** Sanitize the URL before rendering:
```typescript
// In review-row.tsx, replace the destinationUrl derivation:
const rawUrl = t2['destination_url'] ? String(t2['destination_url']) : null;
const destinationUrl =
  rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
```
Apply the same guard before rendering `href` in `offers-table.tsx`.

---

## Warnings

### WR-01: `getUser()` auth error silently ignored in `DashboardLayout`

**File:** `apps/dashboard/app/dashboard/layout.tsx:13-17`
**Issue:** The destructure `const { data: { user } } = await supabase.auth.getUser()` discards the `error` field. If `getUser()` returns an error (e.g. network issue, misconfigured Supabase URL), `user` is `null` and the code redirects to `/login` — which is the safe fallback, so this is not exploitable. However, transient auth errors cause spurious logouts for valid sessions with no diagnostic signal. It is worth checking `error` and handling the network-error case distinctly.

**Fix:**
```typescript
const { data: { user }, error: authError } = await supabase.auth.getUser();

if (authError) {
  // Log or surface; for now still redirect to be safe
  console.error('Auth check failed in DashboardLayout:', authError.message);
}

if (!user) {
  redirect('/login');
}
```

---

### WR-02: `prompt_version.slice(0, 7)` crashes if `prompt_version` is `null` or `undefined`

**File:** `apps/dashboard/components/ai-logs/ai-logs-table.tsx:122`
**Issue:** `call.prompt_version.slice(0, 7)` calls `.slice` on a value typed as `string`. However, the `ai_calls` table schema is not shown in this review — if `prompt_version` can be `null` (e.g. for error-path AI calls where no prompt version was recorded), this throws a runtime `TypeError: Cannot read properties of null`. The `AiCallRow` type in this file defines `prompt_version` as non-nullable `string`, but the Supabase schema may disagree.

**Fix:** Add a null guard consistent with the rest of the table row's rendering:
```typescript
{call.prompt_version ? call.prompt_version.slice(0, 7) : '—'}
```
Also update the `AiCallRow` type to `prompt_version: string | null` if the column is nullable in the schema.

---

### WR-03: `ALLOWED_EMAILS` being empty/unset locks out all users silently

**File:** `apps/dashboard/lib/actions/auth.ts:17-22`
**Issue:** When `ALLOWED_EMAILS` is not set, `allowedEmails` is `[]`. Then `allowedEmails.includes(user.email ?? '')` is always `false`, causing every authenticated user to be signed out immediately with "Your account is not authorized." This is a misconfiguration footgun — a missing env var silently revokes all access with no clear error about why. In a staging/dev environment this can be confusing and block the developer from testing.

**Fix:** Treat an empty/unset allowlist as "allow all" in development, or log a startup warning:
```typescript
const allowedEmails =
  process.env.ALLOWED_EMAILS?.split(',').map((e) => e.trim()).filter(Boolean) ?? [];

// If no allowlist configured, allow all (or explicitly require config in prod)
if (allowedEmails.length === 0) {
  return {};
}

if (!allowedEmails.includes(user.email ?? '')) {
  await supabase.auth.signOut();
  return { error: 'Your account is not authorized.' };
}
```

---

## Info

### IN-01: `approveReviewItem` and `rejectReviewItem` share ~30 lines of duplicated JSONB extraction code

**File:** `apps/dashboard/lib/actions/review.ts:27-48, 93-98`
**Issue:** Both functions repeat the same pattern: fetch `human_review_queue` item, cast `tier2_result` to `Record<string, Json>`, extract `destinationUrl`/`title`, compute `urlHash`. Once CR-01 is fixed (reject no longer inserts), the duplication in the field extraction disappears naturally. If approve-on-insert logic is kept, consider extracting a shared `extractOfferFields(t2: Record<string, Json>)` helper to avoid divergence.

**Fix:** Extract a helper after CR-01 is resolved:
```typescript
function extractOfferFields(t2: Record<string, Json>) {
  const destinationUrl = String(t2['destination_url'] ?? '');
  const title = String(t2['title'] ?? '');
  const urlHash = createHash('sha256').update(destinationUrl).digest('hex');
  return { destinationUrl, title, urlHash };
}
```

---

### IN-02: `destination_url` rendered in `<a href>` without protocol guard in `OffersTable`

**File:** `apps/dashboard/components/offers/offers-table.tsx:70-77`
**Issue:** Offers displayed in the offers table render `offer.destination_url` directly as an `href`. Offers at this stage have passed through approval so the risk is lower than in the review panel (CR-03), but a `javascript:` URL stored in the DB (e.g. from a future import or direct DB write) would still execute. Applying the same `https?://` guard as suggested in CR-03 here is a minimal, consistent defence.

**Fix:** Same guard as CR-03 — render the link only when the URL starts with `http://` or `https://`:
```typescript
const safeUrl = /^https?:\/\//i.test(offer.destination_url)
  ? offer.destination_url
  : null;
```

---

_Reviewed: 2026-04-20T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
