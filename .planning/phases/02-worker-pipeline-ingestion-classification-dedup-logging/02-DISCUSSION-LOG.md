# Phase 2: Worker Pipeline — Ingestion, Classification, Dedup & Logging - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-20
**Phase:** 02-worker-pipeline-ingestion-classification-dedup-logging
**Areas discussed:** Reddit Polling & Subreddit Config, Tier 0 Keyword Design, Prompt & Model Versioning, Worker Process Architecture
**Mode:** --auto (all decisions auto-selected using recommended defaults)

---

## Reddit Polling & Subreddit Configuration

| Option | Description | Selected |
|--------|-------------|----------|
| 5-minute interval | Standard for Reddit monitoring, within rate limits | ✓ |
| 1-minute interval | More responsive but burns rate limit budget faster | |
| 15-minute interval | Conservative, may miss time-sensitive offers | |

**User's choice:** [auto] 5-minute interval (recommended default)
**Notes:** Stays well within 100 req/min OAuth rate limit while maintaining acceptable offer freshness.

| Option | Description | Selected |
|--------|-------------|----------|
| `sources` table | Runtime configurable, already in schema | ✓ |
| Config file | Version-controlled but requires redeploy to change | |
| Environment variable | Simple but limited to a comma-separated list | |

**User's choice:** [auto] `sources` table (recommended default)
**Notes:** Schema already has `sources` table with `type`, `identifier`, and `config` columns.

| Option | Description | Selected |
|--------|-------------|----------|
| freebies, BabyBumps, beyondthebump | Highest signal for free baby goods | ✓ |
| freebies only | Narrower but most concentrated source | |
| Broad set (10+ subreddits) | Maximum coverage but higher noise | |

**User's choice:** [auto] freebies, BabyBumps, beyondthebump (recommended default)
**Notes:** Best signal-to-noise ratio for the project's target domain.

---

## Tier 0 Keyword Design

| Option | Description | Selected |
|--------|-------------|----------|
| TypeScript file in worker source | Version-controlled, no DB roundtrip | ✓ |
| Database table | Runtime editable via dashboard | |
| JSON config file | Version-controlled, language-agnostic | |

**User's choice:** [auto] TypeScript file (recommended default)
**Notes:** Version-controlled and reviewable in PRs. Per CLAUDE.md: never auto-add keywords — human decides. A code file enforces this via PR review.

| Option | Description | Selected |
|--------|-------------|----------|
| Import at startup, cache | Simple, no runtime I/O | ✓ |
| Reload periodically | Allows hot-update without restart | |

**User's choice:** [auto] Import at startup, cache (recommended default)
**Notes:** Keywords change rarely enough that restart-on-change is acceptable for v1.

---

## Prompt & Model Versioning

| Option | Description | Selected |
|--------|-------------|----------|
| Pinned dated strings in config module | Single source of truth, explicit | ✓ |
| Environment variables | Flexible but error-prone | |
| Unversioned aliases | Simpler but risks silent behavior changes | |

**User's choice:** [auto] Pinned dated strings in config module (recommended default)
**Notes:** Per PITFALLS.md — never use unversioned aliases. Config module provides single change point.

| Option | Description | Selected |
|--------|-------------|----------|
| Read from disk at startup, cache | Per PITFALLS.md guidance | ✓ |
| Inline in code | Harder to version and review | |
| Read per-request | Unnecessary I/O | |

**User's choice:** [auto] Read from disk at startup, cache (recommended default)
**Notes:** Prompts live in `prompts/` as markdown per CLAUDE.md. Loaded once at startup per PITFALLS.md.

---

## Worker Process Architecture

| Option | Description | Selected |
|--------|-------------|----------|
| Single process, concurrent async loops | Simple for v1, no coordination needed | ✓ |
| Separate processes per tier | Better isolation but more infra complexity | |
| Single sequential loop | Simplest but creates bottleneck | |

**User's choice:** [auto] Single process, concurrent async loops (recommended default)
**Notes:** Reddit poller + Tier 1 consumer + Tier 2 consumer run as concurrent async loops in one process. Simplest architecture that supports the pipeline.

| Option | Description | Selected |
|--------|-------------|----------|
| SIGTERM/SIGINT drain + archive | Standard for Railway, clean shutdown | ✓ |
| Immediate exit | Risks message re-delivery | |

**User's choice:** [auto] SIGTERM/SIGINT drain + archive (recommended default)
**Notes:** Railway sends SIGTERM on deploy. Draining ensures current message is archived.

| Option | Description | Selected |
|--------|-------------|----------|
| Plain http.createServer health endpoint | Minimal, no framework needed | ✓ |
| Express/Fastify server | Overkill for a single health route | |

**User's choice:** [auto] Plain http.createServer health endpoint (recommended default)
**Notes:** Railway requires an HTTP endpoint for health checks. No need for a framework.

---

## Claude's Discretion

- Exact polling implementation details (setInterval vs recursive setTimeout)
- pgmq read batch size per consumer tick
- Zod schema shape for Tier 2 tool output
- DLQ queue creation strategy
- URL normalization library configuration
- Voyage AI client setup
- SourceAdapter interface location

## Deferred Ideas

None — discussion stayed within phase scope.
