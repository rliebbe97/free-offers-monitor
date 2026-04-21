import pRetry, { AbortError } from 'p-retry';
import pThrottle from 'p-throttle';
import { logger } from '../logger.js';
import { SCRAPING_REQUEST_TIMEOUT_MS, SCRAPING_MAX_RETRIES } from '../config.js';

export const SCRAPING_USER_AGENT = 'FreeOffersMonitor/1.0 (+https://github.com/rliebbe97)';

export type ScrapeErrorCode = 'NETWORK' | 'PARSE' | 'CHALLENGE' | 'TIMEOUT';

export class ScrapeError extends Error {
  readonly code: ScrapeErrorCode;
  readonly url?: string;

  constructor(code: ScrapeErrorCode, message: string, url?: string) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.url = url;
  }
}

export async function fetchWithRetry(
  url: string,
  options?: {
    timeoutMs?: number;
    retries?: number;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? SCRAPING_REQUEST_TIMEOUT_MS;
  const retries = options?.retries ?? SCRAPING_MAX_RETRIES;

  return pRetry(
    async () => {
      const response = await fetch(url, {
        signal: options?.signal ?? AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': SCRAPING_USER_AGENT },
      });

      // 404/410 are permanent — abort immediately, no retry
      if (response.status === 404 || response.status === 410) {
        throw new AbortError(`HTTP ${response.status} for ${url}`);
      }

      if (!response.ok) {
        throw new ScrapeError('NETWORK', `HTTP ${response.status} for ${url}`, url);
      }

      return response;
    },
    {
      retries,
      minTimeout: 1_000,
      factor: 2,
      randomize: true,
      onFailedAttempt: (error) => {
        logger.warn('scrape_fetch_retry', {
          url,
          attempt: error.attemptNumber,
          retries_left: error.retriesLeft,
          error: String(error),
        });
      },
    },
  );
}

export async function respectfulDelay(): Promise<void> {
  const ms = 1_000 + Math.random() * 2_000; // 1-3 seconds
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const throttle = pThrottle({ limit: 1, interval: 2_000 });
export const fetchWithRateLimit = throttle(fetchWithRetry);

export function extractExternalId(url: string): string {
  const match = url.match(/\/discussion\/(?:comment\/)?(\d+)/);
  if (!match) {
    throw new ScrapeError('PARSE', `Cannot extract external_id from URL: ${url}`, url);
  }
  const id = match[1]!;
  if (!/^\d+$/.test(id)) {
    throw new ScrapeError('PARSE', `Invalid external_id "${id}" from URL: ${url}`, url);
  }
  return id;
}
