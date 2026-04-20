import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkLiveness } from './liveness-check.js';
import type { LivenessResult } from './liveness-check.js';

describe('checkLiveness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('HEAD 200 returns isLive: true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
    }));

    const result: LivenessResult = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(true);
    expect(result.isWaf).toBe(false);
    expect(result.httpStatus).toBe(200);
    expect(result.deadSignals).toEqual([]);
    expect(result.rawText).toBeNull();
  });

  it('HEAD 405 falls back to GET', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ status: 405 })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '<body>normal page with great content</body>',
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First call should be HEAD
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
    // Second call should be GET
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: 'GET' });
  });

  it('GET 403 returns isWaf: true', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ status: 403 });

    vi.stubGlobal('fetch', mockFetch);

    const result = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(false);
    expect(result.isWaf).toBe(true);
    expect(result.httpStatus).toBe(403);
  });

  it('GET 404 returns isLive: false', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ status: 404 });

    vi.stubGlobal('fetch', mockFetch);

    const result = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(false);
    expect(result.isWaf).toBe(false);
    expect(result.httpStatus).toBe(404);
  });

  it('network timeout returns httpStatus: null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new DOMException('signal timed out', 'TimeoutError'),
    ));

    const result = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(false);
    expect(result.isWaf).toBe(false);
    expect(result.httpStatus).toBeNull();
  });

  it('dead signal detection on GET 200 body', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '<body>This item is out of stock and no longer available</body>',
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(false);
    expect(result.isWaf).toBe(false);
    expect(result.deadSignals).toContain('out of stock');
    expect(result.deadSignals).toContain('no longer available');
  });

  it('case-insensitive dead signal matching', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => '<body>SOLD OUT</body>',
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await checkLiveness('https://example.com/offer');

    expect(result.isLive).toBe(false);
    expect(result.deadSignals).toContain('sold out');
  });
});
