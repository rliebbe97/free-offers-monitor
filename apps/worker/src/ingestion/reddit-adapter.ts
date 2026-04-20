// @ts-ignore — snoowrap ships its own types but they are incomplete in several places
import Snoowrap from 'snoowrap';
import { logger } from '../logger.js';
import { getEnvOrThrow } from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';

const BOT_PATTERNS = [/bot$/i, /_bot$/i, /_official$/i];
const BOT_NAMES = new Set(['AutoModerator']);

/**
 * Pure predicate — returns true if the post/comment should be skipped.
 * Exported separately for unit testing.
 *
 * @param author - The author name, or null if the account is deleted
 * @param body - The post/comment body text
 * @param distinguished - The Reddit "distinguished" field (e.g. 'moderator')
 */
export function shouldSkipAuthor(
  author: string | null,
  body: string | null,
  distinguished?: string | null,
): boolean {
  if (author === null) return true; // deleted account
  if (BOT_NAMES.has(author)) return true;
  if (BOT_PATTERNS.some((p) => p.test(author))) return true;
  if (distinguished === 'moderator') return true;
  if (body === '[deleted]' || body === '[removed]') return true;
  if ((body ?? '').trim().length < 20) return true;
  return false;
}

/**
 * Creates a snoowrap instance using refresh token OAuth.
 * Reads credentials from environment variables that have already been
 * validated by config.ts at worker startup.
 */
function createRedditClient(): Snoowrap {
  // @ts-ignore — snoowrap constructor types do not include refreshToken auth shape
  return new Snoowrap({
    userAgent: 'free-offers-monitor/1.0 by u/FreeOffersMonitorBot',
    clientId: getEnvOrThrow('REDDIT_CLIENT_ID'),
    clientSecret: getEnvOrThrow('REDDIT_CLIENT_SECRET'),
    refreshToken: getEnvOrThrow('REDDIT_REFRESH_TOKEN'),
  });
}

/**
 * Logs a warning when the Reddit API rate limit is running low.
 * snoowrap exposes ratelimitRemaining at runtime but it is not in the type definitions.
 */
function checkRateLimit(reddit: Snoowrap): void {
  // @ts-ignore — ratelimitRemaining exists at runtime but is missing from snoowrap type definitions
  const remaining: number | undefined = reddit.ratelimitRemaining;
  // @ts-ignore — ratelimitExpiration exists at runtime but is missing from snoowrap type definitions
  const resetAt: number | undefined = reddit.ratelimitExpiration;

  if (remaining !== undefined && remaining < 10) {
    logger.warn('reddit_ratelimit_low', { remaining, reset_at: resetAt });
  }
}

export class RedditAdapter implements SourceAdapter {
  private readonly reddit: Snoowrap;
  private readonly subreddit: string;

  constructor(reddit: Snoowrap, subredditName: string) {
    this.reddit = reddit;
    this.subreddit = subredditName;
  }

