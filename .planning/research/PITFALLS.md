# Pipeline Pitfalls — Free Offers Monitor

Domain-specific traps for a Reddit/forum monitoring pipeline with AI classification, deduplication via embeddings, and Postgres-native queuing. Generic advice excluded; every item maps to a concrete failure mode in this stack.

---

## 1. snoowrap

### 1.1 Incomplete TypeScript types

**Warning signs**
- TypeScript errors on `.comments`, `.replies`, `.body`, `.author`, `listing.fetchMore()` return shapes
- `as any` casts proliferating in ingestion code
- Build breaks on minor snoowrap version bumps that change the partial types

**Prevention strategy**
- Declare a `RawRedditPost` and `RawRedditComment` type in `@repo/db/src/types.ts` that owns the exact fields the pipeline uses; cast once at the adapter boundary
- Use `// @ts-ignore` only at the snoowrap call site, never deep inside business logic
- Pin snoowrap to an exact version (`"snoowrap": "1.23.0"`) — do not use `^` — until types stabilize

**Build phase**: Phase 1 (Reddit ingestion adapter setup)

---

### 1.2 OAuth token refresh silently failing

**Warning signs**
- `401 Unauthorized` appearing mid-run, often after ~1 hour
- snoowrap continues without throwing; subsequent requests return empty listings
- Logs show "fetched 0 posts" rather than an error

**Prevention strategy**
- Construct the snoowrap client with `permanent: true` on the OAuth token so it auto-refreshes; verify the `refresh_token` is stored in Supabase Vault, not just an access token
- Add a health-check call (`r.getMe()`) at worker startup to confirm credentials before queuing work
- Log token refresh events explicitly — snoowrap fires a `tokenRefreshed` event; hook into it via `r.on('tokenRefreshed', ...)`

**Build phase**: Phase 1 (Reddit ingestion adapter setup)

---

### 1.3 Comment tree traversal depth and MoreComments objects

**Warning signs**
- `comments` array contains `MoreComments` objects instead of `Comment` objects — iterating them as strings/bodies silently yields `undefined`
- Top-level comment replies are missing because `fetchMore` was never called
- Bot and AutoModerator comments slipping through because the traversal hits them before the depth check

**Prevention strategy**
- Call `submission.comments.fetchAll()` only once per post, then walk the flat list — do not recursively descend into `.replies` without first checking `instanceof MoreComments`
- Enforce the "one reply deep" rule in the traversal: collect `submission.comments` (top-level) and `comment.replies` (one level) then stop; do not recurse further
- Filter AutoModerator and known bot account names (`AutoModerator`, accounts ending in `Bot`, `_bot`, `_official`) before any further processing
- Check `comment.body === '[deleted]'` and `comment.author?.name === '[deleted]'` — treat both as skip-and-log, not as errors

**Build phase**: Phase 1 (Reddit ingestion adapter setup)

---

### 1.4 Rate limit bursting and backoff logging

**Warning signs**
- snoowrap silently delays requests without any log output — pipeline appears hung
- Fetching comments on many posts in rapid succession burns through the 100 req/min limit quickly (each `fetchMore` call = 1 request)
- Railway free-tier timeout kills the worker mid-backoff

**Prevention strategy**
- Instrument snoowrap's `ratelimitExpiry` and `requestsThisMinute` properties after each call; emit a structured log (`{ event: 'reddit_ratelimit', remaining, reset_at }`) to Axiom
- Batch post-comment fetches in groups of 20 with an explicit 15-second pause between groups to stay well under 100 req/min even during comment fetching
- Keep the worker's Railway health-check endpoint responding during backoff to avoid premature restarts

**Build phase**: Phase 1 (Reddit ingestion adapter setup), revisit in Phase 5 (production hardening)

---

## 2. pgmq

### 2.1 Messages re-deliver if not archived

**Warning signs**
- Same post processed by Tier 1 or Tier 2 multiple times — duplicate `ai_calls` rows, duplicate offers
- Idempotency guards in the processing code masking the real issue (the message keeps coming back)
- Processing errors cause infinite re-delivery loops if the catch block doesn't archive

