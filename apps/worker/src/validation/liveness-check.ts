import * as cheerio from 'cheerio';
import { VALIDATION_REQUEST_TIMEOUT_MS, VALIDATION_RAW_RESPONSE_MAX_CHARS } from '../config.js';
import { DEAD_SIGNALS } from './dead-signals.js';

export interface LivenessResult {
  isLive: boolean;
  isWaf: boolean;
  httpStatus: number | null;
  deadSignals: string[];
  rawText: string | null;
}

/**
 * Check whether an offer URL is still live.
 *
 * Strategy:
 * 1. Try HEAD request first — fast, no body download.
 *    - 200-399: live, return immediately.
 *    - 403/429: WAF block — isWaf: true, not counted as failure.
 *    - 405 or network error: fall through to GET.
 *    - 404/410/5xx: fall through to GET (HEAD may not reflect true state).
 * 2. GET fallback — download body for dead signal analysis.
 *    - 200-399 with no dead signals: live.
 *    - 200-399 with dead signals: isLive: false (page says it's gone).
 *    - 403/429: WAF block.
 *    - 404/410/5xx: dead.
 *    - Network error: httpStatus: null.
 *
 * Never throws — all errors are captured in the return value.
 */
export async function checkLiveness(url: string): Promise<LivenessResult> {
  const headers = { 'User-Agent': 'FreeOffersMonitor/1.0' };

  // ── HEAD request ────────────────────────────────────────────────────────────
  let headStatus: number | null = null;
  let skipToGet = false;

  try {
    const headResponse = await fetch(url, {
      method: 'HEAD',
      headers,
      signal: AbortSignal.timeout(VALIDATION_REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });

    headStatus = headResponse.status;

    if (headStatus >= 200 && headStatus <= 399) {
      return { isLive: true, isWaf: false, httpStatus: headStatus, deadSignals: [], rawText: null };
    }

    if (headStatus === 403 || headStatus === 429) {
      return { isLive: false, isWaf: true, httpStatus: headStatus, deadSignals: [], rawText: null };
    }

    // 405, 404, 410, 5xx — fall through to GET
    skipToGet = true;
  } catch {
    // Network error on HEAD — fall through to GET
    skipToGet = true;
  }

  // headStatus assignment here only to satisfy TypeScript — skipToGet always true at this point
  void headStatus;
  void skipToGet;

  // ── GET fallback ─────────────────────────────────────────────────────────────
  try {
    const getResponse = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(VALIDATION_REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });

    const getStatus = getResponse.status;

    if (getStatus === 403 || getStatus === 429) {
      return { isLive: false, isWaf: true, httpStatus: getStatus, deadSignals: [], rawText: null };
    }

    if (getStatus === 404 || getStatus === 410 || getStatus >= 500) {
      return { isLive: false, isWaf: false, httpStatus: getStatus, deadSignals: [], rawText: null };
    }

    if (getStatus >= 200 && getStatus <= 399) {
      const bodyText = await getResponse.text();
      const $ = cheerio.load(bodyText);
      const pageText = $('body').text().toLowerCase();
      const foundSignals = DEAD_SIGNALS.filter((phrase) => pageText.includes(phrase));
      const rawText = pageText.slice(0, VALIDATION_RAW_RESPONSE_MAX_CHARS);

      if (foundSignals.length > 0) {
        return { isLive: false, isWaf: false, httpStatus: getStatus, deadSignals: foundSignals, rawText };
      }

      return { isLive: true, isWaf: false, httpStatus: getStatus, deadSignals: [], rawText };
    }

    // Any other status (1xx, etc.) — treat as dead
    return { isLive: false, isWaf: false, httpStatus: getStatus, deadSignals: [], rawText: null };
  } catch {
    // Network error on GET
    return { isLive: false, isWaf: false, httpStatus: null, deadSignals: [], rawText: null };
  }
}
