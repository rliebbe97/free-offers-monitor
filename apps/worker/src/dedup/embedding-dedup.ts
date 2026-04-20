import type { createClient } from '@repo/db';
import { EMBEDDING_SIMILARITY_THRESHOLD } from '../config.js';

type DbClient = ReturnType<typeof createClient>;

/**
 * Generate a 1024-dimensional text embedding using the Voyage AI API.
 *
 * Uses native fetch (not the voyageai SDK) to avoid ESM compatibility issues
 * with node-fetch as a transitive dependency on Node 22.
 *
 * Pins model to 'voyage-2' explicitly — the API default may change.
 * Asserts embedding.length === 1024 before returning — throws if wrong dimension.
 */
export async function embedText(text: string): Promise<number[]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model: 'voyage-2' }),
  });

  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = data.data[0]?.embedding;

  if (!embedding || embedding.length !== 1024) {
    throw new Error(`Expected 1024-dim embedding, got: ${embedding?.length ?? 'null'}`);
  }

  return embedding;
}

/**
 * Find an existing offer with a semantically similar embedding via pgvector cosine similarity.
 *
 * Calls the find_similar_offer SQL function (which sets ivfflat.probes = 10 internally).
 * The embedding is formatted as a pgvector literal string: '[0.1,0.2,...]'.
 *
 * Returns the offer ID if a match is found above the threshold, null otherwise.
 * Default threshold: EMBEDDING_SIMILARITY_THRESHOLD (0.85).
 */
export async function findSimilarOffer(
  db: DbClient,
  embedding: number[],
  threshold: number = EMBEDDING_SIMILARITY_THRESHOLD,
): Promise<string | null> {
  const vectorStr = `[${embedding.join(',')}]`;

  const { data, error } = await db.rpc('find_similar_offer', {
    query_embedding: vectorStr,
    similarity_threshold: threshold,
    match_count: 1,
  });

  if (error) {
    throw new Error(`find_similar_offer RPC failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return null;
  }

  const match = data[0] as { id: string; similarity: number };
  return match.id;
}