**Prevention strategy**
- Always call `pgmq.archive(queue_name, msg_id)` in a `finally` block, never only in the happy path
- For error cases, archive to the queue's dead-letter table instead of leaving the message visible: `pgmq.send('tier1_dlq', original_payload)` then `pgmq.archive('tier1', msg_id)`
- Log `msg_id` in every Tier 1/2 call so duplicate-processing can be detected from logs before it corrupts data

**Build phase**: Phase 2 (Tier 1 pgmq worker), Phase 3 (Tier 2 pgmq worker)

---

### 2.2 Visibility timeout tuning

**Warning signs**
- Tier 2 (Sonnet extraction) takes 8–15 seconds but the visibility timeout is set to the pgmq default (30s) — a slow network hiccup causes the message to become visible again mid-processing
- Two worker instances both pick up the same message when scaling horizontally

**Prevention strategy**
- Set visibility timeout to 120s for Tier 2 (Sonnet can be slow under load) and 30s for Tier 1 (Haiku is fast)
- Extend visibility mid-processing if needed: call `pgmq.set_vt(queue_name, msg_id, 60)` after a successful AI call but before DB writes
- Never run more worker instances than you can handle re-delivery for — in v1, a single Railway instance is safer than horizontal scaling without a distributed lock

**Build phase**: Phase 2–3 (queue worker setup), revisit in Phase 5

---

### 2.3 Dead letter queue accumulation

**Warning signs**
- DLQ table growing silently with no alerting — weeks of failed posts never reviewed
- A parsing regression routes everything to DLQ; the pipeline looks healthy (no errors) but produces no offers

**Prevention strategy**
- Add a pg_cron job that counts DLQ depth every 15 minutes and inserts a row into a `pipeline_health` table; expose it on the dashboard
- Set a hard DLQ size cap: if `tier1_dlq` exceeds 500 rows, send a Slack/email alert before investigating
- DLQ messages must preserve the original `msg_id`, `enqueued_at`, and `fail_reason` to aid diagnosis

**Build phase**: Phase 4 (monitoring/alerting)

---

## 3. pgvector

### 3.1 ivfflat vs hnsw index choice

**Warning signs**
- Cosine similarity queries taking 200ms+ on 10k+ vectors with ivfflat at default `lists=100`
- Recall dropping below expected levels when `lists` is set too high relative to dataset size

**Prevention strategy**
- Use ivfflat with `lists = sqrt(row_count)` as the starting rule of thumb; at <50k vectors this is almost always correct
- Switch to hnsw only if the dataset grows beyond 500k rows — hnsw has higher build-time memory cost but better recall under concurrent inserts
- For v1 (expected <10k offers), `CREATE INDEX ON offers USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)` is sufficient; revisit at 50k
- Always `SET ivfflat.probes = 10` in the session before running dedup queries — the default `probes=1` cuts recall dramatically

**Build phase**: Phase 3 (dedup implementation)

---

### 3.2 Dimension mismatch crashing inserts

**Warning signs**
- `ERROR: expected 1024 dimensions, not 768` on insert — wrong embedding model used somewhere in the call chain
- Silent truncation if the column was accidentally created without an explicit dimension (`vector` instead of `vector(1024)`)

**Prevention strategy**
- The column definition must be `embedding vector(1024)` — Postgres will enforce dimension at insert time only if the explicit length is set
- Assert `embedding.length === 1024` in the TypeScript layer before any DB insert; throw a typed error, not a silent skip
- Pin the Voyage model to `voyage-2` (1024-dim) explicitly in every embedding call — do not rely on the API default in case Voyage changes it
- Add a CI test that calls the embedding function with a known input and asserts output length

**Build phase**: Phase 3 (dedup implementation)

---

### 3.3 Extension setup order dependency

**Warning signs**
- `ERROR: type "vector" does not exist` on schema migration in a fresh Supabase project
- pgmq or pg_cron migrations run before `CREATE EXTENSION vector` causing schema inconsistencies

**Prevention strategy**
- Document the one-time manual Supabase setup: `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgmq; CREATE EXTENSION IF NOT EXISTS pg_cron;` — run in that order in the SQL editor before applying any migrations
- Add a startup assertion in the worker: query `pg_extension` for all three and throw a clear error if any are missing, rather than failing cryptically later
- Include a `schema.sql` comment block at the top listing the required extensions — future dev onboarding depends on it

