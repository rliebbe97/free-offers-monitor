# Plan 06-01 Summary: Shared Adapter Infrastructure + Reddit Migration

**Executed:** 2026-04-21
**Status:** Complete

## What Was Built

The production ingestion loop was migrated from a hardcoded Reddit-only path to a type-agnostic source dispatch factory. `ingest.ts` received three atomic changes: (1) the `.eq('type', 'reddit')` DB filter was removed from `fetchActiveSources` so all source rows are returned regardless of type; (2) the in-memory `redditSources.filter` guard inside `runIngestionCycle` was removed; and (3) the direct `createRedditAdapter(source.identifier)` call was replaced by `createAdapterForSource(source)`. The factory itself uses a switch statement dispatching `'reddit'` to `createRedditAdapter`, `'bump'` to `createTheBumpAdapter`, and throwing `Error('Unknown source type: ${source.type}')` on any other value — never silently skipping. Both imports (`createRedditAdapter` and `createTheBumpAdapter`) are retained in `ingest.ts` and called only through the factory.

`index.ts` received a pure rename of `runRedditIngestionLoop` to `runIngestionLoop` at the function definition, call site in `Promise.all`, and all associated JSDoc/inline comments. No logic was changed. `source-adapter.ts` had its JSDoc comment updated to list both `RedditAdapter` and `TheBumpAdapter` as implementations. A 3-case Vitest unit test was added for the factory covering the reddit branch, the bump branch, and the unknown-type throw — closing the coverage gap identified in the research phase. All 44 worker tests pass and TypeScript compiles cleanly with `--noEmit`.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 031eaa2 | feat(06-01): add createAdapterForSource factory and migrate ingest.ts |
| 2 | 1c76834 | feat(06-01): update source-adapter.ts JSDoc to list both adapter implementations |
| 3 | f9217ac | feat(06-01): rename runRedditIngestionLoop to runIngestionLoop in index.ts |
| 4 | fb86cfe | feat(06-01): add unit test for createAdapterForSource factory |

## Self-Check

PASSED

- `grep -c "eq('type', 'reddit')" ingest.ts` → 0 ✓
- `grep -c "sources.filter" ingest.ts` → 0 ✓
- `grep -c "createAdapterForSource" ingest.ts` → 2 (definition + usage) ✓
- `grep "createTheBumpAdapter" ingest.ts` → import line + factory case ✓
- `grep "Unknown source type" ingest.ts` → default throw ✓
- `grep -c "runRedditIngestionLoop" index.ts` → 0 ✓
- `grep -c "runIngestionLoop" index.ts` → 2 (definition + call) ✓
- `grep "Implementations:.*TheBumpAdapter" source-adapter.ts` → matches ✓
- `test -f ingest.test.ts` → EXISTS ✓
- All 44 Vitest tests pass ✓
- `tsc --noEmit` exits 0 ✓

## Deviations

None. All tasks executed exactly as specified in the plan.
