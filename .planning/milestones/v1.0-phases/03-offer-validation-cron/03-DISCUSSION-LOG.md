# Phase 3: Offer Validation Cron - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-20
**Phase:** 03-offer-validation-cron
**Areas discussed:** Validation trigger architecture, Dead signal patterns, Validation scheduling, HTTP request configuration
**Mode:** --auto (all decisions auto-selected)

---

## Validation Trigger Architecture

| Option | Description | Selected |
|--------|-------------|----------|
| SQL-only in pg_cron | pg_cron runs a SQL function that fetches URLs, checks them, and writes results — all in Postgres | |
| HTTP call to worker | pg_cron triggers worker via HTTP endpoint to start validation | |
| Worker polling loop | Worker has its own async loop checking for offers with next_check_at in the past — consistent with Phase 2 three-loop architecture | :heavy_check_mark: |

**User's choice:** Worker polling loop (auto-selected — recommended default)
**Notes:** Consistent with Phase 2 architecture. All three existing loops (Reddit polling, Tier 1 consumer, Tier 2 consumer) follow the same pattern. Adding a fourth validation loop maintains architectural consistency and keeps all business logic in TypeScript.

---

## Dead Signal Patterns

| Option | Description | Selected |
|--------|-------------|----------|
| Hardcoded in function | Dead signal strings inline in the validation function | |
| TypeScript array file | Dedicated file exporting string[], mirroring tier0-keywords.ts pattern | :heavy_check_mark: |
| DB-stored patterns | Patterns stored in a database table, runtime configurable | |

**User's choice:** TypeScript array file (auto-selected — recommended default)
**Notes:** Mirrors the tier0-keywords.ts approach from Phase 2 — version-controlled, reviewable in PRs, cached at module load time. DB-stored patterns would be overkill for v1.

---

## Validation Scheduling

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed 7-day interval | next_check_at = now() + 7 days exactly, no jitter | |
| 7-day with random jitter | next_check_at = now() + 7 days + random(0-6h) to spread load | :heavy_check_mark: |
| Adaptive frequency | Increase check frequency for offers that have failed recently | |

**User's choice:** 7-day with random jitter (auto-selected — recommended default)
**Notes:** Random jitter prevents thundering herd. Adaptive frequency adds complexity without clear v1 benefit — the two-check rule already handles the retry case with 24-hour spacing.

---

## HTTP Request Configuration

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal | Simple fetch with default settings | |
| Standard WAF-friendly | Reasonable User-Agent, 10s timeout, HEAD-first with GET fallback, follow redirects | :heavy_check_mark: |
| Stealth | Rotating User-Agents, delays between requests, cookie handling | |

**User's choice:** Standard WAF-friendly (auto-selected — recommended default)
**Notes:** This is a liveness check, not content scraping. No need for stealth. HEAD-first with GET fallback aligns with VAL-02. 403/429 handled as check_failed per requirements.

---

## Claude's Discretion

- Consecutive failure tracking mechanism (counter column vs. querying verification_log)
- Cheerio text extraction strategy
- Validation module file structure
- pg_cron SQL implementation details
- Validation-specific config constants

## Deferred Ideas

None — discussion stayed within phase scope.