**Build phase**: Phase 0 (DB setup), documented in `packages/db/src/schema.sql`

---

## 4. AI Classification

### 4.1 Prompt drift and version mismatch

**Warning signs**
- Offer quality degrades gradually after a prompt edit without any logged change
- `ai_calls.prompt_version` contains `undefined` or a stale git hash because the version wasn't threaded through to the call site
- A/B comparing prompt versions is impossible because the column is inconsistently populated

**Prevention strategy**
- Compute `prompt_version` as `git rev-parse --short HEAD` at worker startup and inject it into every AI call log — never compute it per-call
- Prompts live in `prompts/tier1-classify.md` and `prompts/tier2-extract.md`; load them at startup and cache in memory — never read from disk per-request
- Any edit to a prompt file must be its own commit with a message like `prompts: update tier2-extract exclusion rules (v3)` — use `pnpm eval` to validate before merging

**Build phase**: Phase 2–3 (tier workers), enforced throughout

---

### 4.2 Cost explosion from Tier 0 bypass

**Warning signs**
- Haiku spend spikes unexpectedly — Tier 0 keyword filter isn't rejecting enough
- High-volume subreddits (e.g., r/freebies has 200+ posts/day) sending most posts to Tier 1

**Prevention strategy**
- Tier 0 must fire before any message is enqueued for Tier 1 — enforce in the ingestion adapter, not in the Tier 1 worker
- Track `tier0_passed=false` rejection rate in the `pipeline_health` table; if it drops below 60%, the keyword list may be too broad
- Set a hard daily Haiku spend cap ($5) in the Anthropic dashboard; alert before it's hit, not after

**Build phase**: Phase 1 (ingestion) and Phase 2 (Tier 1 worker)

---

### 4.3 Model version pinning

**Warning signs**
- Anthropic silently points `claude-haiku-3` to a new minor version; Tier 1 classification behavior shifts
- `claude-sonnet-4` output format changes break the tool-use response parser
- `ai_calls` rows show mixed model versions after an unplanned rollout

**Prevention strategy**
- Pin to a specific dated model string: `claude-haiku-3-20240307`, `claude-sonnet-4-20240229` — never use the unversioned alias in production code
- Store the exact model string in `ai_calls.model` — this is the audit trail if behavior changes
- Add the model string to a `config.ts` constant so a single change propagates everywhere

**Build phase**: Phase 2–3 (tier workers), never change without running `pnpm eval`

---

### 4.4 Structured output / tool use parsing failures

**Warning signs**
- `tool_use` block missing from Anthropic response when the model decides to reply in text instead
- Response has `stop_reason: 'end_turn'` instead of `stop_reason: 'tool_use'` — tool was never called
- Partial JSON inside the tool arguments field causes `JSON.parse` to throw

**Prevention strategy**
- Always assert `response.stop_reason === 'tool_use'` before accessing `tool_use` blocks; if not, route to DLQ with `fail_reason: 'no_tool_call'` — do not try to parse free text
- Set `tool_choice: { type: 'tool', name: 'extract_offer' }` on Tier 2 calls to force the model to call the tool — do not rely on `auto` mode
- Wrap the tool argument parse in `try/catch`; a parse failure = route to `human_review_queue` with the raw response attached
- Validate the parsed tool output against a Zod schema before any DB insert — never trust raw AI output as a DB payload

**Build phase**: Phase 2–3 (tier workers)

---

## 5. URL Normalization

### 5.1 normalize-url does not follow redirects

**Warning signs**
- Two posts pointing to the same product page via different link shorteners hash to different values — dedup misses them
- `bit.ly`, `amzn.to`, `tinyurl.com` URLs are stored as-is, making the URL hash dedup layer useless for short links

**Prevention strategy**
- Before calling `normalize-url`, perform a one-level HEAD request redirect follow: `fetch(url, { method: 'HEAD', redirect: 'manual' })` → if status is 3xx, use `response.headers.get('location')` as the real URL, then normalize that
- Cap redirect follow at one level only — do not recurse; log if a second redirect is detected
- Blacklist known UTM-heavy domains where normalize-url alone is sufficient (no shortener involved) to skip the network call for performance

**Build phase**: Phase 3 (dedup implementation)

---

### 5.2 Affiliate link laundering masking identical offers

