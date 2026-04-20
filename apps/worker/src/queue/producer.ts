import type { createClient } from '@repo/db';

type DbClient = ReturnType<typeof createClient>;

/**
 * Enqueue a post ID to tier1_queue for Haiku binary classification.
 * Throws if the Supabase RPC call fails — callers handle the error.
 */
export async function enqueueTier1(db: DbClient, postId: string): Promise<void> {
  const { error } = await db.rpc('pgmq_send', {
    queue_name: 'tier1_queue',
    msg: { post_id: postId },
  });

  if (error) {
    throw new Error(`Failed to enqueue post ${postId} to tier1_queue: ${error.message}`);
  }
}

/**
 * Enqueue a post ID to tier2_queue for Sonnet structured extraction.
 * Throws if the Supabase RPC call fails — callers handle the error.
 */
export async function enqueueTier2(db: DbClient, postId: string): Promise<void> {
  const { error } = await db.rpc('pgmq_send', {
    queue_name: 'tier2_queue',
    msg: { post_id: postId },
  });

  if (error) {
    throw new Error(`Failed to enqueue post ${postId} to tier2_queue: ${error.message}`);
  }
}
