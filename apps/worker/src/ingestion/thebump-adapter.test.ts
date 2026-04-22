import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock scraping-utils before importing adapter (vi.mock hoisting)
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
  extractExternalId: vi.fn((url: string) => {
    const match = url.match(/\/discussion\/(?:comment\/)?(\d+)/);
    if (!match) {
      throw new Error(`Cannot extract external_id from URL: ${url}`);
    }
    return match[1];
  }),
  SCRAPING_USER_AGENT: 'TestAgent/1.0',
}));

// Mock logger to avoid Axiom dependency in tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config to avoid env var validation
vi.mock('../config.js', () => ({
  SCRAPING_MAX_PAGES: 10,
  SCRAPING_REQUEST_TIMEOUT_MS: 15000,
  SCRAPING_MAX_RETRIES: 3,
  THEBUMP_BASE_URL: 'https://community.thebump.com',
}));

import { TheBumpAdapter, createTheBumpAdapter } from './thebump-adapter.js';
import { fetchWithRateLimit, respectfulDelay, extractExternalId } from './scraping-utils.js';
import { logger } from '../logger.js';

// ── Fixture loading ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const postListFixture = readFileSync(join(__dirname, '__fixtures__/thebump-post-list-page.html'), 'utf-8');
const challengeFixture = readFileSync(join(__dirname, '__fixtures__/thebump-challenge-page.html'), 'utf-8');
const emptyFixture = readFileSync(join(__dirname, '__fixtures__/thebump-empty-page.html'), 'utf-8');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TheBumpAdapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-setup mocks with implementations after reset
    vi.mocked(respectfulDelay).mockResolvedValue(undefined);
    vi.mocked(extractExternalId).mockImplementation((url: string) => {
      const match = url.match(/\/discussion\/(?:comment\/)?(\d+)/);
      if (!match) throw new Error(`Cannot extract external_id from URL: ${url}`);
      return match[1]!;
    });
  });

  describe('extractPostsFromPage (via fetchNewPosts)', () => {
    it('extracts posts from post-list fixture', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(postListFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const since = new Date('2020-01-01T00:00:00Z'); // far past to include all
      const posts = await adapter.fetchNewPosts(since);

      // Should have at least 1 non-sticky, non-admin post
      expect(posts.length).toBeGreaterThanOrEqual(1);

      // Each post should have required non-null fields
      for (const post of posts) {
        expect(post.external_id).toBeTruthy();
        expect(post.url).toBeTruthy();
        expect(post.external_id).toMatch(/^\d+$/);
      }
    });

    it('extracts correct external_id from discussion URLs', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(postListFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

      // Verify external_ids are numeric strings (BUMP-02)
      for (const post of posts) {
        expect(post.external_id).toMatch(/^\d+$/);
      }
    });

    it('body text contains no HTML tags (BUMP-06)', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(postListFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

      for (const post of posts) {
        if (post.body) {
          expect(post.body).not.toMatch(/<|>/);
        }
      }
    });

    it('parses dates from time[datetime] attribute (BUMP-04)', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(postListFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

      // At least one post should have a parsed date
      const withDates = posts.filter((p) => p.posted_at !== null);
      expect(withDates.length).toBeGreaterThanOrEqual(1);

      for (const post of withDates) {
        expect(post.posted_at).toBeInstanceOf(Date);
        expect(isNaN(post.posted_at!.getTime())).toBe(false);
      }
    });
  });

  describe('challenge page detection (BUMP-05)', () => {
    it('stops with challenge warning on challenge fixture', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(challengeFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

      // Should return empty results (challenge stops pagination)
      expect(posts).toEqual([]);

      // Should have logged challenge detection
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'thebump_challenge_detected',
        expect.objectContaining({ url: expect.any(String) }),
      );
    });
  });

  describe('empty page handling', () => {
    it('returns empty array for page with no posts', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(emptyFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

      expect(posts).toEqual([]);
    });
  });

  describe('pagination stop logging', () => {
    it('logs thebump_pagination_stop with reason field', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(emptyFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      await adapter.fetchNewPosts(new Date('2020-01-01'));

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'thebump_pagination_stop',
        expect.objectContaining({
          reason: expect.any(String),
        }),
      );
    });
  });

  describe('createTheBumpAdapter factory', () => {
    it('returns a TheBumpAdapter instance', () => {
      const adapter = createTheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      expect(adapter).toBeInstanceOf(TheBumpAdapter);
    });
  });

  describe('sticky/admin post skipping (D-09)', () => {
    it('skips sticky posts from fixture', async () => {
      vi.mocked(fetchWithRateLimit).mockResolvedValueOnce(
        new Response(postListFixture, { status: 200 }),
      );

      const adapter = new TheBumpAdapter('https://community.thebump.com/categories/freebies-and-deals');
      const posts = await adapter.fetchNewPosts(new Date('2020-01-01'));

      // None of the returned posts should be the sticky/admin welcome post
      const titles = posts.map((p) => p.title).filter(Boolean);
      for (const title of titles) {
        expect(title!.toLowerCase()).not.toContain('welcome to freebies');
      }
    });
  });
});
