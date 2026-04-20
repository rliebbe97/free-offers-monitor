import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock liveness-check before importing validation-loop so vi.mock hoisting works
vi.mock('./liveness-check.js', () => ({
  checkLiveness: vi.fn(),
}));

// No need to mock sleep — tests call runValidationCycle directly (not the loop)
import { runValidationCycle } from './validation-loop.js';
import { checkLiveness } from './liveness-check.js';
import type { LivenessResult } from './liveness-check.js';

// ── Mock DB factory ─────────────────────────────────────────────────────────

function createMockDb(selectResult: Array<{ id: string; destination_url: string; consecutive_failures: number }>) {
  const insertFn = vi.fn().mockResolvedValue({ error: null });
  const updateChain = {
    eq: vi.fn().mockResolvedValue({ error: null }),
  };
  const updateFn = vi.fn().mockReturnValue(updateChain);
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    lte: vi.fn().mockResolvedValue({ data: selectResult, error: null }),
  };
  const selectFn = vi.fn().mockReturnValue(selectChain);

  return {
    from: vi.fn((table: string) => {
      if (table === 'verification_log') return { insert: insertFn };
      return { select: selectFn, update: updateFn, insert: insertFn };
    }),
    _insertFn: insertFn,
    _updateFn: updateFn,
    _updateChain: updateChain,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runValidationCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first failure sets consecutive_failures=1, status stays active', async () => {
    const offer = { id: 'offer-1', destination_url: 'https://example.com', consecutive_failures: 0 };
    vi.mocked(checkLiveness).mockResolvedValue({
      isLive: false,
      isWaf: false,
      httpStatus: 404,
      deadSignals: [],
      rawText: null,
    } satisfies LivenessResult);

    const db = createMockDb([offer]);
    await runValidationCycle(db as unknown as Parameters<typeof runValidationCycle>[0]);

    expect(db._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ consecutive_failures: 1 }),
    );
    // status: 'expired' should NOT be set on first failure
    const updateArg = db._updateFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(updateArg['status']).toBeUndefined();
  });

  it('second consecutive failure sets status to expired', async () => {
    const offer = { id: 'offer-2', destination_url: 'https://example.com', consecutive_failures: 1 };
    vi.mocked(checkLiveness).mockResolvedValue({
      isLive: false,
      isWaf: false,
      httpStatus: 404,
      deadSignals: [],
      rawText: null,
    } satisfies LivenessResult);

    const db = createMockDb([offer]);
    await runValidationCycle(db as unknown as Parameters<typeof runValidationCycle>[0]);

    expect(db._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired', consecutive_failures: 2 }),
    );
  });

  it('403 WAF response does not increment consecutive_failures', async () => {
    const offer = { id: 'offer-3', destination_url: 'https://example.com', consecutive_failures: 0 };
    vi.mocked(checkLiveness).mockResolvedValue({
      isLive: false,
      isWaf: true,
      httpStatus: 403,
      deadSignals: [],
      rawText: null,
    } satisfies LivenessResult);

    const db = createMockDb([offer]);
    await runValidationCycle(db as unknown as Parameters<typeof runValidationCycle>[0]);

    // Update should only contain last_verified_at and next_check_at — not consecutive_failures
    const updateArg = db._updateFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(updateArg['consecutive_failures']).toBeUndefined();
    expect(updateArg['last_verified_at']).toBeDefined();
    expect(updateArg['next_check_at']).toBeDefined();
  });

  it('successful check resets consecutive_failures=0 and sets 7-day next_check_at', async () => {
    const offer = { id: 'offer-4', destination_url: 'https://example.com', consecutive_failures: 1 };
    vi.mocked(checkLiveness).mockResolvedValue({
      isLive: true,
      isWaf: false,
      httpStatus: 200,
      deadSignals: [],
      rawText: null,
    } satisfies LivenessResult);

    const db = createMockDb([offer]);
    await runValidationCycle(db as unknown as Parameters<typeof runValidationCycle>[0]);

    expect(db._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ consecutive_failures: 0 }),
    );
    // Verify next_check_at is approximately 7 days from now (with up to 6h jitter)
    const updateArg = db._updateFn.mock.calls[0]![0] as Record<string, unknown>;
    const nextCheck = new Date(updateArg['next_check_at'] as string).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const sixHoursMs = 6 * 60 * 60 * 1000;
    expect(nextCheck).toBeGreaterThanOrEqual(Date.now() + sevenDaysMs - 5000);
    expect(nextCheck).toBeLessThanOrEqual(Date.now() + sevenDaysMs + sixHoursMs + 5000);
  });

  it('verification_log row written for every outcome', async () => {
    const offer = { id: 'offer-5', destination_url: 'https://example.com', consecutive_failures: 0 };
    vi.mocked(checkLiveness).mockResolvedValue({
      isLive: true,
      isWaf: false,
      httpStatus: 200,
      deadSignals: [],
      rawText: 'page text',
    } satisfies LivenessResult);

    const db = createMockDb([offer]);
    await runValidationCycle(db as unknown as Parameters<typeof runValidationCycle>[0]);

    expect(db._insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        offer_id: 'offer-5',
        is_live: true,
        http_status: 200,
      }),
    );
  });

  it('single offer error does not crash the cycle — second offer still processed', async () => {
    const offer1 = { id: 'offer-err', destination_url: 'https://broken.com', consecutive_failures: 0 };
    const offer2 = { id: 'offer-ok', destination_url: 'https://ok.com', consecutive_failures: 0 };

    vi.mocked(checkLiveness)
      .mockRejectedValueOnce(new Error('unexpected fetch failure'))
      .mockResolvedValueOnce({
        isLive: true,
        isWaf: false,
        httpStatus: 200,
        deadSignals: [],
        rawText: null,
      } satisfies LivenessResult);

    const db = createMockDb([offer1, offer2]);
    await runValidationCycle(db as unknown as Parameters<typeof runValidationCycle>[0]);

    // Both offers should have been attempted
    expect(checkLiveness).toHaveBeenCalledTimes(2);
    expect(checkLiveness).toHaveBeenCalledWith('https://broken.com');
    expect(checkLiveness).toHaveBeenCalledWith('https://ok.com');

    // offer2 succeeded — verification_log insert should have been called for it
    expect(db._insertFn).toHaveBeenCalledWith(
      expect.objectContaining({ offer_id: 'offer-ok', is_live: true }),
    );
  });
});
