import { TIER0_KEYWORDS } from './tier0-keywords.js';

/**
 * Pure keyword filter function — runs inline during ingestion before enqueue.
 *
 * Returns true if the text contains at least one Tier 0 keyword (case-insensitive).
 * Returns false if no keywords match — the post is rejected and stored with
 * tier0_passed=false, pipeline_status='tier0_rejected'.
 *
 * This function has no side effects and is safe to unit test in isolation.
 */
export function passesKeywordFilter(text: string): boolean {
  const lower = text.toLowerCase();
  return TIER0_KEYWORDS.some((keyword) => lower.includes(keyword));
}
