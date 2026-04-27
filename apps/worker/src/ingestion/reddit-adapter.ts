import pRetry, { AbortError } from 'p-retry';
import { logger } from '../logger.js';
import {
  REDDIT_BASE_URL,
  REDDIT_USER_AGENT,
  SCRAPING_REQUEST_TIMEOUT_MS,
  SCRAPING_MAX_RETRIES,
} from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';

const BOT_PATTERNS = [/bot$/i, /_bot$/i, /_official$/i];
const BOT_NAMES = new Set(['AutoModerator']);

/**
 * Pure predicate — returns true if the post/comment should be skipped.
 * Exported separately for unit testing.
 */
export function shouldSkipAuthor(
  author: string | null,
  body: string | null,
  distinguished?: string | null,
): boolean {
  if (author === null) return true;
  if (BOT_NAMES.has(author)) return true;
  if (BOT_PATTERNS.some((p) => p.test(author))) return true;
  if (distinguished === 'moderator') return true;
  if (body === '[deleted]' || body === '[removed]') return true;
  if ((body ?? '').trim().length < 20) return true;
  return false;
}

interface RedditPostData {
  id: string;
  title: string | null;
  selftext: string | null;
  author: string | null;
  url?: string;
  permalink: string;
  created_utc: number;
  distinguished: string | null;
}

interface RedditCommentData {
  id: string;
  author: string | null;
  body: string | null;
  permalink: string;
  created_utc: number;
  distinguished: string | null;
  replies?: RedditCommentListing | '';
}

interface RedditListingChild<T> {
  kind: string;
  data: T;
}

interface RedditCommentListing {
  kind: 'Listing';
  data: { children: RedditListingChild<RedditCommentData>[] };
}

interface RedditPostListing {
  kind: 'Listing';
  data: { children: RedditListingChild<RedditPostData>[] };
}

type RedditCommentsResponse = [RedditPostListing, RedditCommentListing];

async function redditFetchJson<T>(url: string): Promise<T> {
  const response = await pRetry(
    async () => {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(SCRAPING_REQUEST_TIMEOUT_MS),
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (r.status === 404 || r.status === 410) {
        throw new AbortError(`HTTP ${r.status} for ${url}`);
      }
      if (!r.ok) {
        throw new Error(`HTTP ${r.status} for ${url}`);
      }
      return r;
    },
    {
      retries: SCRAPING_MAX_RETRIES,
      minTimeout: 2_000,
      factor: 2,
      randomize: true,
      onFailedAttempt: (error) => {
        logger.warn('reddit_fetch_retry', {
          url,
          attempt: error.attemptNumber,
          retries_left: error.retriesLeft,
          error: String(error),
        });
      },
    },
  );

  return (await response.json()) as T;
}

export class RedditAdapter implements SourceAdapter {
  private readonly subreddit: string;

  constructor(subredditName: string) {
    this.subreddit = subredditName;
  }

  async fetchNewPosts(since: Date): Promise<RawPost[]> {
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const results: RawPost[] = [];

    const listingUrl = `${REDDIT_BASE_URL}/r/${this.subreddit}/new.json?limit=25&raw_json=1`;
    const listing = await redditFetchJson<RedditPostListing>(listingUrl);

    for (const child of listing.data.children) {
      if (child.kind !== 't3') continue;
      const post = child.data;

      if (post.created_utc < sinceUnix) continue;

      if (shouldSkipAuthor(post.author, post.selftext, post.distinguished)) {
        logger.info('reddit_skip_post', {
          external_id: post.id,
          reason: 'bot_or_deleted',
          author: post.author,
        });
        continue;
      }

      const postUrl = post.url ?? `https://reddit.com${post.permalink}`;

      results.push({
        external_id: post.id,
        url: postUrl,
        title: post.title,
        body: post.selftext,
        author: post.author,
        posted_at: new Date(post.created_utc * 1000),
      });

      const commentsUrl = `${REDDIT_BASE_URL}/r/${this.subreddit}/comments/${post.id}.json?limit=top&depth=2&raw_json=1`;
      let commentsResp: RedditCommentsResponse;
      try {
        commentsResp = await redditFetchJson<RedditCommentsResponse>(commentsUrl);
      } catch (err) {
        logger.warn('reddit_comments_fetch_failed', {
          post_id: post.id,
          error: String(err),
        });
        continue;
      }

      const commentChildren = commentsResp[1]?.data.children ?? [];
      for (const c of commentChildren) {
        if (c.kind !== 't1') continue;
        const comment = c.data;

        if (shouldSkipAuthor(comment.author, comment.body, comment.distinguished)) {
          logger.info('reddit_skip_comment', {
            external_id: comment.id,
            reason: 'bot_or_deleted',
            author: comment.author,
          });
          continue;
        }

        results.push({
          external_id: comment.id,
          url: `https://reddit.com${comment.permalink}`,
          title: null,
          body: comment.body,
          author: comment.author,
          posted_at: new Date(comment.created_utc * 1000),
        });

        const replies =
          typeof comment.replies === 'object' && comment.replies !== null
            ? comment.replies.data.children
            : [];

        for (const r of replies) {
          if (r.kind !== 't1') continue;
          const reply = r.data;

          if (shouldSkipAuthor(reply.author, reply.body, reply.distinguished)) {
            logger.info('reddit_skip_reply', {
              external_id: reply.id,
              reason: 'bot_or_deleted',
              author: reply.author,
            });
            continue;
          }

          results.push({
            external_id: reply.id,
            url: `https://reddit.com${reply.permalink}`,
            title: null,
            body: reply.body,
            author: reply.author,
            posted_at: new Date(reply.created_utc * 1000),
          });
        }
      }
    }

    logger.info('reddit_fetch_complete', {
      subreddit: this.subreddit,
      count: results.length,
    });

    return results;
  }
}

export function createRedditAdapter(subredditName: string): RedditAdapter {
  return new RedditAdapter(subredditName);
}
