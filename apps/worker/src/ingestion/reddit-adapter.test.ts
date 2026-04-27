import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RedditAdapter, shouldSkipAuthor } from './reddit-adapter.js';

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ListingChild<T> {
  kind: string;
  data: T;
}

function makeListing<T>(children: ListingChild<T>[]) {
  return { kind: 'Listing', data: { children } };
}

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc123',
    title: 'Free baby formula sample — full size, no shipping',
    selftext: 'Saw this on a brand site, no purchase required, ships free in US.',
    author: 'realuser',
    url: 'https://example.com/free-formula',
    permalink: '/r/Freebies/comments/abc123/free_baby_formula_sample/',
    created_utc: 1_750_000_000,
    distinguished: null,
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt1',
    author: 'commenter',
    body: 'Confirmed — got mine in three days, totally free, no upsell.',
    permalink: '/r/Freebies/comments/abc123/_/cmt1/',
    created_utc: 1_750_000_500,
    distinguished: null,
    replies: '',
    ...overrides,
  };
}

function emptyCommentsResponse(post: ReturnType<typeof makePost>) {
  return [
    makeListing([{ kind: 't3', data: post }]),
    makeListing<unknown>([]),
  ];
}

describe('shouldSkipAuthor', () => {
  it('skips deleted accounts', () => {
    expect(shouldSkipAuthor(null, 'real body content here please', null)).toBe(true);
  });

  it('skips AutoModerator', () => {
    expect(shouldSkipAuthor('AutoModerator', 'real body content here please', null)).toBe(true);
  });

  it('skips bot suffix accounts', () => {
    expect(shouldSkipAuthor('helpfulbot', 'real body content here please', null)).toBe(true);
    expect(shouldSkipAuthor('helpful_bot', 'real body content here please', null)).toBe(true);
  });

  it('skips moderator-distinguished posts', () => {
    expect(shouldSkipAuthor('humanmod', 'real body content here please', 'moderator')).toBe(true);
  });

  it('skips deleted/removed bodies', () => {
    expect(shouldSkipAuthor('realuser', '[deleted]', null)).toBe(true);
    expect(shouldSkipAuthor('realuser', '[removed]', null)).toBe(true);
  });

  it('skips short bodies', () => {
    expect(shouldSkipAuthor('realuser', 'short', null)).toBe(true);
  });

  it('keeps real users with real content', () => {
    expect(shouldSkipAuthor('realuser', 'a body that is long enough to pass the length check', null)).toBe(false);
  });
});

describe('RedditAdapter.fetchNewPosts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_750_001_000_000));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('fetches and normalizes a post with no comments', async () => {
    const post = makePost();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeListing([{ kind: 't3', data: post }])))
      .mockResolvedValueOnce(jsonResponse(emptyCommentsResponse(post)));

    const adapter = new RedditAdapter('Freebies');
    const since = new Date((post.created_utc - 60) * 1000);
    const results = await adapter.fetchNewPosts(since);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      external_id: 'abc123',
      url: 'https://example.com/free-formula',
      title: post.title,
      body: post.selftext,
      author: 'realuser',
    });
    expect(results[0]!.posted_at).toEqual(new Date(post.created_utc * 1000));
  });

  it('filters posts older than the since watermark', async () => {
    const oldPost = makePost({ id: 'old1', created_utc: 1_700_000_000 });
    const newPost = makePost({ id: 'new1', created_utc: 1_750_000_000 });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          makeListing([
            { kind: 't3', data: oldPost },
            { kind: 't3', data: newPost },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(emptyCommentsResponse(newPost)));

    const adapter = new RedditAdapter('Freebies');
    const since = new Date(1_740_000_000_000);
    const results = await adapter.fetchNewPosts(since);

    expect(results).toHaveLength(1);
    expect(results[0]!.external_id).toBe('new1');
  });

  it('skips bot and AutoModerator authors', async () => {
    const botPost = makePost({ id: 'bot1', author: 'AutoModerator' });
    const realPost = makePost({ id: 'real1', author: 'realuser' });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          makeListing([
            { kind: 't3', data: botPost },
            { kind: 't3', data: realPost },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(emptyCommentsResponse(realPost)));

    const adapter = new RedditAdapter('Freebies');
    const since = new Date((realPost.created_utc - 60) * 1000);
    const results = await adapter.fetchNewPosts(since);

    expect(results).toHaveLength(1);
    expect(results[0]!.external_id).toBe('real1');
  });

  it('extracts top-level comments and one-deep replies, skipping more-stubs', async () => {
    const post = makePost();
    const reply = makeComment({ id: 'rep1', body: 'Reply content that is plenty long to pass the filter.' });
    const topComment = makeComment({
      id: 'top1',
      replies: makeListing<unknown>([
        { kind: 't1', data: reply },
        { kind: 'more', data: { id: 'more_stub' } },
      ]),
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeListing([{ kind: 't3', data: post }])))
      .mockResolvedValueOnce(
        jsonResponse([
          makeListing([{ kind: 't3', data: post }]),
          makeListing<unknown>([
            { kind: 't1', data: topComment },
            { kind: 'more', data: { id: 'thread_more' } },
          ]),
        ]),
      );

    const adapter = new RedditAdapter('Freebies');
    const since = new Date((post.created_utc - 60) * 1000);
    const results = await adapter.fetchNewPosts(since);

    expect(results.map((r) => r.external_id)).toEqual(['abc123', 'top1', 'rep1']);
  });

  it('continues past a comments-fetch failure (404 deleted post)', async () => {
    const post = makePost();
    const notFoundResponse = new Response('not found', { status: 404 });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeListing([{ kind: 't3', data: post }])))
      .mockResolvedValue(notFoundResponse);

    const adapter = new RedditAdapter('Freebies');
    const since = new Date((post.created_utc - 60) * 1000);
    const results = await adapter.fetchNewPosts(since);

    expect(results).toHaveLength(1);
    expect(results[0]!.external_id).toBe('abc123');
  });
});
