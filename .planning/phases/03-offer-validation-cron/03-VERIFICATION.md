---
phase: 03-offer-validation-cron
verified: 2026-04-20T23:00:00Z
status: passed
score: 17/17 must-haves verified
overrides_applied: 0
gaps: []
---

# Phase 3: Offer Validation Cron — Verification Report

**Phase Goal:** Implement the daily pg_cron validation job that checks active offer URL liveness and dead signals, requiring two consecutive failures before auto-expiring.
**Verified:** 2026-04-20T23:00:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | pg_cron scheduling entry for daily validation exists (VAL-01) | ✓ VERIFIED | `schema.sql` line 229: `SELECT cron.schedule('validation-daily-trigger', '0 0 * * *', $$SELECT 1$$)` |
| 2 | Validation loop polls `offers` where `status='active' AND next_check_at <= now()` on a 10-minute interval (VAL-01) | ✓ VERIFIED | `validation-loop.ts`: `.eq('status', 'active').lte('next_check_at', ...)`, `VALIDATION_POLL_INTERVAL_MS = 10 * 60 * 1000` |
| 3 | HEAD request attempted first, GET fallback on 405/network error (VAL-02) | ✓ VERIFIED | `liveness-check.ts` line 39: `method: 'HEAD'`, line 69: `method: 'GET'` in fallback path |
| 4 | 403/429 treated as WAF block (check_failed), NOT counted as failure (VAL-02) | ✓ VERIFIED | `liveness-check.ts` lines 52–54, 78–79: `isWaf: true` on 403/429; `validation-loop.ts` line 54: WAF branch does NOT update `consecutive_failures` |
| 5 | Cheerio dead signal detection scans page text for expiry indicators (VAL-03) | ✓ VERIFIED | `liveness-check.ts` lines 88–90: `cheerio.load(bodyText)`, `$('body').text().toLowerCase()`, `DEAD_SIGNALS.filter(...)` |
| 6 | Dead signals cause `is_live=false` regardless of HTTP status (VAL-03) | ✓ VERIFIED | `liveness-check.ts` lines 93–95: `isLive: false` when `foundSignals.length > 0` on a 200-range response |
| 7 | Two consecutive failures (24h apart) required for auto-expiry (VAL-04) | ✓ VERIFIED | First failure sets `consecutive_failures: 1` + `next_check_at: now()+24h`; only `consecutive_failures >= 1` triggers `status: 'expired'` |
| 8 | First failure sets `consecutive_failures=1` and `next_check_at=now()+24h` (VAL-04) | ✓ VERIFIED | `validation-loop.ts` lines 79–83: Case C update with `consecutive_failures: 1` and `nextCheckAtHours(VALIDATION_RETRY_INTERVAL_HOURS)` where retry=24h |
| 9 | Second failure transitions offer to `status='expired'` (VAL-04) | ✓ VERIFIED | `validation-loop.ts` lines 92–96: Case D update with `status: 'expired'` and `consecutive_failures: offer.consecutive_failures + 1` |
| 10 | Successful check resets `consecutive_failures=0` and normal 7-day cycle (VAL-04) | ✓ VERIFIED | `validation-loop.ts` lines 67–71: Case B update with `consecutive_failures: 0` and `nextCheckAt(VALIDATION_CHECK_INTERVAL_DAYS, ...)` where interval=7 days |
| 11 | ALL validation results written to `verification_log` (live, dead, WAF, network error) (VAL-05) | ✓ VERIFIED | `validation-loop.ts` lines 46–52: `db.from('verification_log').insert(...)` called before WAF/live/fail branching |
| 12 | `consecutive_failures` column added to `offers` table in schema.sql and types.ts | ✓ VERIFIED | `schema.sql` line 76: `consecutive_failures  integer NOT NULL DEFAULT 0`; `types.ts` lines 114, 134, 155: present in Row/Insert/Update |
| 13 | cheerio added to worker dependencies | ✓ VERIFIED | `apps/worker/package.json` line 17: `"cheerio": "^1.0.0"` |
| 14 | Validation loop uses shutdown flag pattern matching existing loops | ✓ VERIFIED | `validation-loop.ts` lines 157, 169–171: `while (!shutdown.stop)` with `if (!shutdown.stop && remaining > 0)` sleep |
| 15 | Vitest tests for liveness-check.ts covering HEAD/GET/WAF/timeout/dead-signal scenarios | ✓ VERIFIED | `liveness-check.test.ts`: 7 tests covering HEAD 200, HEAD 405 fallback, GET 403 WAF, GET 404, timeout null, dead signal detection, case-insensitive matching — all green |
| 16 | Vitest tests for validation-loop.ts covering two-check expiry state machine and verification_log writes | ✓ VERIFIED | `validation-loop.test.ts`: 6 tests covering first failure, second failure expiry, WAF no-increment, success reset, verification_log written every outcome, single offer error isolation — all green |
| 17 | No default exports, no `any` type, all internal imports use `.js` extension | ✓ VERIFIED | Grep confirms named exports only; no `any` usage; all imports use `.js` suffix |

