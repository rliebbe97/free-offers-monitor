import type { createClient, Source } from '@repo/db';
import { logger } from '../logger.js';
import { passesKeywordFilter } from '../tiers/tier0.js';
import { enqueueTier1 } from '../queue/producer.js';
import { createRedditAdapter } from './reddit-adapter.js';
import { createTheBumpAdapter } from './thebump-adapter.js';
import type { SourceAdapter } from './source-adapter.js';

type DbClient = ReturnType<typeof createClient>;

/**
 * Create the appropriate adapter for a given source based on its type.
 * Throws on unknown source types — never silently skip.
 */
export function createAdapterForSource(source: Source): SourceAdapter {
  switch (source.type) {
    case 'reddit':
      return createRedditAdapter(source.identifier);
    case 'bump':
      return createTheBumpAdapter(source.identifier);
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
}

/**
 * Fetch all active sources from the sources table.
 */
export async function fetchActiveSources(db: DbClient): Promise<Source[]> {
  const { data, error } = await db
    .from('sources')
    .select('*');

  if (error) {
    throw new Error(`Failed to fetch active sources: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Run one full ingestion cycle across all active sources.
 *
 * For each source:
 * 1. Fetch new posts via source adapter (bot/deleted filtering happens in adapter)
 * 2. Upsert each post to the posts table (UNIQUE(source_id, external_id))
 * 3. Run Tier 0 keyword filter on combined title + body
 * 4. Update post with tier0_passed and pipeline_status
 * 5. Enqueue posts that pass Tier 0 to tier1_queue
 * 6. Update source.last_polled_at to now
 */
export async function runIngestionCycle(db: DbClient, sources: Source[]): Promise<void> {
  for (const source of sources) {
    const since = source.last_polled_at
      ? new Date(source.last_polled_at)
      : new Date(Date.now() - 60 * 60 * 1000); // fallback: 1 hour ago on first run

    logger.info('ingestion_cycle_start', {
      source_id: source.id,
      identifier: source.identifier,
      since: since.toISOString(),
    });

    const adapter = createAdapterForSource(source);
    let posts;
    try {
      posts = await adapter.fetchNewPosts(since);
    } catch (err) {
      logger.error('ingestion_fetch_error', {
        source_id: source.id,
        identifier: source.identifier,
        error: String(err),
      });
      continue;
    }

    let passedCount = 0;
    let rejectedCount = 0;

    for (const rawPost of posts) {
      // Step 1: Upsert the post — UNIQUE(source_id, external_id) prevents duplicates on re-poll
      const { data: upserted, error: upsertError } = await db
        .from('posts')
        .upsert(
          {
            source_id: source.id,
            external_id: rawPost.external_id,
            url: rawPost.url,
            title: rawPost.title,
            body: rawPost.body,
            author: rawPost.author,
            posted_at: rawPost.posted_at?.toISOString() ?? null,
            pipeline_status: 'ingested',
          },
          { onConflict: 'source_id,external_id' },
        )
        .select('id')
        .single();

      if (upsertError || !upserted) {
        logger.error('post_upsert_error', {
          source_id: source.id,
          external_id: rawPost.external_id,
          error: upsertError?.message ?? 'no data returned',
        });
        continue;
      }

      const postId: string = upserted.id;

      // Step 2: Run Tier 0 keyword filter on combined title + body text
      const combinedText = `${rawPost.title ?? ''} ${rawPost.body ?? ''}`;
      const passes = passesKeywordFilter(combinedText);

      // Step 3: Update post with Tier 0 result
      if (passes) {
        const { error: updateError } = await db
          .from('posts')
          .update({ tier0_passed: true, pipeline_status: 'tier0_passed' })
          .eq('id', postId);

        if (updateError) {
          logger.error('post_tier0_update_error', { post_id: postId, error: updateError.message });
          continue;
        }

        // Step 4: Enqueue to tier1_queue
        try {
          await enqueueTier1(db, postId);
          passedCount++;
        } catch (err) {
          logger.error('enqueue_tier1_error', { post_id: postId, error: String(err) });
        }
      } else {
        const { error: updateError } = await db
          .from('posts')
          .update({ tier0_passed: false, pipeline_status: 'tier0_rejected' })
          .eq('id', postId);

        if (updateError) {
          logger.error('post_tier0_reject_error', { post_id: postId, error: updateError.message });
        }
        rejectedCount++;
      }
    }

    // Step 5: Update source.last_polled_at to now
    const { error: sourceUpdateError } = await db
      .from('sources')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('id', source.id);

    if (sourceUpdateError) {
      logger.error('source_last_polled_update_error', {
        source_id: source.id,
        error: sourceUpdateError.message,
      });
    }

    logger.info('ingestion_cycle_complete', {
      source_id: source.id,
      identifier: source.identifier,
      total: posts.length,
      passed: passedCount,
      rejected: rejectedCount,
    });
  }
}
