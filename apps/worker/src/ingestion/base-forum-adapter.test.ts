import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheerioAPI } from 'cheerio';

vi.mock('./scraping-utils.js', () => ({
  fetchWithRateLimit: vi.fn(),
  respectfulDelay: vi.fn().mockResolvedValue(undefined),
  ScrapeError: class ScrapeError extends Error {
    code: string;
    url?: string;
    constructor(code: string, message: string, url?: string) {
      super(message);
      this.name = 'ScrapeError';
      this.code = code;
      this.url = url;
    }
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  SCRAPING_MAX_PAGES: 3,
}));

import { BaseForumAdapter } from './base-forum-adapter.js';
import type { RawPost } from './source-adapter.js';
import { fetchWithRateLimit, respectfulDelay } from './scraping-utils.js';
import { logger } from '../logger.js';

// ── Concrete TestForumAdapter subclass ───────────────────────────────────────

class TestForumAdapter extends BaseForumAdapter {
  protected readonly startUrl = 'https://example.com/forum';

  protected extractPostsFromPage($: CheerioAPI, _pageUrl: string): RawPost[] {
    const posts: RawPost[] = [];
    $('li.post').each((_i, el) => {
      const $el = $(el);
      posts.push({
        external_id: $el.attr('data-id') ?? 'unknown',
        url: `https://example.com/post/${$el.attr('data-id')}`,
        title: $el.find('.title').text() || null,
        body: $el.find('.body').text() || null,
        author: null,
        posted_at: new Date('2026-01-15'),
      });
    });
    return posts;
  }

  protected getNextPageUrl($: CheerioAPI): string | null {
    const href = $('a.next').attr('href');
    return href ?? null;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BaseForumAdapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-setup delay mock after reset so it always resolves immediately
    vi.mocked(respectfulDelay).mockResolvedValue(undefined);
  });

  it('returns posts from a single page with no next link', async () => {
    const html = '<ul><li class="post" data-id="1"><span class="title">Test</span><span class="body">This is a test post body text</span></li></ul>';
    vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
      new Response(html, { status: 200 }),
    );

    const adapter = new TestForumAdapter();
    const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

    expect(posts).toHaveLength(1);
    expect(posts[0]!.external_id).toBe('1');
  });

  it('stops at SCRAPING_MAX_PAGES', async () => {
    const pageHtml = (n: number) =>
      `<ul><li class="post" data-id="${n}"><span class="title">Post ${n}</span><span class="body">Body text for post number ${n}</span></li></ul><a class="next" href="https://example.com/forum/p${n + 1}">Next</a>`;

    for (let i = 1; i <= 4; i++) {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(pageHtml(i), { status: 200 }),
      );
    }

    const adapter = new TestForumAdapter();
    const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

    // SCRAPING_MAX_PAGES is mocked to 3
    expect(posts.length).toBeLessThanOrEqual(3);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'thebump_pagination_stop',
      expect.objectContaining({ reason: 'max_pages' }),
    );
  });

  it('stops when oldest post is before since date', async () => {
    const html = '<ul><li class="post" data-id="1"><span class="title">Old</span><span class="body">Old post body text content</span></li></ul><a class="next" href="https://example.com/forum/p2">Next</a>';
    vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
      new Response(html, { status: 200 }),
    );

    const adapter = new TestForumAdapter();
    // Since date is after the post date (2026-01-15)
    const posts = await adapter.fetchNewPosts(new Date('2026-06-01'));

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'thebump_pagination_stop',
      expect.objectContaining({ reason: 'oldest_before_since' }),
    );
  });

  it('detects Cloudflare challenge page', async () => {
    const challengeHtml = '<html><head><title>Just a moment...</title></head><body></body></html>';
    vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
      new Response(challengeHtml, { status: 200 }),
    );

    const adapter = new TestForumAdapter();
    const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

    expect(posts).toEqual([]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'thebump_challenge_detected',
      expect.any(Object),
    );
  });

  it('skips posts with body shorter than 20 chars via shouldSkipPost', async () => {
    const html = '<ul><li class="post" data-id="1"><span class="title">Short</span><span class="body">Too short</span></li></ul>';
    vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
      new Response(html, { status: 200 }),
    );

    const adapter = new TestForumAdapter();
    const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

    expect(posts).toEqual([]);
  });

  it('returns partial results on fetch error (D-06)', async () => {
    const html = '<ul><li class="post" data-id="1"><span class="title">Good</span><span class="body">This is a valid post body</span></li></ul><a class="next" href="https://example.com/forum/p2">Next</a>';
    vi.mocked(fetchWithRateLimit)
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockRejectedValueOnce(new Error('Network error'));

    const adapter = new TestForumAdapter();
    const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

    expect(posts).toHaveLength(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'forum_page_fetch_failed',
      expect.any(Object),
    );
  });
});
