# Phase 3: Offer Validation Cron - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the daily validation system that checks active offer URL liveness and dead signals, requiring two consecutive failures at least 24 hours apart before auto-expiring. All results logged to `verification_log`. Requirements: VAL-01 through VAL-05.

</domain>

<decisions>
## Implementation Decisions

### Validation Trigger Architecture
- **D-01:** Validation runs as a fourth concurrent loop inside the existing worker process, consistent with Phase 2's three-loop architecture (Reddit polling, Tier 1 consumer, Tier 2 consumer). The loop polls the `offers` table for rows where `status = 'active'` and `next_check_at <= now()`.
- **D-02:** pg_cron is used only to ensure the validation window fires daily — it calls a lightweight SQL function or sets a flag rather than running validation logic in SQL. All validation logic lives in TypeScript for testability and consistency with the rest of the worker.
- **D-03:** The validation loop runs on a configurable interval (e.g., every 10 minutes) checking for offers with `next_check_at` in the past. This decouples scheduling from execution — pg_cron sets the schedule, the worker processes it.

### Dead Signal Patterns
- **D-04:** Dead signal phrases live in a TypeScript file at `apps/worker/src/validation/dead-signals.ts`, exported as a `string[]`. Mirrors the `tier0-keywords.ts` pattern from Phase 2 — version-controlled, reviewable in PRs, cached at module load time.
- **D-05:** Initial pattern set covers common expiry indicators: "out of stock", "sold out", "no longer available", "offer expired", "offer ended", "discontinued", "promotion ended", "deal expired", "currently unavailable", "page not found". Specific list finalized during planning.
- **D-06:** Matching is case-insensitive substring search against Cheerio-extracted page text. No regex for v1 — keep it simple and add regex support in v2 if needed.

### Validation Scheduling
- **D-07:** `next_check_at` is set when an offer is first created (by the Tier 2 pipeline in Phase 2) to `now() + 7 days + random jitter (0-6 hours)`. After each validation check, `next_check_at` is updated to `checked_at + 7 days + random jitter (0-6 hours)`.
- **D-08:** The random jitter (0-6 hours) spreads validation load across the day, preventing thundering herd when many offers are created around the same time.
- **D-09:** No batch size limit for v1 — process all due offers in each validation loop tick. If volume becomes an issue, add configurable batch limits later.

### HTTP Request Configuration
- **D-10:** Liveness check uses HEAD request first; if HEAD returns 405 or times out, fall back to GET (per VAL-02).
- **D-11:** Reasonable User-Agent string identifying the bot (e.g., `FreeOffersMonitor/1.0`). No stealth or rotation — this is a liveness check, not scraping.
- **D-12:** 10-second timeout per request. Follow redirects (up to 5 hops). No cookie jar.
- **D-13:** HTTP 200-399 = live. HTTP 403/429 = `check_failed` (WAF/rate-limit, not dead — per VAL-02). HTTP 404/410/5xx = failed. Network errors (timeout, DNS failure) = failed.

### Two-Check Expiry Rule
- **D-14:** A single failed check sets the offer to an intermediate state (`check_failed` or updates `consecutive_failures` counter). The offer remains active and is rechecked on the next cycle (next_check_at updated to 24 hours from now, not 7 days).
- **D-15:** Two consecutive failures at least 24 hours apart transitions the offer from `active` to `expired` (per VAL-04). The 24-hour gap is enforced by the scheduling — after a first failure, `next_check_at` is set to `now() + 24 hours`.
- **D-16:** A successful check at any point resets the consecutive failure count and returns the offer to the normal 7-day check cycle.

### Claude's Discretion
- Whether to track consecutive failures via a counter column on `offers` or by querying the last N `verification_log` entries
- Exact Cheerio selectors and text extraction strategy (full body text vs. targeted elements)
- Whether the validation loop function should be in `apps/worker/src/validation/` directory or flat in `src/`
- pg_cron SQL function implementation details
- Config module additions for validation-specific constants (timeouts, jitter range, etc.)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Database Schema
- `packages/db/src/schema.sql` — `verification_log` table DDL (columns: offer_id, checked_at, http_status, is_live, dead_signals, raw_response), `offers` table with status/next_check_at/last_verified_at fields, `offers_next_check_active_idx` index
- `.planning/research/ARCHITECTURE.md` — Full DDL and component boundaries

### Pitfalls
- `.planning/research/PITFALLS.md` — pgmq archive patterns, relevant HTTP/scraping edge cases

### Project Rules
- `CLAUDE.md` — Offer criteria, code style, critical rules, validation section in Architecture

### Prior Phase Decisions
- `.planning/phases/01-db-foundation-shared-package/01-CONTEXT.md` — DB client pattern (`createClient()` factory), type generation approach
- `.planning/phases/02-worker-pipeline-ingestion-classification-dedup-logging/02-CONTEXT.md` — Worker process architecture (concurrent loops, graceful shutdown, config pattern), tier0-keywords.ts pattern for managed lists, Cheerio as scraping dependency

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/worker/src/config.ts` — Config module pattern with `getEnvOrThrow()`, pipeline constants; add validation constants here
- `apps/worker/src/logger.ts` — Structured logger for consistent event logging
- `apps/worker/src/index.ts` — Worker entry point with `Promise.all()` loop pattern; add fourth validation loop here
- `apps/worker/src/queue/consumer.ts` — `sleep()` utility function, consumer loop pattern reusable for polling
- `packages/db/src/client.ts` — `createClient()` factory, same client used for validation queries

### Established Patterns
- Concurrent async loops with shutdown flag (`{ stop: boolean }`) for graceful shutdown
- Config constants exported from `apps/worker/src/config.ts`
- TypeScript file for managed lists (`apps/worker/src/tiers/tier0-keywords.ts`)
- Structured logging with `logger.info/warn/error` and event name + payload

### Integration Points
- `apps/worker/src/index.ts` `main()` function — add `runValidationLoop()` to `Promise.all()` array
- `packages/db/src/schema.sql` — May need a pg_cron SQL addition for the daily trigger
- `offers` table columns: `status`, `next_check_at`, `last_verified_at` — already in schema
- `verification_log` table — already in schema, ready for writes
- Cheerio already in worker dependencies (used by Phase 2 Tier 2)

</code_context>

<specifics>
## Specific Ideas

No specific requirements — follow the established worker patterns and requirements from VAL-01 through VAL-05.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 03-offer-validation-cron*
*Context gathered: 2026-04-20*
