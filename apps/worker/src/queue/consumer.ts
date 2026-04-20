import type { createClient } from '@repo/db';
import type { Json } from '@repo/db';
import { logger } from '../logger.js';
import { DLQ_RETRY_THRESHOLD } from '../config.js';

type DbClient = ReturnType<typeof createClient>;

/**
 * Resolves after the specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PgmqMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    post_id: string;
    [key: string]: unknown;
  };
}

/**
 * Send a failed message to the dead-letter queue and log the event.
 */
async function sendToDlq(
  db: DbClient,
  dlqName: string,
  msg: PgmqMessage,
  errorReason: string,
): Promise<void> {
  const dlqPayload: Json = {
    original_msg_id: msg.msg_id,
    original_message: msg.message as Json,
    read_ct: msg.read_ct,
    error: errorReason,
    failed_at: new Date().toISOString(),
  };

  const { error } = await db.rpc('pgmq_send', {
    queue_name: dlqName,
    msg: dlqPayload,
  });

  if (error) {
    logger.error('dlq_send_error', {
      dlq: dlqName,
      original_msg_id: msg.msg_id,
      error: error.message,
    });
  } else {
    logger.warn('message_routed_to_dlq', {
      dlq: dlqName,
      original_msg_id: msg.msg_id,
      read_ct: msg.read_ct,
      error: errorReason,
    });
  }
}

export interface ConsumerLoopOptions {
  db: DbClient;
  queueName: string;
  dlqName: string;
  visibilityTimeout: number;
  batchSize: number;
  shutdown: { stop: boolean };
  processMessage: (db: DbClient, postId: string) => Promise<void>;
}

/**
 * Generic pgmq consumer loop. Reads batches from queueName and calls
 * processMessage for each. Archives messages in a finally block using the
 * shouldArchive flag pattern. Routes messages exceeding DLQ_RETRY_THRESHOLD
 * to dlqName before archiving. Transient errors (below threshold) are not
 * archived — visibility timeout re-delivers them for retry.
 *
 * The loop runs until shutdown.stop is set to true.
 */
export async function runConsumerLoop(options: ConsumerLoopOptions): Promise<void> {
  const { db, queueName, dlqName, visibilityTimeout, batchSize, shutdown, processMessage } =
    options;

  while (!shutdown.stop) {
    const { data, error } = await db.rpc('pgmq_read', {
      queue_name: queueName,
      vt: visibilityTimeout,
      qty: batchSize,
    });

    if (error) {
      logger.error('consumer_read_error', { queue: queueName, error: error.message });
      await sleep(5000);
      continue;
    }

    const messages = (data ?? []) as PgmqMessage[];

    if (messages.length === 0) {
      await sleep(2000);
      continue;
    }

    for (const msg of messages) {
      if (shutdown.stop) break;

      let shouldArchive = false;

      try {
        await processMessage(db, msg.message.post_id);
        shouldArchive = true;
      } catch (err) {
        if (msg.read_ct >= DLQ_RETRY_THRESHOLD) {
          await sendToDlq(db, dlqName, msg, String(err));
          shouldArchive = true;
        } else {
          logger.warn('consumer_message_error_retryable', {
            queue: queueName,
            msg_id: msg.msg_id,
            read_ct: msg.read_ct,
            error: String(err),
          });
          // Do not archive — visibility timeout will re-deliver for retry
        }
      } finally {
        if (shouldArchive) {
          const { error: archiveError } = await db.rpc('pgmq_archive', {
            queue_name: queueName,
            msg_id: msg.msg_id,
          });

          if (archiveError) {
            logger.error('consumer_archive_error', {
              queue: queueName,
              msg_id: msg.msg_id,
              error: archiveError.message,
            });
          }
        }
      }
    }
  }

  logger.info('consumer_loop_stopped', { queue: queueName });
}