**Score:** 17/17 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/schema.sql` | `consecutive_failures` column + `cron.schedule` entry | ✓ VERIFIED | Both present at lines 76 and 229 |
| `packages/db/src/types.ts` | `consecutive_failures` in Row/Insert/Update | ✓ VERIFIED | All three interfaces updated |
| `apps/worker/package.json` | `cheerio ^1.0.0` in dependencies | ✓ VERIFIED | Present at line 17 |
| `apps/worker/src/config.ts` | 9 `VALIDATION_*` constants | ✓ VERIFIED | All 9 constants at lines 34–42 |
| `apps/worker/src/validation/dead-signals.ts` | `DEAD_SIGNALS: readonly string[]` with 14 phrases, `as const`, JSDoc | ✓ VERIFIED | 14 phrases, includes `'out of stock'`, `'sold out'`, `'page not found'`, `'giveaway closed'` |
| `apps/worker/src/validation/liveness-check.ts` | `LivenessResult` interface + `checkLiveness` function, HEAD-first, WAF detection, Cheerio scan | ✓ VERIFIED | Substantive — 107 lines, full logic |
| `apps/worker/src/validation/liveness-check.test.ts` | 7 test cases for liveness-check | ✓ VERIFIED | All 7 tests pass |
| `apps/worker/src/validation/validation-loop.ts` | `runValidationLoop` + `runValidationCycle`, p-limit, state machine, verification_log | ✓ VERIFIED | Substantive — 176 lines, full state machine |
| `apps/worker/src/validation/validation-loop.test.ts` | 6 test cases for validation-loop | ✓ VERIFIED | All 6 tests pass |
| `apps/worker/src/index.ts` | `runValidationLoop` import + fourth entry in `Promise.all` | ✓ VERIFIED | Line 13 import, line 231 in Promise.all |
| `apps/worker/vitest.config.ts` | Dummy env vars for test isolation | ✓ VERIFIED | Created with 5 required env var stubs |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `validation-loop.ts` | `liveness-check.ts` | `import { checkLiveness }` | ✓ WIRED | Line 13 import, called at line 43 |
| `validation-loop.ts` | `dead-signals.ts` (indirect) | via `liveness-check.ts` | ✓ WIRED | `DEAD_SIGNALS` used in `liveness-check.ts` line 90 |
| `validation-loop.ts` | `config.ts` | imports 6 `VALIDATION_*` constants | ✓ WIRED | Lines 4–11, all constants used |
| `validation-loop.ts` | `queue/consumer.ts` | `import { sleep }` | ✓ WIRED | Line 12, used at line 170 |
| `index.ts` | `validation-loop.ts` | `import { runValidationLoop }` | ✓ WIRED | Line 13, invoked in `Promise.all` at line 231 |
| `validation-loop.ts` | Supabase `verification_log` table | `db.from('verification_log').insert(...)` | ✓ WIRED | Lines 46–52, covers VAL-05 |
| `validation-loop.ts` | Supabase `offers` table | `.eq('status', 'active').lte('next_check_at', ...)` + `.update(...)` | ✓ WIRED | Lines 118–122 for query, lines 56–96 for updates |

---

### Data-Flow Trace (Level 4)

Not applicable — this phase produces a backend worker loop, not a UI component. Data flows from Supabase `offers` table through HTTP liveness checks to `verification_log` and back to `offers` status updates. The pipeline is fully traced above in Key Link Verification.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 13 validation tests pass | `pnpm test --filter worker` | 2 test files, 13 tests, all passed, 309ms | ✓ PASS |
| TypeScript compiles without errors | `pnpm check-types --filter worker` | 0 errors (cache hit, 2 tasks successful) | ✓ PASS |
| Phase commits exist in git history | `git log --oneline 8c3dfbd d570114 8fb2fa4 e969070` | All 4 commits found | ✓ PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| VAL-01 | 03-01-PLAN.md | pg_cron triggers daily validation checking each active offer weekly | ✓ SATISFIED | `schema.sql` `cron.schedule('validation-daily-trigger', '0 0 * * *', ...)` + 10-minute polling loop |
| VAL-02 | 03-01-PLAN.md | URL liveness check via HEAD with GET fallback; 403/429 responses treated as `check_failed`, not dead | ✓ SATISFIED | `liveness-check.ts` HEAD-first → GET fallback; `isWaf: true` on 403/429 prevents `consecutive_failures` increment |
| VAL-03 | 03-01-PLAN.md | Cheerio-based dead signal detection scans page text for expiry indicators | ✓ SATISFIED | `liveness-check.ts` Cheerio `$('body').text().toLowerCase()` + 14-phrase `DEAD_SIGNALS` list |
| VAL-04 | 03-01-PLAN.md | Two consecutive failed checks 24 hours apart required before auto-expiring an offer | ✓ SATISFIED | First failure → `consecutive_failures: 1` + 24h retry; second failure → `status: 'expired'` |
| VAL-05 | 03-01-PLAN.md | All validation results written to `verification_log` | ✓ SATISFIED | `db.from('verification_log').insert(...)` called for every outcome before branching |

**Orphaned requirements check:** REQUIREMENTS.md maps VAL-01 through VAL-05 to Phase 3. All 5 are claimed in `03-01-PLAN.md` and verified above. No orphaned requirements.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | — | — | — |

No TODOs, FIXMEs, placeholders, empty implementations, or stub indicators found in any validation file.

---

### Human Verification Required

None. All observable behaviors are verifiable programmatically. Tests pass, types check, commits exist, and logic is fully implemented.

---

### Gaps Summary

No gaps. All 17 must-haves verified. Phase 3 goal fully achieved.

The implementation delivers:
- pg_cron entry satisfying VAL-01 declarative requirement
- Polling loop querying active offers due for check (VAL-01 execution)
- HEAD-first liveness check with GET fallback and WAF detection (VAL-02)
- Cheerio dead signal scan against 14 hand-maintained phrases (VAL-03)
- Two-consecutive-failure expiry state machine with 24h enforced gap (VAL-04)
- `verification_log` write on every check outcome (VAL-05)
- 13 passing Vitest tests covering all state machine branches
- Clean TypeScript (no `any`, no default exports, `.js` extensions)
- Worker entry point updated with fourth concurrent loop in `Promise.all`

---

_Verified: 2026-04-20T23:00:00Z_
_Verifier: Claude (gsd-verifier)_
