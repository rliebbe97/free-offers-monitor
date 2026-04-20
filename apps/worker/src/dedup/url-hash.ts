import { createHash } from 'node:crypto';
import normalizeUrl from 'normalize-url';
import type { createClient } from '@repo/db';

type DbClient = ReturnType<typeof createClient>;

/**
 * Follow one level of HTTP redirect using a HEAD request.
 * Returns the Location header value if the response is a 3xx redirect.
 * Falls back to the original URL on any error (network, timeout, etc.) — never throws.
 */
export async function followOneRedirect(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return location;
      }
    }

    return url;
  } catch {
    // Network error, timeout, or other failure — return original URL silently
    return url;
  }
}

/**
 * Normalize Amazon product URLs to a canonical form using the ASIN.
 * Extracts ASINs from /dp/ASIN and /gp/product/ASIN paths.
 * Returns the original URL unchanged for non-Amazon URLs.
 */
function normalizeAmazonUrl(url: string): string {
  if (!url.includes('amazon.')) {
    return url;
  }

  const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
  if (dpMatch && dpMatch[1]) {
    return `https://www.amazon.com/dp/${dpMatch[1]}`;
  }

  const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (gpMatch && gpMatch[1]) {
    return `https://www.amazon.com/dp/${gpMatch[1]}`;
  }

  return url;
}

/**
 * Normalize a raw URL and compute its SHA-256 hash for dedup.
 *
 * Steps:
 * 1. Follow one level of HTTP redirect (AbortSignal 5s timeout)
 * 2. Apply Amazon URL canonicalization (ASIN extraction)
 * 3. Normalize with normalize-url (strip UTM params, sort query params, strip hash)
 * 4. SHA-256 hash the normalized URL string
 *
 * Returns both the normalized URL (for storage) and the hash (for lookup).
 */
export async function normalizeAndHash(
  rawUrl: string,
): Promise<{ normalizedUrl: string; hash: string }> {
  // Step 1: Follow one redirect
  const resolved = await followOneRedirect(rawUrl);

  // Step 2: Amazon canonicalization
  const amazonNormalized = normalizeAmazonUrl(resolved);

  // Step 3: normalize-url with UTM stripping and query param sorting
  const normalizedUrl = normalizeUrl(amazonNormalized, {
    stripWWW: false,
    removeQueryParameters: [/^utm_/i, 'ref', 'source', 'fbclid', 'gclid'],
    sortQueryParameters: true,
    stripHash: true,
    normalizeProtocol: true,
  });

  // Step 4: SHA-256 hash
  const hash = createHash('sha256').update(normalizedUrl).digest('hex');

  return { normalizedUrl, hash };
}

/**
 * Query the offers table for an existing offer matching the given URL hash.
 * Returns the offer ID if found, null if no match.
 * Uses maybeSingle() to avoid throwing on no-match (unlike single()).
 */
export async function findExistingOfferByHash(
  db: DbClient,
  urlHash: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('offers')
    .select('id')
    .eq('destination_url_hash', urlHash)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to query offers by URL hash: ${error.message}`);
  }

  return data?.id ?? null;
}
