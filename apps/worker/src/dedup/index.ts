import type { createClient } from '@repo/db';
import type { OfferExtraction } from '../tiers/schemas.js';
import { logger } from '../logger.js';
import { normalizeAndHash, findExistingOfferByHash } from './url-hash.js';
import { embedText, findSimilarOffer } from './embedding-dedup.js';

type DbClient = ReturnType<typeof createClient>;

/**
 * Insert a link between a post and an offer in the post_offers join table.
 * Idempotent via ON CONFLICT DO NOTHING (primary key is (post_id, offer_id)).
 */
export async function linkPostToOffer(
  db: DbClient,
  postId: string,
  offerId: string,
): Promise<void> {
  const { error } = await db.from('post_offers').insert({ post_id: postId, offer_id: offerId });

  if (error) {
    // ON CONFLICT DO NOTHING — Supabase returns null error for no-op conflicts
    // but if there's a genuine error, re-throw
    if (!error.message.toLowerCase().includes('duplicate') &&
        !error.message.toLowerCase().includes('unique') &&
        !error.message.toLowerCase().includes('conflict')) {
      throw new Error(`Failed to link post ${postId} to offer ${offerId}: ${error.message}`);
    }
    // Already linked — idempotent, ignore
  }
}

/**
 * Orchestrate the full deduplication pipeline for a new extracted offer.
 *
 * Step 1 — URL hash check (O(1), runs FIRST to avoid unnecessary Voyage API calls):
 *   - Normalizes URL and computes SHA-256 hash
 *   - Queries offers.destination_url_hash index for exact match
 *   - On match: links post to existing offer, returns { offerId, isNew: false }
 *
 * Step 2 — Embedding check (only on hash miss):
 *   - Builds embed input from title + description + normalized URL
 *   - Calls Voyage AI to generate 1024-dim embedding
 *   - Queries find_similar_offer RPC with cosine similarity threshold 0.85
 *   - On match: links post to existing offer, returns { offerId, isNew: false }
 *
 * Step 3 — Create new offer (no match):
 *   - Inserts into offers table with ON CONFLICT (destination_url_hash) DO NOTHING
 *   - On conflict (concurrent insert race): re-queries by hash to get existing offer ID
 *   - Links post to offer (new or existing)
 *   - Returns { offerId, isNew: true } (or isNew: false on conflict race)
 */
export async function runDedup(options: {
  db: DbClient;
  postId: string;
  extraction: OfferExtraction;
}): Promise<{ offerId: string; isNew: boolean }> {
  const { db, postId, extraction } = options;

  // Invariant: tier2 routes null-URL extractions to human_review_queue before
  // dedup is reached. If we land here with a null URL, the upstream guard is
  // broken — fail loudly rather than insert a hash-less offer.
  if (extraction.destination_url === null) {
    throw new Error(
      `runDedup invoked with null destination_url for post ${postId} — should have been routed to review_queue`,
    );
  }

  // Step 1: URL hash check
  const { normalizedUrl, hash } = await normalizeAndHash(extraction.destination_url);

  const existingByHash = await findExistingOfferByHash(db, hash);
  if (existingByHash) {
    logger.info('dedup_hash_match', {
      post_id: postId,
      offer_id: existingByHash,
      hash,
    });

    await linkPostToOffer(db, postId, existingByHash);
    return { offerId: existingByHash, isNew: false };
  }

  // Step 2: Embedding check (hash miss — fall through to semantic dedup)
  let embedding: number[] | null = null;
  let existingByEmbedding: string | null = null;

  try {
    const embedInput = `${extraction.title}\n${extraction.description ?? ''}\n${normalizedUrl}`.trim();
    embedding = await embedText(embedInput);
    existingByEmbedding = await findSimilarOffer(db, embedding);
  } catch (embedErr) {
    // Embedding failure should not block the pipeline — log and continue to offer creation
    logger.warn('dedup_embedding_error', {
      post_id: postId,
      error: String(embedErr),
    });
    embedding = null;
  }

  if (existingByEmbedding) {
    logger.info('dedup_embedding_match', {
      post_id: postId,
      offer_id: existingByEmbedding,
    });

    await linkPostToOffer(db, postId, existingByEmbedding);
    return { offerId: existingByEmbedding, isNew: false };
  }

  // Step 3: No match — create new offer
  const nextCheckAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Format embedding as pgvector literal string if available
  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

  const { data: insertedOffer, error: insertError } = await db
    .from('offers')
    .insert({
      destination_url: normalizedUrl,
      destination_url_hash: hash,
      title: extraction.title,
      description: extraction.description ?? null,
      brand: extraction.brand ?? null,
      category: extraction.category ?? null,
      offer_type: extraction.offer_type ?? null,
      shipping_cost: extraction.shipping_cost,
      restrictions: extraction.restrictions.length > 0 ? extraction.restrictions : null,
      embedding: embeddingStr,
      extraction_confidence: extraction.confidence,
      status: 'active',
      next_check_at: nextCheckAt,
    })
    .select('id')
    .single();

  if (insertError) {
    // Check if this is a hash collision from a concurrent insert race
    const isHashConflict =
      insertError.message.toLowerCase().includes('duplicate') ||
      insertError.message.toLowerCase().includes('unique') ||
      insertError.message.toLowerCase().includes('conflict');

    if (isHashConflict) {
      // Re-query by hash to get the winning offer ID
      logger.info('dedup_offer_insert_conflict', {
        post_id: postId,
        hash,
        error: insertError.message,
      });

      const racedOffer = await findExistingOfferByHash(db, hash);
      if (!racedOffer) {
        throw new Error(
          `Concurrent insert conflict for hash ${hash} but re-query found no offer`,
        );
      }

      await linkPostToOffer(db, postId, racedOffer);
      return { offerId: racedOffer, isNew: false };
    }

    throw new Error(`Failed to insert new offer: ${insertError.message}`);
  }

  if (!insertedOffer) {
    // No row returned without error — treat as conflict (ON CONFLICT DO NOTHING would return no row)
    // Actually .single() throws if no row, so if we got here the insert likely succeeded
    // This is a defensive guard
    const racedOffer = await findExistingOfferByHash(db, hash);
    if (!racedOffer) {
      throw new Error(`Offer insert returned no row and re-query found no offer for hash ${hash}`);
    }

    await linkPostToOffer(db, postId, racedOffer);
    return { offerId: racedOffer, isNew: false };
  }

  const newOfferId = insertedOffer.id;

  logger.info('dedup_new_offer_created', {
    post_id: postId,
    offer_id: newOfferId,
    url: normalizedUrl,
    has_embedding: embedding !== null,
  });

  await linkPostToOffer(db, postId, newOfferId);
  return { offerId: newOfferId, isNew: true };
}
