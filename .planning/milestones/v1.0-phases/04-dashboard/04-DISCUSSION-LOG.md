# Phase 4: Dashboard - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-20
**Phase:** 04-dashboard
**Mode:** --auto (all decisions auto-selected)
**Areas discussed:** Auth integration, Navigation & layout, Offer list display, Review queue interaction, AI call log viewer

---

## Auth Integration

| Option | Description | Selected |
|--------|-------------|----------|
| Server-side middleware + login page | Supabase Auth with @supabase/ssr, middleware session checks, dedicated /login page | ✓ |
| Client-side auth wrapper | useUser() hook check in layout, redirect from client | |
| Mixed (middleware + client) | Middleware for API routes, client for UI auth state | |

**User's choice:** Server-side middleware + login page (auto-selected, recommended default)
**Notes:** Consistent with Phase 1 D-06 (service role key server-side only). Most secure for an internal tool.

| Option | Description | Selected |
|--------|-------------|----------|
| Show clear error on login page | Sign out non-allowlisted user, show error message | ✓ |
| Block at sign-up | Prevent non-allowlisted emails from creating accounts | |
| Silent redirect | Redirect to a generic "access denied" page | |

**User's choice:** Show clear error on login page (auto-selected, recommended default)
**Notes:** Simple UX — user understands why they can't access.

---

## Navigation & Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar navigation | Fixed sidebar with icon+label per section | ✓ |
| Top navigation bar | Horizontal nav across the top | |
| Tab-based | Tabs within a single page | |

**User's choice:** Sidebar navigation (auto-selected, recommended default)
**Notes:** Standard pattern for internal dashboards with 3+ sections.

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal header with app name + sign-out | Clean, uncluttered | ✓ |
| Full header with breadcrumbs | More navigation context | |
| No separate header | Integrate sign-out into sidebar | |

**User's choice:** Minimal header with app name and sign-out (auto-selected, recommended default)

---

## Offer List Display

| Option | Description | Selected |
|--------|-------------|----------|
| Server-rendered table with URL search params | shadcn/ui Table, server-side pagination, filters in URL | ✓ |
| Client-side data table | TanStack Table with client-side filtering | |
| Card-based grid | Visual cards with offer previews | |

**User's choice:** Server-rendered table with URL search params (auto-selected, recommended default)
**Notes:** Matches success criteria requirement for "URL search params" for filter/sort. Server rendering is simpler and faster for this data set.

| Option | Description | Selected |
|--------|-------------|----------|
| 25 per page | Good balance for scanning | ✓ |
| 10 per page | Less scrolling, more pagination | |
| 50 per page | Fewer page loads | |

**User's choice:** 25 per page (auto-selected, recommended default)

---

## Review Queue Interaction

| Option | Description | Selected |
|--------|-------------|----------|
| Inline action buttons in table rows | Quick approve/reject per row, no confirmation dialog | ✓ |
| Detail view with actions | Navigate to full detail page to take action | |
| Split pane | List on left, detail on right, actions in detail | |

**User's choice:** Inline action buttons in table rows (auto-selected, recommended default)
**Notes:** Speed is key for review workflow. No bulk actions for v1 (MOD-01 is v2).

| Option | Description | Selected |
|--------|-------------|----------|
| Expandable row with offer details | Click row to show full context inline | ✓ |
| Hover tooltip | Quick preview on hover | |
| Separate detail page | Full page for each review item | |

**User's choice:** Expandable row with offer details (auto-selected, recommended default)
**Notes:** Lets reviewer see context without leaving the queue view.

---

## AI Call Log Viewer

| Option | Description | Selected |
|--------|-------------|----------|
| Simple sortable table | Columns for all key metrics, sortable via URL params | ✓ |
| Dashboard with charts | Charts for cost trends + table for individual calls | |
| Grouped by prompt version | Aggregate view with drill-down | |

**User's choice:** Simple sortable table (auto-selected, recommended default)
**Notes:** Sufficient for v1 monitoring. ANL-02 (cost tracking dashboard with aggregates) is v2 scope.

---

## Claude's Discretion

- Exact shadcn/ui component selection and composition
- Loading states and skeleton patterns
- Empty state design for each view
- Error handling UI patterns
- Dark mode support details
- Responsive behavior
- Route structure (parallel routes vs nested layouts)

## Deferred Ideas

- Bulk approve/reject — v2 (MOD-01)
- Offer editing — v2 (MOD-02)
- AI cost aggregation dashboard — v2 (ANL-02)
- Real-time notifications — out of scope for v1
