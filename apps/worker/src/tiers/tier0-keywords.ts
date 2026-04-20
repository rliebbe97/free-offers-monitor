/**
 * Hand-maintained keyword list for Tier 0 filtering.
 *
 * IMPORTANT (per CLAUDE.md): NEVER auto-add keywords. Only surface suggestions
 * for human review. A human must decide whether to add a keyword to this list.
 *
 * Keywords target free physical goods for new mothers and families with babies.
 * Tier 0 is high-recall — the purpose is to reject clearly irrelevant posts,
 * not to be precise. Tier 1 (Haiku) handles precision filtering.
 */
export const TIER0_KEYWORDS: readonly string[] = [
  'free',
  'freebie',
  'sample',
  'giveaway',
  'sign up',
  'register',
  'baby box',
  'welcome kit',
  'new mom',
  'newborn',
  'diaper',
  'formula sample',
  'baby registry',
  'free stuff',
  'no cost',
  'complimentary',
  'gratis',
  'free shipping',
  'baby shower',
  'maternity',
  'infant',
  'nursery',
  'wipes',
  'onesie',
  'swaddle',
] as const;
