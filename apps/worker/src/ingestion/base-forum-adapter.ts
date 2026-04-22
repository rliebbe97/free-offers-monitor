import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { logger } from '../logger.js';
import { SCRAPING_MAX_PAGES } from '../config.js';
import type { RawPost, SourceAdapter } from './source-adapter.js';
import { fetchWithRateLimit, respectfulDelay, ScrapeError } from './scraping-utils.js';

export type { CheerioAPI } from 'cheerio';

export abstract class BaseForumAdapter implements SourceAdapter {
  protected abstract readonly startUrl: string;

  /**
   * Template method — owns the pagination loop.
   * Subclasses implement extractPostsFromPage and getNextPageUrl.
   */
  async fetchNewPosts(since: Date): Promise<RawPost[]> {
    const results: RawPost[] = [];
    let currentUrl: string | null = this.startUrl;
    let pageCount = 0;
    let stopReason: string = 'unknown';

    while (currentUrl && pageCount < SCRAPING_MAX_PAGES) {
      let $: CheerioAPI;
      try {
        $ = await this.fetchPage(currentUrl);
      } catch (err) {
        logger.error('forum_page_fetch_failed', {
          url: currentUrl,
          page: pageCount,
          error: String(err),
          code: err instanceof ScrapeError ? err.code : 'UNKNOWN',
        });
        stopReason = 'fetch_error';
        break; // D-06: stop pagination, return what we have
      }

      const posts = this.extractPostsFromPage($, currentUrl);

      for (const post of posts) {
        if (this.shouldSkipPost(post)) {
          logger.info('forum_skip_post', {
            external_id: post.external_id,
            url: post.url,
            reason: 'skip_filter',
          });
          continue;
        }
        results.push(post);
      }

      // Termination condition 2: oldest post on page is before `since`
      const postsWithDates = posts.filter((p) => p.posted_at !== null);
      if (postsWithDates.length > 0) {
        const oldestDate = postsWithDates.reduce(
          (oldest, p) => (p.posted_at! < oldest ? p.posted_at! : oldest),
          postsWithDates[0]!.posted_at!,
        );
        if (oldestDate < since) {
          stopReason = 'oldest_before_since';
          break;
        }
      }

      // Termination condition 1: no next page link
      const nextUrl = this.getNextPageUrl($);
      if (!nextUrl) {
        stopReason = 'no_next_link';
        break;
      }

      // URL validation: ensure next URL has a valid http(s) scheme
      try {
        const parsed = new URL(nextUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          logger.warn('forum_invalid_next_url', { url: nextUrl, reason: 'invalid_scheme' });
          stopReason = 'invalid_next_url';
          break;
        }
      } catch {
        logger.warn('forum_invalid_next_url', { url: nextUrl, reason: 'malformed_url' });
        stopReason = 'invalid_next_url';
        break;
      }

      await respectfulDelay(); // BUMP-08: 1-3s jitter between pages
      currentUrl = nextUrl;
      pageCount++;
    }

    // Termination condition 3: max pages reached
    if (pageCount >= SCRAPING_MAX_PAGES && stopReason === 'unknown') {
      stopReason = 'max_pages';
    }

    logger.info('thebump_pagination_stop', {
      url: this.startUrl,
      reason: stopReason,
      pages_fetched: pageCount + 1,
      posts_collected: results.length,
    });

    logger.info('forum_fetch_complete', {
      url: this.startUrl,
      count: results.length,
      pages_fetched: pageCount + 1,
    });

    return results;
  }

  /**
   * Fetches a URL and returns a parsed CheerioAPI instance.
   * Detects Cloudflare challenge pages (BUMP-05) before returning.
   */
  protected async fetchPage(url: string): Promise<CheerioAPI> {
    const response = await fetchWithRateLimit(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    // Cloudflare challenge detection (BUMP-05, D-07)
    const title = $('title').text().toLowerCase();
    if (title.includes('just a moment') || title.includes('checking your browser')) {
      logger.warn('thebump_challenge_detected', { url });
      throw new ScrapeError('CHALLENGE', 'Cloudflare challenge page detected', url);
    }

    return $;
  }

  /**
   * Default skip filter (D-03, D-08): empty/deleted body or body < 20 chars.
   * Subclasses override to add source-specific checks (call super first).
   */
  protected shouldSkipPost(post: RawPost): boolean {
    if (!post.body || post.body.trim().length < 20) return true;
    return false;
  }

  /**
   * Extract RawPost[] from one page of HTML.
   * Subclass implements selector logic for the specific forum.
   */
  protected abstract extractPostsFromPage($: CheerioAPI, pageUrl: string): RawPost[];

  /**
   * Find the "next page" pagination URL, or return null if no more pages.
   * Subclass implements selector logic for the specific forum.
   */
  protected abstract getNextPageUrl($: CheerioAPI): string | null;
}
