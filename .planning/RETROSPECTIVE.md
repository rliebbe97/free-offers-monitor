# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-04-21
**Phases:** 4 | **Plans:** 7

### What Was Built
- Full Supabase DB foundation with pgvector, pgmq, pg_cron extensions and 7 tables with typed shared client
- End-to-end Reddit ingestion pipeline with three-tier AI classification (keyword -> Haiku -> Sonnet)
- URL hash + Voyage embedding dedup pipeline with pgvector cosine similarity
- Offer validation cron with HEAD/GET liveness, Cheerio dead signals, two-failure expiry
- Auth-gated Next.js dashboard with offer list, review queue, and AI call log viewer

### What Worked
- Coarse-grained phasing (4 phases for full MVP) kept planning overhead minimal while delivering complete features per phase
- pgmq consumer pattern with shouldArchive/finally-block archive and DLQ routing proved clean and reusable across Tier 1, Tier 2, and validation loops
- Forced tool use for Tier 2 Sonnet extraction eliminated parsing ambiguity — Zod validation catches malformed outputs reliably
- Separating runValidationCycle from runValidationLoop enabled clean unit testing without fighting while-loop timing

### What Was Inefficient
- Hand-written DB types required multiple patches (Relationships arrays, pgmq RPC types, pgmq_create) — `pnpm db:generate` against a live schema would have avoided this
- REQUIREMENTS.md traceability table was never updated during phase execution (all stayed "Pending") — automating status updates at phase completion would keep it accurate
- shadcn CLI npm conflict with pnpm workspace:* protocol required a manual workaround each time

### Patterns Established
- pgmq consumer: read -> process -> shouldArchive flag -> archive in finally block -> DLQ after 3 retries
- Validation cycle/loop separation for testability
- WAF detection (403/429) as distinct from real failures — prevents false expiry
- Server action session re-verification independent of proxy (defense-in-depth)
- Sort column allowlist for SQL injection prevention on dynamic order-by

### Key Lessons
1. Write DB type stubs with Relationships arrays from the start — postgrest-js requires them and the error manifests as `never` types deep in query chains
2. Vitest config needs dummy env vars when config modules validate at import time — discovered during Phase 3
3. snoowrap types are genuinely incomplete — plan for @ts-ignore and consider raw Reddit API for v2

---

## Milestone: v1.1 — Forum Adapters

**Shipped:** 2026-04-22
**Phases:** 2 | **Plans:** 10

### What Was Built
- Shared scraping utilities (fetchWithRetry, respectfulDelay, p-throttle rate limiting, ScrapeError, extractExternalId)
- BaseForumAdapter abstract class with template-method pagination, Cloudflare challenge detection, 3 termination conditions
- TheBumpAdapter: Cheerio scraping of freebies/deals subforums with stable numeric external_id, `<time datetime>` date parsing, .text()-only body extraction
- Type-agnostic source dispatch factory (createAdapterForSource) replacing hardcoded Reddit-only ingestion pipeline
- 28 new unit tests (scraping-utils 13, base adapter 6, TheBump adapter 9) bringing worker total to 44
- Eval system: 21 labeled posts (10 cross-source pairs), Tier 1 classifier accuracy gate, dedup cosine scoring with Voyage AI

### What Worked
- Template-method pattern for BaseForumAdapter kept TheBumpAdapter minimal (~150 LOC) — subclass only provides selectors and URL patterns
- Building the adapter in isolation (Phase 5) before wiring into production pipeline (Phase 6) prevented accidental regressions to Reddit path
- Synthetic HTML fixtures from Vanilla Forums structure enabled deterministic tests without network dependency
- Finer-grained plans (7 plans for Phase 5) with wave-based execution enabled parallel work and clear verification boundaries
- Cross-source eval pairs designed in Phase 5, populated in Phase 6 — clean handoff

### What Was Inefficient
- REQUIREMENTS.md checkboxes were never updated during phase execution (all stayed `[ ]`) — milestone audit caught this cosmetic gap
- 05-02 SUMMARY recorded wrong p-throttle version (6.1.0 vs actual 8.1.0) — doc-only error but shows summary auto-generation can drift
- `thebump_pagination_stop` log name baked into BaseForumAdapter is TheBump-specific — should have been generic from the start
- gsd-sdk milestone.complete CLI failed ("version required for phases archive") requiring manual archival

### Patterns Established
- Template-method adapter pattern: base class owns pagination/rate-limit/challenge-detection, subclass provides CSS selectors and URL structure
- Factory dispatch for multi-source ingestion: switch on source.type, throw on unknown
- HTML fixture testing: synthetic but structurally accurate fixtures loaded with readFileSync
- Cross-source eval pairs with `cross_source_pair_id` linking for dedup threshold validation
- vi.resetAllMocks (not clearAllMocks) in Vitest 3.x when tests share mocked modules

### Key Lessons
1. Vitest 3.x `clearAllMocks` does NOT drain `mockResolvedValueOnce` queue — always use `resetAllMocks` when tests share mocked modules
2. Template-method pattern is ideal for forum adapters — forces consistent pagination/rate-limiting while allowing selector customization
3. Building adapter in isolation before pipeline integration catches interface mismatches early — the Phase 5→6 handoff was clean
4. Eval datasets should include cross-source pairs from the start — retrofitting is harder than designing in

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 4 | 7 | Initial MVP — coarse-grained phases with 1-3 plans each |
| v1.1 | 2 | 10 | Forum adapters — finer-grained plans (7 for Phase 5), isolation-then-integration pattern |

### Cumulative Quality

| Milestone | Tests | Key Metric |
|-----------|-------|------------|
| v1.0 | 13 | Validation module fully tested; dashboard code-verified 12/12 |
| v1.1 | 54 | +41 ingestion tests; eval system with 21 labeled posts and accuracy gate |

### Top Lessons (Verified Across Milestones)

1. Hand-written Supabase types diverge quickly — generate from live schema early
2. pgmq consumer pattern is reusable and reliable — keep shouldArchive/finally/DLQ pattern
3. Build adapters in isolation before wiring into production pipeline — prevents regression and catches interface mismatches early (confirmed v1.1)
4. Vitest 3.x resetAllMocks required when tests share mocked modules — clearAllMocks doesn't drain queues (confirmed v1.1)
