/**
 * Hand-maintained list of dead-signal phrases for offer validation.
 *
 * IMPORTANT: NEVER auto-add phrases. Only surface suggestions for human
 * review. A human must decide whether to add a phrase to this list.
 *
 * Matching is case-insensitive substring search against Cheerio-extracted
 * body text. No regex for v1.
 */
export const DEAD_SIGNALS: readonly string[] = [
  'out of stock',
  'sold out',
  'no longer available',
  'offer expired',
  'offer ended',
  'discontinued',
  'promotion ended',
  'deal expired',
  'currently unavailable',
  'page not found',
  'this item is no longer',
  'item is unavailable',
  'this offer has ended',
  'giveaway closed',
] as const;
