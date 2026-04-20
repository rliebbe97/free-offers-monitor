# Features Research — Free Offers Monitor

*Generated: 2026-04-20*

---

## Table Stakes (Must Have)

These are non-negotiable for the system to function correctly and safely.

---

### Ingestion

#### Reddit Polling
Poll configured subreddits on a schedule, extracting new posts since the last run cursor.

- **Complexity**: Medium
- **Dependencies**: snoowrap, Supabase `posts` table, `sources` table, pg_cron or worker scheduler
- **Notes**: Store cursor as `last_fetched_at` on the `sources` row. OAuth required for 100 req/min limit. snoowrap handles token refresh but the rate-limit trigger must be logged to Axiom.

#### Rate Limit Handling
Respect Reddit's 100 req/min OAuth cap. snoowrap implements automatic backoff; the worker must detect and log when backoff fires.

- **Complexity**: Low
- **Dependencies**: snoowrap, Axiom logging
- **Notes**: Log event with subreddit name, timestamp, and retry delay. Do not suppress the backoff — just observe it.

#### Comment Extraction (top-level + one reply deep, skip bots)
For each ingested post, fetch top-level comments and exactly one level of replies. Skip AutoModerator and any account whose username matches a known bot pattern.

- **Complexity**: Medium
- **Dependencies**: snoowrap (incomplete types — expect `@ts-ignore`), `posts` table
- **Notes**: Bot detection is username-based heuristic (case-insensitive suffix `bot`, prefix `auto`, exact match `AutoModerator`). Store each comment as its own `posts` row with `parent_post_id` referencing the submission. This enables Tier 0–2 to treat comments identically to posts.

---

### Classification

#### Tier 0 — Keyword Filter
In-process keyword match applied immediately during ingestion. High-recall hand-maintained list. Rejects stored with `tier0_passed = false`.

- **Complexity**: Low
- **Dependencies**: `posts` table, keyword list in config or DB
- **Notes**: Never auto-add keywords. System may surface suggestions to operators; humans decide. Passing posts enqueue a pgmq message for Tier 1.

#### Tier 1 — Haiku Binary Classifier
pgmq consumer reads from the Tier 1 queue, calls Claude Haiku with the post body, stores `{decision, confidence, reason, prompt_version}` as JSONB on the `posts` row.

- **Complexity**: Medium
- **Dependencies**: `@anthropic-ai/sdk`, pgmq, `posts` table, `ai_calls` table, `prompts/tier1-classify.md`
- **Notes**: Prompt versioned by git hash. Result JSONB written to `tier1_result` column. Messages must be explicitly `archive()`d after processing or they re-deliver. Passing posts enqueue for Tier 2.

#### Tier 2 — Sonnet Structured Extraction
pgmq consumer calls Claude Sonnet with tool use / structured outputs. Applies exclusion checks (no coupons, no services, non-zero shipping, no trials, no sweepstakes). Produces a structured offer entity.

- **Complexity**: High
- **Dependencies**: `@anthropic-ai/sdk`, pgmq, `posts` table, `offers` table, `ai_calls` table, `prompts/tier2-extract.md`, Voyage embeddings (for dedup step that follows)
- **Notes**: Tool use schema defines the exact offer shape. Exclusion check is part of the prompt + post-processing assertion. Confidence < 0.7 routes to `human_review_queue` instead of `offers`.

---

### Deduplication

#### URL Hash Matching
Normalize the offer destination URL (strip UTM params, follow one redirect level, lowercase), hash it, and check `offers.destination_url_hash` for an exact match before inserting.

- **Complexity**: Low
- **Dependencies**: `normalize-url`, custom redirect-follow utility, `offers` table index on `destination_url_hash`
- **Notes**: `normalize-url` does not follow redirects — a one-level custom follow is required before hashing. Match → link via `post_offers` join table. No duplicate `offers` row created.

#### Voyage Embedding Cosine Similarity (≥ 0.85)
When no URL hash match is found, generate a 1024-dim Voyage AI embedding for the offer text and run a pgvector `<=>` cosine similarity query. Score ≥ 0.85 is treated as a duplicate.

