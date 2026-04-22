---
phase: 5
plan: 07
subsystem: evals
tags: [eval, dataset, tier1, tier2]
key-files:
  created:
    - evals/labeled-posts.json
    - evals/run-eval.ts
  modified:
    - package.json
metrics:
  tasks_completed: 3
  tasks_total: 3
  deviations: 0
---

# Plan 05-07 Summary: Eval Dataset and Tier 1 Eval Runner

## What Was Built

Three artifacts implementing the eval subsystem for the TheBump adapter phase:

1. **evals/labeled-posts.json** — 10 labeled TheBump forum posts with exactly 5 pass + 5 reject entries (~50/50 split). Each entry has realistic TheBump-style body text, a `label` field (`"pass"` or `"reject"`), and a `tier2_expected` field: non-null with `is_valid_offer`, `item`, and `shipping_cost` for pass entries; `null` for reject entries. Satisfies ROADMAP SC#3 requirements for both Tier 1 and Tier 2 eval ground truth.

   Pass examples: diaper samples, formula sample box, hospital welcome bag, insurance breast pump, baby food samples.
   Reject examples: 50% coupon code, subscription trial with credit card, sweepstakes, lactation consultation (service), BOGO deal requiring purchase.

2. **evals/run-eval.ts** — Standalone TypeScript eval script using `@anthropic-ai/sdk` directly (no LangChain, no Vercel AI SDK, no worker imports). Reads `labeled-posts.json` and `prompts/tier1-classify.md`, calls Haiku (`claude-haiku-4-20250514`) for each post, prints a per-entry result table, and reports accuracy/precision/recall/F1 with confusion matrix. Exits 0 when accuracy >= 0.7, exits 1 otherwise. Includes explicit `ai_calls` logging exemption comment per CLAUDE.md rules. Tier 2 execution deferred to Phase 6 (data is ready in labeled-posts.json).

3. **package.json** — Added `"eval"` script: `pnpm --filter worker exec tsx ../../evals/run-eval.ts`. Leverages worker's existing `tsx` devDependency without adding it to root. Runnable from repo root with `ANTHROPIC_API_KEY` set.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | e591d49 | feat(evals): create labeled-posts.json with 10 TheBump entries (~50/50 split) |
| 2 | aed239e | feat(evals): create run-eval.ts standalone Tier 1 classifier eval script |
| 3 | 0f0abd5 | feat(evals): add pnpm eval script to root package.json |

## Deviations

None. All tasks executed exactly as specified in the plan. The eval script includes F1 score computation in addition to the plan-specified accuracy/precision/recall for richer reporting.

## Self-Check

PASSED

- [x] evals/labeled-posts.json has 10 entries with exactly 50/50 split (5 pass, 5 reject)
- [x] Each pass entry has non-null tier2_expected with is_valid_offer and item keys
- [x] Each reject entry has tier2_expected: null
- [x] evals/run-eval.ts uses @anthropic-ai/sdk directly
- [x] No imports from @repo/db, ../logger, ../config, LangChain, or Vercel AI SDK
- [x] ai_calls exemption comment present in run-eval.ts
- [x] Model string matches TIER1_MODEL: claude-haiku-4-20250514
- [x] Prompt read from prompts/tier1-classify.md (same as production)
- [x] "eval" script added to root package.json
- [x] All 3 tasks committed atomically
