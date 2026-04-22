import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock reddit-adapter before importing (vi.mock hoisting)
vi.mock('./reddit-adapter.js', () => ({
  createRedditAdapter: vi.fn(() => ({ fetchNewPosts: vi.fn() })),
}));

// Mock thebump-adapter before importing (vi.mock hoisting)
vi.mock('./thebump-adapter.js', () => ({
  createTheBumpAdapter: vi.fn(() => ({ fetchNewPosts: vi.fn() })),
}));

// Mock logger to avoid Axiom dependency in tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createAdapterForSource } from './ingest.js';
import { createRedditAdapter } from './reddit-adapter.js';
import { createTheBumpAdapter } from './thebump-adapter.js';
import type { Source } from '@repo/db';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'test-source-id',
    type: 'reddit',
    identifier: 'test-identifier',
    config: {},
    last_polled_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('createAdapterForSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a RedditAdapter for type "reddit"', () => {
    const source = makeSource({ type: 'reddit', identifier: 'FreeSamples' });
    const adapter = createAdapterForSource(source);

    expect(adapter).toBeDefined();
    expect(createRedditAdapter).toHaveBeenCalledWith('FreeSamples');
  });

  it('returns a TheBumpAdapter for type "bump"', () => {
    const source = makeSource({ type: 'bump', identifier: 'freebies' });
    const adapter = createAdapterForSource(source);

    expect(adapter).toBeDefined();
    expect(createTheBumpAdapter).toHaveBeenCalledWith('freebies');
  });

  it('throws for unknown source type', () => {
    const source = makeSource({ type: 'unknown-type' });

    expect(() => createAdapterForSource(source)).toThrow(
      'Unknown source type: unknown-type',
    );
  });
});