- **Complexity**: Medium
- **Dependencies**: Voyage AI API, pgvector `vector(1024)` column on `offers`, ivfflat index on `embedding`
- **Notes**: Embedding generated only for Tier 2 survivors to control cost. Near-duplicate match → link to existing offer via `post_offers`, do not insert new `offers` row.

---

### Offer Management

#### Status Tracking
Each offer row carries a `status` field (`active`, `expired`, `dead`, `pending_review`). Status transitions are driven by validation and human review outcomes.

- **Complexity**: Low
- **Dependencies**: `offers` table, dashboard display, validation cron
- **Notes**: `pending_review` is the initial state for low-confidence Tier 2 results. `active` is set after human approval or high-confidence auto-acceptance.

#### URL Liveness Checks
HTTP HEAD (or GET fallback) request to the offer URL. 4xx/5xx or connection failure marks the offer for further dead-signal analysis.

- **Complexity**: Low
- **Dependencies**: Node.js `fetch`, `offers` table, `verification_log` table
- **Notes**: Follow at most one redirect. Do not follow redirect chains to avoid SSRF-style loops. Log each check to `verification_log`.

#### Dead Signal Detection
Page text analysis for signals that the offer is closed ("no longer available", "out of stock", "promotion ended", etc.).

- **Complexity**: Low
- **Dependencies**: Cheerio, `verification_log` table
- **Notes**: Keyword-based heuristic, not AI-assisted, to keep validation cheap. Positive dead signal + liveness failure → mark offer `dead`.

#### Daily Validation Cron
pg_cron job triggers weekly per-offer validation. Checks URL liveness and dead signals. Updates `next_check_at` on completion.

- **Complexity**: Medium
- **Dependencies**: pg_cron, `offers` table index on `next_check_at WHERE status='active'`, validation logic above
- **Notes**: Only active offers are checked. Exponential backoff on repeated failures before marking dead. Log to `verification_log`.

---

### Dashboard

#### Offer List
Auth-gated page showing all offers with key fields: title, source, status, created date, confidence score.

- **Complexity**: Low
- **Dependencies**: Next.js App Router, Supabase client from `@repo/db`, shadcn/ui table component
- **Notes**: Server component with Supabase server client. Paginated.

#### Filtering and Sorting
Filter by status, source, date range. Sort by created date, confidence, or last verified.

- **Complexity**: Low
- **Dependencies**: Dashboard offer list, URL search params for state
- **Notes**: Implemented as URL search params to make views shareable and bookmarkable.

#### Human Review Queue
Separate view listing offers in `pending_review` status. Reviewer can approve (→ `active`) or reject (→ `expired`) with a note.

- **Complexity**: Medium
- **Dependencies**: `human_review_queue` table, `offers` table, Supabase Auth session for reviewer identity, dashboard UI
- **Notes**: Approval records reviewer email and timestamp. Rejection records reason. This is the only path to publishing low-confidence Tier 2 results.

---

### Auth

#### Supabase Auth with Email Allowlist
All dashboard routes require authentication. Only email addresses on the allowlist may sign in.

- **Complexity**: Low
- **Dependencies**: Supabase Auth, Next.js middleware, `@repo/db` Supabase client
- **Notes**: Allowlist enforced at the Supabase Auth hook level, not in application code, to prevent bypass. Email/password or magic link — no OAuth providers required for v1.

---

### Logging

#### AI Call Tracking
Every Tier 1 and Tier 2 AI call writes a row to `ai_calls` with: model, prompt_version (git hash), input/output tokens, cost (computed), latency (ms), post_id.

- **Complexity**: Low
- **Dependencies**: `@anthropic-ai/sdk` response metadata, `ai_calls` table, git hash available at build time as env var
- **Notes**: Cost computed from published token prices at call time — no external billing API required. This is a hard requirement; no AI call may be made without logging.

---

## Differentiators

These features go beyond basic functionality and define the quality of the system.

---

### Confidence-Based Routing to Human Review (< 0.7)
Tier 2 results with `confidence < 0.7` are never auto-published. They are written to `human_review_queue` and surface in the dashboard review view.

