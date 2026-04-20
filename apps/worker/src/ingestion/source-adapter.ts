/**
 * A raw post fetched from an external source (Reddit, Discourse, etc.)
 * before any normalization or DB writes.
 */
export interface RawPost {
  external_id: string;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  posted_at: Date | null;
}

/**
 * Contract that every ingestion adapter must implement.
 * Implementations: RedditAdapter (apps/worker/src/ingestion/reddit-adapter.ts)
 */
export interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