**Warning signs**
- Amazon affiliate links (`?tag=mysite-20`) for the same ASIN hash differently because the tag differs and normalize-url stripped only some params
- Subreddit auto-tagging (e.g., Reddit's own `?ref=share`) generates variants of the same URL

**Prevention strategy**
- After redirect follow, strip all query params from known affiliate/tracking domains (Amazon: keep only `?dp=` and ASIN path, strip `?tag`, `?linkCode`, etc.) before hashing
- Normalize Amazon URLs to canonical ASIN form: `https://www.amazon.com/dp/{ASIN}` — extract ASIN from any Amazon URL shape before hashing
- For non-Amazon URLs, `normalize-url` with `removeQueryParameters: true` is sufficient for dedup hashing; store the original URL separately for display

**Build phase**: Phase 3 (dedup implementation)

---

### 5.3 URL shorteners requiring JS rendering

**Warning signs**
- Some shorteners (e.g., `linktr.ee`, some custom ones) return a 200 with a JS redirect rather than a 3xx — HEAD-based redirect follow gets the shortener's landing page HTML, not the destination
- The URL stored in the DB is the shortener's JS page, not the real product URL

**Prevention strategy**
- Detect known JS-redirect domains at the adapter level and flag the post for manual URL extraction (route to `human_review_queue`)
- Do not use Playwright for redirect following in the hot path — it's too slow for bulk ingestion; only use it in the validation cron where latency is acceptable
- If a URL fails HEAD-based resolution, store it with a `url_resolved=false` flag and skip embedding dedup for that post; rely on exact URL hash only

**Build phase**: Phase 3 (dedup), Phase 6 (validation cron)

---

## 6. Reddit-Specific

### 6.1 AutoModerator and bot account detection

**Warning signs**
- Tier 0–2 pipeline processing AutoModerator stickied posts about subreddit rules
- Bot accounts that post promotional "free sample" links (not genuine offers) passing Tier 0 keyword filter
- `author` field is `null` on deleted accounts, causing crashes in the bot-detection filter

**Prevention strategy**
- Hard-skip any post or comment where `author.name === 'AutoModerator'`
- Maintain a bot account denylist in Tier 0 config (not in code) — check `author.name` against it before enqueuing
- Check `post.distinguished === 'moderator'` to catch mod-posted stickied announcements
- Handle `author === null` (deleted user) gracefully: skip the post/comment, log `{ event: 'skipped_deleted_author' }`

**Build phase**: Phase 1 (Reddit ingestion adapter)

---

### 6.2 Deleted and removed posts

**Warning signs**
- `post.selftext === '[deleted]'` or `post.selftext === '[removed]'` — the body is gone, Tier 0 keyword match on empty string passes trivially
- A post passes Tier 0 but by the time Tier 1 runs (seconds later), the post has been removed — Haiku classifies empty text as non-offer but logs a confusing result

**Prevention strategy**
- Check `selftext !== '[deleted]'` and `selftext !== '[removed]'` and `selftext.trim().length > 20` before enqueuing for Tier 1
- For link posts (no selftext), check that the URL is not `null` before ingestion
- If a post's URL returns 404 during validation, do not auto-expire the offer immediately — check once more 24 hours later (intermittent Reddit CDN issues are common)

**Build phase**: Phase 1 (Reddit ingestion adapter)

---

### 6.3 Subreddit rules and Reddit API changes

**Warning signs**
- A target subreddit is quarantined or made private — snoowrap returns an empty listing without throwing
- Reddit increases OAuth requirements or introduces new API rate tiers — snoowrap's backoff breaks silently
- Reddit scraping Terms of Service change — risk of API key revocation

**Prevention strategy**
- Test subreddit accessibility at worker startup: call `r.getSubreddit(name).fetch()` and check `subreddit_type` — skip and alert if `private` or `restricted`
- Monitor Reddit's API changelog; pin snoowrap and review any `snoowrap` major version bump manually
- Store the Reddit API credentials (client_id, client_secret, refresh_token) in Supabase Vault, not in `.env.local` in production — rotation should be possible without redeployment

**Build phase**: Phase 1 (Reddit ingestion adapter), Phase 5 (hardening)

---

## 7. Deduplication

### 7.1 Cosine threshold 0.85 — too tight or too loose

**Warning signs**
- Threshold too loose (< 0.80): Tier 2 results for different but topically similar offers (two different brands of baby formula) are deduplicated into the same offer record
- Threshold too tight (> 0.90): The same offer reposted with minor title changes creates duplicate offer records, flooding the dashboard

**Prevention strategy**
- Start at 0.85 and validate against `evals/labeled-posts.json` with `pnpm eval` — the eval must include near-duplicate pairs as well as true duplicates
- Use URL hash as the primary dedup gate (exact match → always deduplicate); cosine threshold only fires for posts with different but similar URLs
- Log every embedding dedup decision to `ai_calls` (or a separate `dedup_log` table) with the cosine score and both post IDs — this is the audit trail for threshold tuning

**Build phase**: Phase 3 (dedup implementation), tuned against labeled data before launch

---

### 7.2 Embedding dedup race condition on concurrent ingestion

**Warning signs**
- Two posts about the same offer arrive within the same ingestion window; both pass URL hash dedup (different URLs); both enqueue for Tier 2 at the same time
- Both Tier 2 workers run the cosine check simultaneously before either has inserted the embedding → both create new offer records

**Prevention strategy**
- Use a Postgres advisory lock around the "check cosine → insert offer" transaction: `SELECT pg_advisory_xact_lock(hashtext(destination_url))` inside the transaction
- Alternatively, use `INSERT ... ON CONFLICT` on the `destination_url_hash` column as the final guard even if cosine dedup already ran
- In v1 with a single worker instance, this is a low-risk edge case; document and add the lock before scaling to multiple workers

**Build phase**: Phase 3 (dedup implementation)

---

## 8. Offer Validation

### 8.1 URL liveness checks hitting rate limits

**Warning signs**
- Sending 500+ HEAD requests to brand websites in a tight pg_cron window triggers Cloudflare/WAF blocks — the validator gets 403s for all URLs on a domain
- The validator marks offers as dead because of a WAF block, not genuine expiration

**Prevention strategy**
- Spread validation requests across the daily window using jitter: select `next_check_at` using `NOW() + (random() * interval '24 hours')` when scheduling checks — do not validate all offers at midnight
- Respect `Retry-After` headers from 429 responses; back off per domain, not globally
- Cap concurrent validation requests to 5 at a time (not 100 in parallel) — use a semaphore in the validation worker
- If a URL returns 403 or 429, do not mark as dead — mark as `check_failed` and retry in 6 hours

**Build phase**: Phase 6 (validation cron)

---

### 8.2 False dead signals from JS-rendered pages

**Warning signs**
- A product page's static HTML contains "This item is no longer available" in a meta tag or dead-loading spinner — the validator detects a dead signal but the offer is actually live (page just loads with JS)
- Brand websites using client-side rendering return 200 with an empty shell and no offer details — validator Cheerio parser finds "out of stock" text in a hidden template element

**Prevention strategy**
- Dead signal keyword detection must run against the rendered DOM, not the raw HTML, for known JS-heavy domains; use Playwright only for a flagged subset of URLs (those that previously returned ambiguous signals)
- Maintain a `js_required_domains` list (hand-maintained, not auto-populated) to route validation through Playwright selectively
- For a positive dead signal, require two consecutive failed checks 24 hours apart before auto-expiring an offer — one check is not enough
- Log the raw HTML snippet that triggered the dead signal to `verification_log` so humans can audit false positives

**Build phase**: Phase 6 (validation cron)

---

## Cross-Cutting

### Environment and secrets hygiene

- `.env.local` must never contain production Supabase keys — use Supabase Vault in Railway via environment variable injection
- All three of `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, and `REDDIT_REFRESH_TOKEN` are in Vault; rotate them independently
- Add `.env*` to `.gitignore` at the monorepo root, not just per-app

### Testing blind spots

- Unit tests that mock the Anthropic SDK will not catch prompt parsing failures — `pnpm eval` against `labeled-posts.json` is the only real validation for classification logic
- pgmq integration tests need a real Postgres instance with the pgmq extension — use a local Supabase CLI instance in CI, not an in-memory mock
- URL normalization edge cases (Amazon ASINs, affiliate params, JS redirects) should have dedicated unit tests with hardcoded URL fixtures before the dedup code is written

---

*Last updated: 2026-04-20*
