import pLimit from 'p-limit';
import type { createClient } from '@repo/db';
import { logger } from '../logger.js';
import {
  VALIDATION_POLL_INTERVAL_MS,
  VALIDATION_CHECK_INTERVAL_DAYS,
  VALIDATION_RETRY_INTERVAL_HOURS,
  VALIDATION_WAF_RETRY_INTERVAL_HOURS,
  VALIDATION_JITTER_HOURS,
  VALIDATION_CONCURRENT_LIMIT,
} from '../config.js';
import { sleep } from '../queue/consumer.js';
import { checkLiveness } from './liveness-check.js';

type DbClient = ReturnType<typeof createClient>;

/**
 * Compute next_check_at as an ISO string for a normal recheck cycle.
 * Adds random jitter (0 to jitterHours hours) to spread load.
 */
function nextCheckAt(daysFromNow: number, jitterHours: number): string {
  const jitterMs = Math.random() * jitterHours * 60 * 60 * 1000;
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000 + jitterMs).toISOString();
}

/**
 * Compute next_check_at as an ISO string offset by hours (no jitter).
 * Used for failure retry and WAF retry intervals.
 */
function nextCheckAtHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

/**
 * Process a single offer: check liveness, write verification_log, update offers table.
 * Errors are caught individually — a single offer failure does not crash the cycle.
 */
async function validateOffer(
  db: DbClient,
  offer: { id: string; destination_url: string; consecutive_failures: number },
): Promise<void> {
  try {
    const result = await checkLiveness(offer.destination_url);

    // Write verification_log for every outcome (VAL-05)
    await db.from('verification_log').insert({
      offer_id: offer.id,
      http_status: result.httpStatus,
      is_live: result.isLive,
      dead_signals: result.deadSignals.length > 0 ? result.deadSignals : null,
      raw_response: result.rawText,
    });

    if (result.isWaf) {
      // Case A — WAF block: retry in 6 hours, do NOT increment consecutive_failures
      await db.from('offers').update({
        last_verified_at: new Date().toISOString(),
        next_check_at: nextCheckAtHours(VALIDATION_WAF_RETRY_INTERVAL_HOURS),
      }).eq('id', offer.id);

      logger.warn('validation_waf_blocked', {
        offer_id: offer.id,
        http_status: result.httpStatus,
      });
    } else if (result.isLive) {
      // Case B — Live: reset failures to 0, schedule normal 7-day cycle
      await db.from('offers').update({
        consecutive_failures: 0,
        last_verified_at: new Date().toISOString(),
        next_check_at: nextCheckAt(VALIDATION_CHECK_INTERVAL_DAYS, VALIDATION_JITTER_HOURS),
      }).eq('id', offer.id);

      logger.info('validation_offer_live', {
        offer_id: offer.id,
        http_status: result.httpStatus,
      });
    } else if (offer.consecutive_failures === 0) {
      // Case C — First failure: increment to 1, retry in 24 hours
      await db.from('offers').update({
        consecutive_failures: 1,
        last_verified_at: new Date().toISOString(),
        next_check_at: nextCheckAtHours(VALIDATION_RETRY_INTERVAL_HOURS),
      }).eq('id', offer.id);

      logger.warn('validation_first_failure', {
        offer_id: offer.id,
        http_status: result.httpStatus,
        dead_signals: result.deadSignals,
      });
    } else {
      // Case D — Second (or more) consecutive failure: expire the offer
      await db.from('offers').update({
        status: 'expired',
        consecutive_failures: offer.consecutive_failures + 1,
        last_verified_at: new Date().toISOString(),
      }).eq('id', offer.id);

      logger.info('validation_offer_expired', {
        offer_id: offer.id,
        consecutive_failures: offer.consecutive_failures + 1,
        http_status: result.httpStatus,
      });
    }
  } catch (err) {
    logger.error('validation_offer_error', {
      offer_id: offer.id,
      error: String(err),
    });
    // Do NOT re-throw — a single offer failure must not break the cycle
  }
}

/**
 * Run one validation cycle: query all due active offers and process them concurrently.
 * Exported for unit testing — use runValidationLoop for production use.
 */
export async function runValidationCycle(db: DbClient): Promise<void> {
  const { data: dueOffers, error: queryError } = await db
    .from('offers')
    .select('id, destination_url, consecutive_failures')
    .eq('status', 'active')
    .lte('next_check_at', new Date().toISOString());

  if (queryError) {
    throw new Error(`Failed to fetch due offers: ${queryError.message}`);
  }

  const offers: Array<{ id: string; destination_url: string; consecutive_failures: number }> =
    (dueOffers ?? []) as Array<{ id: string; destination_url: string; consecutive_failures: number }>;

  if (offers.length === 0) return;

  logger.info('validation_cycle_start', { due_count: offers.length });

  const limit = pLimit(VALIDATION_CONCURRENT_LIMIT);

  await Promise.all(
    offers.map((offer) => limit(() => validateOffer(db, offer))),
  );

  logger.info('validation_cycle_complete', { processed: offers.length });
}

/**
 * Validation loop — fourth concurrent loop in the worker process.
 *
 * Polls every 10 minutes for active offers with next_check_at <= now(),
 * performs HTTP liveness checks, and updates offer status/verification_log.
 *
 * The shutdown flag is checked between cycles — the loop exits cleanly on
 * SIGTERM/SIGINT matching the existing ingestion and consumer loop patterns.
 */
export async function runValidationLoop(
  db: DbClient,
  shutdown: { stop: boolean },
): Promise<void> {
  while (!shutdown.stop) {
    const cycleStart = Date.now();

    try {
      await runValidationCycle(db);
    } catch (err) {
      logger.error('validation_loop_error', { error: String(err) });
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, VALIDATION_POLL_INTERVAL_MS - elapsed);

    if (!shutdown.stop && remaining > 0) {
      await sleep(remaining);
    }
  }

  logger.info('validation_loop_stopped');
}
