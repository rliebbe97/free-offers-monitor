# Adding New Sources to the Pipeline

How to feed new subreddits, forums, or blogs into the ingestion pipeline. There are two paths depending on whether the site uses a platform we already support.

## Path 1 — Same platform, new feed

If the site uses a platform that already has an adapter (Reddit or TheBump today), no code is required. The dispatcher in `ingest.ts` reads the `sources` table on every cycle and routes by `type`, so you only need a new row.

Write a migration under `packages/db/src/migrations/` following the pattern of `001_seed_thebump_sources.sql`. Use `ON CONFLICT (identifier) DO NOTHING` so it's safe to re-run.

```sql
-- New subreddit
INSERT INTO sources (type, identifier, config) VALUES
  ('reddit', 'beautyguruchatter', '{}')
ON CONFLICT (identifier) DO NOTHING;

-- New TheBump subforum
INSERT INTO sources (type, identifier, config) VALUES
  ('bump',
   'https://community.thebump.com/categories/some-other-cat',
   '{"base_url":"https://community.thebump.com","subforum_path":"/categories/some-other-cat","max_pages":10}'::jsonb)
ON CONFLICT (identifier) DO NOTHING;
```

Apply with `psql $DATABASE_URL -f packages/db/src/migrations/00N_seed_<name>.sql`.

The `identifier` column is the only thing the adapter sees. For Reddit it's the subreddit name; for TheBump it's the full subforum URL. `config` is free-form JSONB — use it for per-source overrides if your adapter reads them, otherwise pass `'{}'`.

## Path 2 — New platform, new adapter

For a new forum platform, blog, or any site without an existing adapter, you need four changes.

### 1. Implement `SourceAdapter`

The contract is a one-method interface in `source-adapter.ts`:

```ts
export interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
```

Each `RawPost` needs a stable `external_id` — that's what `UNIQUE(source_id, external_id)` uses to dedupe re-polls. If the platform doesn't expose a clean ID, derive one from the post URL (see `extractExternalId` in `scraping-utils.ts`).

There are two adapter shapes in the repo today, pick whichever matches your source:

**HTML forum with pagination** → extend `BaseForumAdapter` (`base-forum-adapter.ts`). The base class owns the pagination loop, Cloudflare challenge detection, the `oldest < since` cutoff, and `max_pages` termination. You implement only:

- `startUrl: string` — first page to fetch
- `extractPostsFromPage($, pageUrl): RawPost[]` — selector logic
- `getNextPageUrl($): string | null` — next-page link or null

`thebump-adapter.ts` is the reference. Override `shouldSkipPost` if you need source-specific skip rules — call `super.shouldSkipPost(post)` first to keep the default empty/short-body filter.

**JSON API or custom shape** → implement `SourceAdapter` directly. `reddit-adapter.ts` is the reference. It pulls public Reddit JSON, walks top-level comments + one reply deep, and skips bots via `shouldSkipAuthor`.

Export a factory function so the dispatcher can construct it:

```ts
export function createMyAdapter(identifier: string): MyAdapter {
  return new MyAdapter(identifier);
}
```

### 2. Wire it into the dispatcher

Add a `case` in `createAdapterForSource` in `ingest.ts`:

```ts
case 'myplatform':
  return createMyAdapter(source.identifier);
```

The string in `case` must match the `type` column you'll use in the seed migration.

### 3. Tests

Mirror `thebump-adapter.test.ts`. Drop a captured HTML or JSON sample into `__fixtures__/`, mock the fetch, and assert the extracted `RawPost[]`. The base class's pagination loop is already covered by `base-forum-adapter.test.ts`, so for forum adapters you only need to test your selectors and skip rules.

### 4. Seed migration

`packages/db/src/migrations/00N_seed_<name>.sql` with `INSERT … ON CONFLICT (identifier) DO NOTHING`. Pick a stable, lowercase string for the new `type` value.

## Blogs specifically

Most blogs are one post per URL with no thread structure. If the blog exposes an RSS or Atom feed, write **one** generic `RssAdapter` parameterized by feed URL — then every new blog is a `sources` row (Path 1) instead of a new adapter. That's a much better ROI than per-blog scrapers.

Suggested shape:

- `type = 'rss'`
- `identifier = '<feed url>'` (so `UNIQUE(identifier)` still prevents dupes)
- `external_id` from the `<guid>` element, falling back to the entry URL hash
- `posted_at` from `<pubDate>` / `<published>`
- `body` from `<content:encoded>` if present, else `<description>`, stripped of HTML

If a blog has no feed, fall back to a Cheerio adapter under Path 2 — but RSS first, always.

## Things to get right in any adapter

- **External IDs must be stable.** If you re-derive `external_id` differently on a later run, you'll create duplicate posts. Tie it to something the source guarantees (post ID, URL, GUID) — never timestamp or scrape order.
- **Skip filtering belongs inside the adapter.** Bots, deleted posts, AutoModerator, locked threads — drop them before returning. Tier 0 keyword filter runs after, and Tier 1 costs ~$0.001/post; cheaper to filter early.
- **Rate limiting.** Use `fetchWithRateLimit` and `respectfulDelay` from `scraping-utils.ts`. Don't roll your own — they handle retries, throttling, and the `User-Agent` header consistently.
- **Date parsing.** Return `null` over guessing. The pipeline tolerates missing `posted_at`, but a bad date breaks the `oldest < since` pagination cutoff in `BaseForumAdapter` and you'll over-fetch every cycle.
- **Cloudflare / JS rendering.** Cheerio only. Per `CLAUDE.md`, reach for Playwright only if the site truly requires JS rendering — it's a heavier dependency and harder to run on Railway.
- **Errors don't poison the cycle.** Throw on fetch failures inside the adapter; `runIngestionCycle` catches per-source and continues to the next source. Don't try to swallow errors and return partial results — the cycle's `last_polled_at` update will still advance, and you'll lose posts.
- **Reddit-specific:** ingest top-level comments + one reply deep, skip AutoModerator and bot accounts. snoowrap is no longer used; we hit public Reddit JSON directly.

## Quick checklist

For Path 1 (new feed on existing platform):

- [ ] Migration file under `packages/db/src/migrations/` with `INSERT … ON CONFLICT DO NOTHING`
- [ ] Apply with `psql $DATABASE_URL -f <migration>`
- [ ] Verify next ingestion cycle picks it up (check `sources.last_polled_at` advances)

For Path 2 (new platform):

- [ ] New adapter file in `apps/worker/src/ingestion/`
- [ ] Factory function exported
- [ ] `case` added to `createAdapterForSource` in `ingest.ts`
- [ ] Test file with fixture in `__fixtures__/`
- [ ] Seed migration with the new `type` value
- [ ] `pnpm test --filter worker` passes
