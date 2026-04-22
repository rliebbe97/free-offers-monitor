import type { CheerioAPI } from 'cheerio';
import { logger } from '../logger.js';
import { THEBUMP_BASE_URL } from '../config.js';
import type { RawPost } from './source-adapter.js';
import { BaseForumAdapter } from './base-forum-adapter.js';
import { ScrapeError, extractExternalId } from './scraping-utils.js';

/**
 * Parse a date from a <time> element.
 * Priority: datetime attribute (ISO 8601) > text content (relative date) > null.
 */
function parsePostDate(datetimeAttr: string | undefined, textContent: string): Date | null {
  // 1. Try ISO 8601 datetime attribute
  if (datetimeAttr) {
    const date = new Date(datetimeAttr);
    if (!isNaN(date.getTime())) return date;
  }

  // 2. Try relative date parsing from text content
  const relativeDate = parseRelativeDate(textContent.trim());
  if (relativeDate) return relativeDate;

  // 3. Fall through to null (never silently drop)
  return null;
}

/**
 * Parse English relative date strings like "2 hours ago", "3 days ago".
 * Returns null if the string doesn't match a known pattern.
 */
function parseRelativeDate(text: string): Date | null {
  const match = text.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!match) return null;

  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const now = new Date();

  const multipliers: Record<string, number> = {
    second: 1_000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000, // ~30 days
    year: 31_536_000_000, // ~365 days
  };

  const ms = multipliers[unit];
  if (!ms) return null;

  return new Date(now.getTime() - amount * ms);
}

export class TheBumpAdapter extends BaseForumAdapter {
  protected readonly startUrl: string;

  constructor(sourceIdentifier: string) {
    super();
    this.startUrl = sourceIdentifier;
  }

  protected extractPostsFromPage($: CheerioAPI, pageUrl: string): RawPost[] {
    const posts: RawPost[] = [];

    // Target semantic selectors over build-hash class names
    // Vanilla Forums: li.ItemDiscussion contains each thread
    $('li.ItemDiscussion').each((_index, element) => {
      try {
        const $el = $(element);

        // Skip sticky/pinned threads (D-09)
        if ($el.hasClass('isSticky')) {
          logger.info('thebump_skip_post', {
            url: pageUrl,
            reason: 'sticky_thread',
          });
          return; // continue to next .each() iteration
        }

        // Skip admin/staff posts (D-09)
        if ($el.find('.RoleBadge').length > 0) {
          logger.info('thebump_skip_post', {
            url: pageUrl,
            reason: 'admin_post',
          });
          return;
        }

        // Extract URL and external_id from the title link
        const titleLink = $el.find('.Title a').first();
        const href = titleLink.attr('href');
        if (!href) return; // skip posts without a link

        // Build full URL if relative
        const url = href.startsWith('http') ? href : `${THEBUMP_BASE_URL}${href}`;

        // Extract numeric external_id (BUMP-02)
        const externalId = extractExternalId(url);

        // Extract title
        const title = titleLink.text().trim() || null;

        // Extract body text — .text() only, never .html() (BUMP-06)
        const bodyEl = $el.find('[data-role="commentBody"] .userContent-body').first();
        let body: string | null = null;
        if (bodyEl.length > 0) {
          body = bodyEl.text().trim().replace(/\s+/g, ' ') || null;

          // Validate no HTML tags leaked into body text
          if (body && /<|>/.test(body)) {
            throw new ScrapeError('PARSE', `HTML leaked into body text for post ${externalId}`, url);
          }
        }

        // Extract author
        const authorEl = $el.find('[rel="author"], .Username').first();
        const author = authorEl.text().trim() || null;

        // Extract date (BUMP-04)
        const timeEl = $el.find('time').first();
        const datetimeAttr = timeEl.attr('datetime');
        const timeText = timeEl.text();
        const postedAt = parsePostDate(datetimeAttr, timeText);

        posts.push({
          external_id: externalId,
          url,
          title,
          body,
          author,
          posted_at: postedAt,
        });
      } catch (err) {
        // Log parse error for individual post but continue to next
        if (err instanceof ScrapeError) {
          logger.warn('thebump_post_parse_error', {
            page_url: pageUrl,
            error: err.message,
            code: err.code,
          });
        } else {
          logger.warn('thebump_post_parse_error', {
            page_url: pageUrl,
            error: String(err),
          });
        }
      }
    });

    return posts;
  }

  protected getNextPageUrl($: CheerioAPI): string | null {
    // Vanilla Forums: a.NextPage or a[rel="next"]
    const nextLink = $('a.NextPage, a[rel="next"]').first();
    const href = nextLink.attr('href');
    if (!href) return null;

    // Build full URL if relative
    const url = href.startsWith('http') ? href : `${THEBUMP_BASE_URL}${href}`;

    // Validate URL starts with expected base URL
    if (!url.startsWith(THEBUMP_BASE_URL)) {
      logger.warn('thebump_unexpected_next_url', { url, expected_base: THEBUMP_BASE_URL });
      return null;
    }

    return url;
  }
}

/**
 * Factory function — creates and returns a TheBumpAdapter instance.
 * Follows the createRedditAdapter pattern.
 */
export function createTheBumpAdapter(sourceIdentifier: string): TheBumpAdapter {
  return new TheBumpAdapter(sourceIdentifier);
}