- **Complexity**: Low (routing logic is trivial; the value is the policy)
- **Dependencies**: Tier 2 classifier output, `human_review_queue` table, human review dashboard view
- **Notes**: The threshold is a hard-coded constant initially. Adjustable via config later if eval data justifies it. This is the primary false-positive control mechanism.

### Prompt Versioning with Git Hash
Each prompt file in `prompts/` is treated as a versioned artifact. The git commit hash is injected at build/deploy time and stored alongside every AI call in `ai_calls.prompt_version`.

- **Complexity**: Low
- **Dependencies**: CI/build pipeline, `ai_calls` table, `prompts/` directory
- **Notes**: Enables before/after comparison when prompts are edited. Essential for eval regression tracking.

### Structured Extraction with Tool Use
Tier 2 uses Claude's tool use feature to guarantee a typed offer schema is returned. Avoids fragile text parsing.

- **Complexity**: Medium
- **Dependencies**: `@anthropic-ai/sdk` tool use API, Tier 2 prompt, offer schema definition
- **Notes**: Tool schema is the source of truth for the offer entity shape. TypeScript types in `@repo/db` are generated from or kept in sync with this schema. Malformed tool responses are treated as extraction failures and routed to human review.

### Semantic Dedup via Voyage Embeddings
URL hash alone misses offers reposted with different links (e.g., affiliate redirects, different tracking params not stripped by normalize-url). Voyage embedding cosine similarity catches near-duplicates.

- **Complexity**: Medium
- **Dependencies**: Voyage AI API, pgvector, offers table embedding column, ivfflat index
- **Notes**: Only runs when URL hash returns no match, keeping cost proportional to novel content. The 0.85 cosine threshold was chosen to balance recall vs. false-duplicate rate — should be validated against labeled data once available.

---

## Anti-Features (Deliberately NOT Building)

These are explicit non-goals. Revisit at milestone boundaries with evidence before reconsidering.

---

### Auto-Publishing Low-Confidence Offers
Tier 2 results below the confidence threshold are never published automatically. The system surfaces them for human review only.

- **Rationale**: False positives (non-free or misleading offers reaching users) erode trust faster than false negatives. The human review queue is the safety valve.
- **Complexity if added**: Low logic complexity, high risk to trust
- **Dependencies if added**: Would require removing the confidence gate in the Tier 2 worker

### Auto-Modifying Keyword Lists
The Tier 0 keyword list is hand-maintained. The system must never add, remove, or reweight keywords autonomously, even if AI analysis suggests candidates.

- **Rationale**: Keyword changes affect recall for all future posts. Unreviewed additions could cause systematic false positives or negatives. The system may surface suggestions; a human must commit the change.
- **Complexity if added**: Low logic complexity, high governance risk

### Public-Facing UI
The dashboard is internal only, gated behind Supabase Auth with an email allowlist. No unauthenticated routes expose offer data.

- **Rationale**: Offer data quality is not yet validated at scale. A public UI before quality is established creates reputational risk. Deferred to a future milestone after trust is established.
- **Complexity if added**: Medium (public API layer, rate limiting, SEO)

### Real-Time Notifications
No push notifications, webhooks, or live dashboard updates for new offers or review queue items.

- **Rationale**: Polling-based dashboard is sufficient for v1 operator workflow. Adding real-time infrastructure (Supabase Realtime, WebSockets, push services) adds complexity with no validated user need yet.
- **Complexity if added**: Medium (Supabase Realtime or polling with server-sent events)

### Discourse / Forum Adapters
Only Reddit is supported in v1. Discourse and other forum adapters are deferred.

- **Rationale**: The `SourceAdapter` interface (`fetchNewPosts(since: Date): Promise<RawPost[]>`) is designed for extension, but building and validating a second adapter before the Reddit pipeline is proven adds scope without clear return. Revisit when Reddit pipeline has ≥ 30 days of production data.
- **Complexity if added**: Medium per adapter (auth, pagination, rate limits vary)
- **Dependencies if added**: Cheerio (already present), possible Playwright if JS rendering required

### Mobile App
No native or PWA mobile application.

- **Rationale**: Internal operator tool. Web dashboard on desktop is the target workflow. Mobile adds significant build/deploy/maintenance overhead for no validated need.
- **Complexity if added**: High (separate app, platform-specific concerns)