  async fetchNewPosts(since: Date): Promise<RawPost[]> {
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const results: RawPost[] = [];

    // @ts-ignore — getSubreddit returns a Subreddit object; getNew returns a Listing
    const listing = await this.reddit.getSubreddit(this.subreddit).getNew({ limit: 25 });
    checkRateLimit(this.reddit);

    // @ts-ignore — listing is iterable but its type does not expose iterator in all snoowrap versions
    for (const post of listing) {
      // @ts-ignore — post.created_utc is a unix timestamp; exists at runtime
      if (post.created_utc < sinceUnix) continue;

      // @ts-ignore — post.author may be null on deleted accounts
      const authorName: string | null = post.author ? post.author.name ?? null : null;
      // @ts-ignore — post.selftext is the post body
      const body: string | null = post.selftext ?? null;
      // @ts-ignore — post.distinguished is the moderation flag
      const distinguished: string | null = post.distinguished ?? null;

      if (shouldSkipAuthor(authorName, body, distinguished)) {
        logger.info('reddit_skip_post', {
          external_id: post.id,
          reason: 'bot_or_deleted',
          author: authorName,
        });
        continue;
      }

      // @ts-ignore — post.url is the post URL
      const postUrl: string = post.url ?? `https://reddit.com/r/${this.subreddit}/comments/${post.id}`;
      // @ts-ignore — post.title is the submission title
      const postTitle: string | null = post.title ?? null;
      // @ts-ignore — post.created_utc is seconds since epoch
      const postedAt = new Date((post.created_utc as number) * 1000);

      results.push({
        external_id: post.id as string,
        url: postUrl,
        title: postTitle,
        body,
        author: authorName,
        posted_at: postedAt,
      });

      // Fetch comments for this post (top-level + one reply deep)
      // @ts-ignore — post.comments is a CommentListing
      const topLevelComments = post.comments ?? [];

      for (const comment of topLevelComments) {
        // Skip MoreComments stubs — calling fetchMore() in the hot path costs extra API requests
        if (comment.constructor.name === 'MoreComments') continue;

        // @ts-ignore — comment.author may be null on deleted accounts
        const commentAuthor: string | null = comment.author ? comment.author.name ?? null : null;
        // @ts-ignore — comment.body is the comment text
        const commentBody: string | null = comment.body ?? null;
        // @ts-ignore — comment.distinguished is the moderation flag
        const commentDistinguished: string | null = comment.distinguished ?? null;

        if (shouldSkipAuthor(commentAuthor, commentBody, commentDistinguished)) {
          logger.info('reddit_skip_comment', {
            external_id: comment.id,
            reason: 'bot_or_deleted',
            author: commentAuthor,
          });
          continue;
        }

        // @ts-ignore — comment.permalink is the comment URL
        const commentUrl = `https://reddit.com${comment.permalink ?? ''}`;
        // @ts-ignore — comment.created_utc is seconds since epoch
        const commentPostedAt = new Date(((comment.created_utc as number) ?? 0) * 1000);

        results.push({
          external_id: comment.id as string,
          url: commentUrl,
          title: null,
          body: commentBody,
          author: commentAuthor,
          posted_at: commentPostedAt,
        });

        // One reply deep
        // @ts-ignore — comment.replies is a CommentListing or empty array
        const replies = comment.replies ?? [];
        for (const reply of replies) {
          if (reply.constructor.name === 'MoreComments') continue;

          // @ts-ignore — reply.author may be null on deleted accounts
          const replyAuthor: string | null = reply.author ? reply.author.name ?? null : null;
          // @ts-ignore — reply.body is the reply text
          const replyBody: string | null = reply.body ?? null;
          // @ts-ignore — reply.distinguished is the moderation flag
          const replyDistinguished: string | null = reply.distinguished ?? null;

          if (shouldSkipAuthor(replyAuthor, replyBody, replyDistinguished)) {
            logger.info('reddit_skip_reply', {
              external_id: reply.id,
              reason: 'bot_or_deleted',
              author: replyAuthor,
            });
            continue;
          }

          // @ts-ignore — reply.permalink is the reply URL
          const replyUrl = `https://reddit.com${reply.permalink ?? ''}`;
          // @ts-ignore — reply.created_utc is seconds since epoch
          const replyPostedAt = new Date(((reply.created_utc as number) ?? 0) * 1000);

          results.push({
            external_id: reply.id as string,
            url: replyUrl,
            title: null,
            body: replyBody,
            author: replyAuthor,
            posted_at: replyPostedAt,
          });
        }
      }

      checkRateLimit(this.reddit);
    }

    logger.info('reddit_fetch_complete', {
      subreddit: this.subreddit,
      count: results.length,
    });

    return results;
  }
}

/**
 * Factory function — creates a snoowrap client and returns a RedditAdapter instance.
 */
export function createRedditAdapter(subredditName: string): RedditAdapter {
  const reddit = createRedditClient();
  return new RedditAdapter(reddit, subredditName);
}
