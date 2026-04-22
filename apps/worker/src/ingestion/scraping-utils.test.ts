import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScrapeError, extractExternalId, respectfulDelay, fetchWithRetry, SCRAPING_USER_AGENT } from './scraping-utils.js';

describe('ScrapeError', () => {
  it('sets name, code, message, and url', () => {
    const err = new ScrapeError('NETWORK', 'connection failed', 'https://example.com');
    expect(err.name).toBe('ScrapeError');
    expect(err.code).toBe('NETWORK');
    expect(err.message).toBe('connection failed');
    expect(err.url).toBe('https://example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('url is optional', () => {
    const err = new ScrapeError('PARSE', 'bad html');
    expect(err.url).toBeUndefined();
  });
});

describe('extractExternalId', () => {
  it('extracts ID from /discussion/{id}/{slug}', () => {
    expect(extractExternalId('https://community.thebump.com/discussion/4829183/free-diapers-sample')).toBe('4829183');
  });

  it('extracts ID from /discussion/comment/{id}/p1', () => {
    expect(extractExternalId('https://community.thebump.com/discussion/comment/4829183/p1')).toBe('4829183');
  });

  it('extracts ID from /discussion/{id} without slug', () => {
    expect(extractExternalId('https://community.thebump.com/discussion/4829183')).toBe('4829183');
  });

  it('throws ScrapeError for URL without /discussion/', () => {
    expect(() => extractExternalId('https://community.thebump.com/categories/freebies')).toThrow(ScrapeError);
    try {
      extractExternalId('https://community.thebump.com/categories/freebies');
    } catch (err) {
      expect((err as ScrapeError).code).toBe('PARSE');
    }
  });

  it('throws ScrapeError for URL with non-numeric ID', () => {
    expect(() => extractExternalId('https://community.thebump.com/discussion/abc/slug')).toThrow(ScrapeError);
  });
});

describe('respectfulDelay', () => {
  it('resolves within 1-3 second range', async () => {
    const start = Date.now();
    await respectfulDelay();
    const elapsed = Date.now() - start;
    // Allow 100ms tolerance for CI jitter
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThanOrEqual(3_200);
  }, 4_000); // explicit timeout for CI environments
});

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Response on HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => '<html></html>',
    }));

    const response = await fetchWithRetry('https://example.com');
    expect(response.status).toBe(200);
  });

  it('throws on HTTP 404 without retrying (AbortError path)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 404,
      ok: false,
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchWithRetry('https://example.com', { retries: 3 })).rejects.toThrow();
    // Should only be called once — 404 aborts immediately
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 500 then succeeds', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ status: 500, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const response = await fetchWithRetry('https://example.com', { retries: 2 });
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sends User-Agent header', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ status: 200, ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await fetchWithRetry('https://example.com');
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({
      headers: { 'User-Agent': SCRAPING_USER_AGENT },
    });
  });
});

describe('SCRAPING_USER_AGENT', () => {
  it('contains FreeOffersMonitor identifier', () => {
    expect(SCRAPING_USER_AGENT).toContain('FreeOffersMonitor');
  });
});
