# Phase 2: Worker Pipeline — Research

**Researched:** 2026-04-20

## Summary

The worker pipeline is a single Node.js process with three concurrent async loops: a Reddit polling loop (snoowrap OAuth), a Tier 1 pgmq consumer (Haiku), and a Tier 2 pgmq consumer (Sonnet). The critical patterns are: (1) always archive pgmq messages in `finally` blocks to prevent re-delivery, (2) use `tool_choice: { type: 'tool', name: 'extract_offer' }` and assert `stop_reason === 'tool_use'` for Tier 2, and (3) follow one redirect level before URL normalization since `normalize-url` does not follow redirects. The `@env.example` file uses `SUPABASE_SERVICE_KEY` but `client.ts` reads `SUPABASE_SERVICE_ROLE_KEY` — this discrepancy must be resolved before anything works.

---

## 1. snoowrap OAuth Setup & Comment Traversal

### Approach

Use the "script" app type on Reddit, not "web app". The STACK.md shows username/password auth but CONTEXT.md D-01 and `.env.example` list a `REDDIT_REFRESH_TOKEN`. The refresh token flow is preferable for long-running workers. Construct with:

```typescript
// Refresh token approach (preferred for workers)
import Snoowrap from 'snoowrap';

const reddit = new Snoowrap({
  userAgent: 'free-offers-monitor/1.0 by u/YourRedditUsername',
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  refreshToken: process.env.REDDIT_REFRESH_TOKEN!,
});
```

For comment traversal (one level deep), the pattern from PITFALLS.md:

```typescript
// Fetch submission with comments expanded
const submission = await reddit.getSubmission(postId).fetch();
// @ts-ignore — snoowrap types are incomplete here
const topLevelComments = submission.comments;

for (const comment of topLevelComments) {
  // Skip MoreComments stubs — they appear when comment tree is collapsed
  if (comment.constructor.name === 'MoreComments') continue;
  
  // Process top-level comment
  processComment(comment);
  
  // One reply deep only
  for (const reply of (comment.replies ?? [])) {
    if (reply.constructor.name === 'MoreComments') continue;
    processComment(reply);
  }
}
```

Bot/deleted guard function (must run before Tier 0):

```typescript
const BOT_PATTERNS = [/bot$/i, /_bot$/i, /_official$/i];
const BOT_NAMES = new Set(['AutoModerator']);

function shouldSkip(author: { name: string } | null, body: string, distinguished?: string): boolean {
  if (!author) return true;  // deleted account
  if (BOT_NAMES.has(author.name)) return true;
  if (BOT_PATTERNS.some(p => p.test(author.name))) return true;
  if (distinguished === 'moderator') return true;
  if (body === '[deleted]' || body === '[removed]') return true;
  if (body.trim().length < 20) return true;
  return false;
}
```

Rate limit logging — snoowrap exposes `ratelimitRemaining` and `ratelimitExpiration` on the instance after each request:

```typescript
// After any snoowrap call, check rate limit state
// @ts-ignore — property exists at runtime but not in types
const remaining = reddit.ratelimitRemaining;
// @ts-ignore
const resetAt = reddit.ratelimitExpiration;
if (remaining !== undefined && remaining < 10) {
  logger.warn({ event: 'reddit_ratelimit', remaining, reset_at: resetAt });
}
```

### Key Details

- **App type**: Must be "script" at reddit.com/prefs/apps — not "installed app" or "web app"
- **`userAgent`**: Must be descriptive and include Reddit username to avoid rate-limit bans
- **Refresh token**: Obtain via OAuth authorization flow once, store in Supabase Vault / env. The `refresh_token` from Reddit never expires unless revoked.
- **MoreComments objects**: These are stub objects in snoowrap that represent collapsed comment trees. Check `constructor.name === 'MoreComments'` or use `comment instanceof MoreComments` after importing the class. Do NOT call `.fetchMore()` in the hot path — it costs an extra API request per collapsed tree.
- **`fetchAll()` gotcha**: `submission.comments.fetchAll()` does follow all MoreComments but fires extra API requests. For v1, skip unexpanded comment trees rather than following them — simpler and cheaper.
- **Polling**: Decision D-01 uses 5-min intervals. Use `setInterval` for simplicity; recursive `setTimeout` gives more control over drift but adds complexity.
- **Subreddit accessibility**: Check `subreddit.subreddit_type !== 'private'` at startup per PITFALLS.md 6.3.
- **`@ts-ignore`**: Use only at the snoowrap adapter boundary (`apps/worker/src/ingestion/reddit-adapter.ts`), never in business logic.

### References

- snoowrap: `1.23.0` (exact pin, no `^`)
- Types: snoowrap ships its own types; `@types/snoowrap` is DEPRECATED stub — do not install
- Reddit API OAuth docs: https://www.reddit.com/wiki/api
- PITFALLS.md sections 1.1–1.4, 6.1–6.3

---

## 2. pgmq Consumer Pattern in TypeScript

### Approach

pgmq is accessed via Supabase RPC calls. The functions are `pgmq.read`, `pgmq.send`, and `pgmq.archive`. Via the Supabase JS client:

```typescript
// Producer — enqueue to tier1_queue after Tier 0 pass
const { error } = await db.rpc('pgmq_send', {
  queue_name: 'tier1_queue',
  msg: { post_id: postId },
});

// Consumer — read with visibility timeout
const { data: messages, error } = await db.rpc('pgmq_read', {
  queue_name: 'tier1_queue',
  vt: 30,    // visibility timeout in seconds
  qty: 5,    // batch size
});

// Archive — MUST be in finally block
await db.rpc('pgmq_archive', {
  queue_name: 'tier1_queue',
  msg_id: msg.msg_id,
});
```

**Note**: Supabase exposes pgmq functions with underscores (`pgmq_send`, `pgmq_read`, `pgmq_archive`) via the RPC layer, not the dotted form (`pgmq.send`) used in raw SQL. Verify exact function names by querying `information_schema.routines` in the Supabase SQL editor on first setup.

The consumer polling loop with finally-block archiving:

```typescript
export async function runTier1Consumer(db: ReturnType<typeof createClient>, shutdown: { stop: boolean }): Promise<void> {
  while (!shutdown.stop) {
    const { data: messages, error } = await db.rpc('pgmq_read', {
      queue_name: 'tier1_queue',
      vt: 30,
      qty: 5,
    });

    if (error) {
      logger.error({ event: 'pgmq_read_error', error });
      await sleep(5000);
      continue;
    }

    if (!messages || messages.length === 0) {
      await sleep(2000);  // poll every 2s when idle
      continue;
    }

    for (const msg of messages) {
      try {
        await processTier1(db, msg.message.post_id);
      } catch (err) {
        // Transient error — do NOT archive, let re-deliver after vt expires
        logger.error({ event: 'tier1_processing_error', msg_id: msg.msg_id, error: err });
        
        // DLQ routing after N retries (check msg.read_ct)
        if (msg.read_ct >= 3) {
          await db.rpc('pgmq_send', {
            queue_name: 'tier1_dlq',
            msg: { ...msg.message, fail_reason: String(err), original_msg_id: msg.msg_id },
          });
          // Fall through to archive — DLQ'd messages should not re-deliver
        } else {
          continue;  // let vt expire for retry
        }
      } finally {
        // Archive on success OR after DLQ routing — never skip this on final attempt
        if (msg.read_ct >= 3 || /* success path */ true) {
          await db.rpc('pgmq_archive', {
            queue_name: 'tier1_queue',
            msg_id: msg.msg_id,
          });
        }
      }
    }
  }
}
```

**Cleaner finally pattern** (recommended):

```typescript
for (const msg of messages) {
  let shouldArchive = false;
  try {
    await processTier1(db, msg.message.post_id);
    shouldArchive = true;
  } catch (err) {
    if (msg.read_ct >= 3) {
      await sendToDlq('tier1_dlq', msg, String(err));
      shouldArchive = true;  // archive after DLQ
    }
    // else: don't archive, let visibility timeout re-deliver
  } finally {
    if (shouldArchive) {
      await db.rpc('pgmq_archive', { queue_name: 'tier1_queue', msg_id: msg.msg_id });
    }
  }
}
```

### Key Details

- **Visibility timeout values**: Tier 1 (Haiku): `vt: 30`. Tier 2 (Sonnet): `vt: 120`. Set at read time, not queue creation time.
- **Batch size**: Start at `qty: 5`. A batch of 5 with sequential processing keeps memory low; tune upward if throughput is insufficient.
- **`read_ct`**: pgmq message objects include `read_ct` (read count). Use this to detect messages that have been retried N times and route to DLQ.
- **DLQ queue names**: `tier1_dlq` and `tier2_dlq`. Create them with `SELECT pgmq.create('tier1_dlq')` — same as normal queues. Create them alongside main queues at startup if they don't exist.
- **Idempotency guard**: Check `posts.pipeline_status` at the start of every tier handler — if already processed (e.g., `tier1_rejected` or beyond), skip processing and archive. This catches the case where the same message is delivered twice due to a crash before archiving.
- **pgmq RPC function names**: The Supabase pgmq extension uses `pgmq.send()`, `pgmq.read()`, `pgmq.archive()` in raw SQL. When calling via Supabase JS `db.rpc()`, the function name is the SQL function path with dot replaced by underscore: `pgmq_send`, `pgmq_read`, `pgmq_archive`. Confirm this against the actual Supabase project if issues arise.
- **Polling vs long-poll**: `pgmq.read` is not a blocking long-poll — it returns immediately with 0 messages if the queue is empty. The consumer must sleep between empty polls.

### References

- pgmq GitHub: https://github.com/tembo-io/pgmq
- Supabase pgmq docs: https://supabase.com/docs/guides/database/extensions/pgmq
- ARCHITECTURE.md sections 4 (Queue Patterns)
- PITFALLS.md section 2 (pgmq)

---

## 3. Anthropic SDK — Haiku Classification & Sonnet Tool Use

### Approach

**Tier 1 — Haiku binary classification:**

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In config.ts
export const TIER1_MODEL = 'claude-haiku-4-20250514';  // current dated Haiku
export const TIER2_MODEL = 'claude-sonnet-4-5';         // current dated Sonnet

// Tier 1 call
const startMs = Date.now();
const response = await anthropic.messages.create({
  model: TIER1_MODEL,
  max_tokens: 256,
  messages: [
    { role: 'user', content: `${systemPrompt}\n\n${postContent}` }
  ],
});
const latencyMs = Date.now() - startMs;

// Parse response — Haiku returns plain text for binary classifier
const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
// Parse JSON from the text response
const result = JSON.parse(text) as { decision: 'pass' | 'reject', confidence: number, reason: string };
```

**Tier 2 — Sonnet with forced tool use:**

```typescript
const response = await anthropic.messages.create({
  model: TIER2_MODEL,
  max_tokens: 1024,
  tools: [
    {
      name: 'extract_offer',
      description: 'Extract structured offer data from a post about a free product offer',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Offer title' },
          description: { type: 'string', description: 'Offer description' },
          brand: { type: 'string', description: 'Brand or company name' },
          destination_url: { type: 'string', description: 'URL to claim the offer' },
          category: {
            type: 'string',
            enum: ['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other'],
            description: 'Product category'
          },
          offer_type: {
            type: 'string',
            enum: ['sample', 'full_product', 'bundle', 'other'],
            description: 'Type of offer'
          },
          shipping_cost: { type: 'number', description: 'Shipping cost in USD. 0 if free shipping.' },
          restrictions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Any restrictions (e.g., US only, first-time customers)'
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Confidence score 0-1 that this is a genuine free physical goods offer'
          },
          exclusion_reason: {
            type: 'string',
            description: 'If excluded: reason (coupon, service, trial, sweepstakes, paid_shipping, etc.)'
          },
          is_excluded: {
            type: 'boolean',
            description: 'True if this fails exclusion criteria (coupon, service, trial, sweepstakes, shipping > 0)'
          }
        },
        required: ['title', 'destination_url', 'confidence', 'is_excluded']
      }
    }
  ],
  tool_choice: { type: 'tool', name: 'extract_offer' },
  messages: [
    { role: 'user', content: `${systemPrompt}\n\n${postContent}` }
  ],
});

// Assert tool was called — PITFALLS.md 4.4
if (response.stop_reason !== 'tool_use') {
  throw new Error(`Expected tool_use stop_reason, got: ${response.stop_reason}`);
}

const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'extract_offer');
if (!toolBlock || toolBlock.type !== 'tool_use') {
  throw new Error('No extract_offer tool block in response');
}

const rawInput: unknown = toolBlock.input;
// Validate with Zod before using
```

**Token cost computation** (client-side, not from API):

```typescript
// In config.ts — pricing as of 2025 (verify before use)
export const MODEL_PRICING = {
  [TIER1_MODEL]: { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },   // Haiku 3: $0.80/1M in, $4/1M out
  [TIER2_MODEL]: { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },  // Sonnet 3.5: $3/1M in, $15/1M out
} as const;

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  if (!pricing) throw new Error(`Unknown model for pricing: ${model}`);
  return pricing.input * inputTokens + pricing.output * outputTokens;
}

// Token counts from response
const inputTokens = response.usage.input_tokens;
const outputTokens = response.usage.output_tokens;
const costUsd = computeCost(TIER1_MODEL, inputTokens, outputTokens);
```

### Key Details

- **Current model strings** (as of April 2026, verify against Anthropic docs):
  - Haiku 3: `claude-haiku-3-20240307` (stable, dated)
  - Haiku 3.5: `claude-haiku-3-5-20241022` (newer, same cost tier)
  - Sonnet 3.5: `claude-sonnet-3-5-20241022` (strong for extraction)
  - Sonnet 4: `claude-sonnet-4-20250514` (newest as of May 2025)
  - Per PITFALLS.md 4.3: use dated strings only, never unversioned aliases
  - Confirm which models are available and pricing before committing to config constants

- **`tool_choice` type shape**: `{ type: 'tool', name: 'extract_offer' }` — forces the model to call the named tool. This is distinct from `{ type: 'auto' }` (model decides) and `{ type: 'any' }` (must use some tool).

- **`stop_reason` values**: `'end_turn'` (normal text completion), `'tool_use'` (tool was called), `'max_tokens'` (truncated). For Tier 2, anything other than `'tool_use'` is an error — route to DLQ.

- **`response.usage`**: Contains `{ input_tokens: number, output_tokens: number }`. Compute cost client-side using known pricing constants.

- **Tier 1 prompt design**: For binary classification, prompt the model to respond with raw JSON (no markdown code fences). Parse with try/catch and route to DLQ on parse failure.

- **Tier 2 system prompt**: Include explicit exclusion criteria — no coupons, no services, no shipping cost, no free trials, no sweepstakes. The tool schema's `is_excluded` field captures this.

- **`max_tokens`**: Tier 1: 256 is sufficient for binary JSON response. Tier 2: 1024 is generous for the extraction tool call.

- **SDK version**: `@anthropic-ai/sdk@0.90.0`. The SDK supports both ESM and CJS; the worker uses `"type": "module"` so use ESM import.

### References

- `@anthropic-ai/sdk`: `0.90.0`
- Anthropic API docs: https://docs.anthropic.com/en/api
- Tool use guide: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- PITFALLS.md sections 4.1–4.4

---

## 4. Voyage AI Embeddings

### Approach

Use the `voyageai` npm package (Fern-generated SDK):

```typescript
import { VoyageAIClient } from 'voyageai';

const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });

export async function embedText(text: string): Promise<number[]> {
  const response = await voyage.embed({
    input: [text],
    model: 'voyage-2',  // 1024 dimensions — pin this explicitly
  });
  
  const embedding = response.data?.[0]?.embedding;
  if (!embedding || embedding.length !== 1024) {
    throw new Error(`Expected 1024-dim embedding, got: ${embedding?.length ?? 'null'}`);
  }
  return embedding;
}
```

For Tier 2, the text to embed is a combination of offer title + description + URL (normalized):

```typescript
const embedInput = `${title}\n${description ?? ''}\n${destinationUrl}`.trim();
const embedding = await embedText(embedInput);
```

### Key Details

- **Model**: `voyage-2` produces 1024-dimensional embeddings. This matches the `vector(1024)` column in the schema. **Always pin the model name explicitly** — the API default may change.
- **Alternative model**: `voyage-large-2` offers higher quality at higher cost. For v1, `voyage-2` is sufficient.
- **Request format**: `{ input: string[], model: string }`. Input is an array even for a single string.
- **Response format**: `{ data: [{ embedding: number[], index: number }], usage: { total_tokens: number } }`
- **Dimension check**: Assert `embedding.length === 1024` before any DB insert (PITFALLS.md 3.2).
- **Rate limits**: Voyage AI rate limits at ~300 RPM for the free tier, ~3000 RPM on paid. For v1 with a single worker, this is not a concern during normal operation. During bulk backfill, use `p-limit` to throttle.
- **Pricing**: `voyage-2` is approximately $0.10 per 1M tokens. For a typical offer text (100–200 tokens), this is negligible.
- **ESM compatibility**: `voyageai@0.2.1` — verify it works with the worker's `"type": "module"`. The package uses `node-fetch` as a dependency; in Node 22 this may cause a warning. If issues arise, use native `fetch` directly against `https://api.voyageai.com/v1/embeddings`.

### Direct fetch fallback (if voyageai SDK has ESM issues):

```typescript
async function embedText(text: string): Promise<number[]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model: 'voyage-2' }),
  });
  
  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status}`);
  }
  
  const data = await response.json() as { data: [{ embedding: number[] }] };
  const embedding = data.data[0]?.embedding;
  if (!embedding || embedding.length !== 1024) {
    throw new Error(`Bad embedding dimensions: ${embedding?.length}`);
  }
  return embedding;
}
```

### References

- `voyageai`: `0.2.1`
- Voyage AI API docs: https://docs.voyageai.com/reference/embeddings-api
- PITFALLS.md section 3.2
- STACK.md (voyageai entry)

---

## 5. URL Normalization & Dedup

### Approach

Three-step pipeline: redirect follow → normalize → hash.

```typescript
import normalizeUrl from 'normalize-url';
import { createHash } from 'node:crypto';

async function followOneRedirect(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        // Log if location itself is a redirect (we don't follow further)
        return location;
      }
    }
    return url;
  } catch {
    // Network error — return original URL
    return url;
  }
}

export async function normalizeAndHash(rawUrl: string): Promise<{ normalizedUrl: string; hash: string }> {
  const resolved = await followOneRedirect(rawUrl);
  
  const normalizedUrl = normalizeUrl(resolved, {
    stripWWW: false,           // keep www — some sites have different content
    removeQueryParameters: [/^utm_/i, 'ref', 'source', 'fbclid', 'gclid'],
    sortQueryParameters: true,
    stripHash: true,
    normalizeProtocol: true,
  });
  
  const hash = createHash('sha256').update(normalizedUrl).digest('hex');
  return { normalizedUrl, hash };
}
```

**URL hash dedup check** (before embedding dedup):

```typescript
export async function findExistingOfferByHash(
  db: ReturnType<typeof createClient>,
  urlHash: string
): Promise<string | null> {
  const { data, error } = await db
    .from('offers')
    .select('id')
    .eq('destination_url_hash', urlHash)
    .limit(1)
    .single();
  
  if (error || !data) return null;
  return data.id;
}
```

**pgvector cosine similarity query** (fallback after hash miss):

```typescript
export async function findSimilarOffer(
  db: ReturnType<typeof createClient>,
  embedding: number[],
  threshold: number = 0.85
): Promise<string | null> {
  // Set ivfflat probes for this session before the query (DDP-04)
  await db.rpc('set_ivfflat_probes', { probes: 10 });
  // Or use raw SQL via Supabase RPC if the above isn't available:
  // await db.rpc('set_config', { setting: 'ivfflat.probes', value: '10', is_local: true });
  
  const vectorStr = `[${embedding.join(',')}]`;
  
  const { data, error } = await db.rpc('find_similar_offer', {
    query_embedding: vectorStr,
    similarity_threshold: threshold,
    match_count: 1,
  });
  
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}
```

The `find_similar_offer` RPC function needs to be created in the schema:

```sql
-- Add to schema.sql
CREATE OR REPLACE FUNCTION find_similar_offer(
  query_embedding vector(1024),
  similarity_threshold float,
  match_count int
)
RETURNS TABLE(id uuid, similarity float)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Set probes for this transaction
  PERFORM set_config('ivfflat.probes', '10', true);
  
  RETURN QUERY
  SELECT
    offers.id,
    1 - (offers.embedding <=> query_embedding) AS similarity
  FROM offers
  WHERE 1 - (offers.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY offers.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**Amazon URL normalization** (PITFALLS.md 5.2):

```typescript
function normalizeAmazonUrl(url: string): string {
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i) 
    ?? url.match(/\/gp\/product\/([A-Z0-9]{10})/i)
    ?? url.match(/\/([A-Z0-9]{10})(?:\/|\?|$)/);
  
  if (asinMatch && url.includes('amazon.')) {
    return `https://www.amazon.com/dp/${asinMatch[1]}`;
  }
  return url;
}
```

### Key Details

- **`normalize-url` v9 is ESM-only**: Use `import normalizeUrl from 'normalize-url'` not `require()`. The worker is already `"type": "module"` — this is fine.
- **Redirect follow timeout**: Set a 5-second timeout via `AbortSignal.timeout(5000)` to avoid hanging the pipeline on slow shortener services.
- **`redirect: 'manual'`**: This is the correct `fetch` option to receive the 3xx response without auto-following. The `location` header contains the target URL.
- **One level only**: Do NOT recurse into the resolved URL for another redirect check. Log if the resolved URL is itself a shortener domain (PITFALLS.md 5.3).
- **JS redirect shorteners**: Known problematic domains (`linktr.ee`, some custom shorteners) return 200 with JS that redirects. Flag these with `url_resolved=false` and skip embedding dedup — use only URL hash dedup with the raw shortener URL.
- **`ivfflat.probes`**: Must be set per-session before the cosine query (DDP-04). The Supabase RPC approach is the cleanest way to do this within the `find_similar_offer` function.
- **Hash dedup first**: URL hash check is O(1) with the `offers_url_hash_idx` index. Only fall through to embedding dedup if hash misses. This saves Voyage API calls on exact duplicates.
- **`destination_url_hash` uniqueness**: The schema does NOT have a UNIQUE constraint on this column (only an index) — add `ON CONFLICT DO NOTHING` or check before insert to handle races.

### References

- `normalize-url`: `9.0.0`
- Node.js `crypto`: built-in, no install needed
- PITFALLS.md sections 5.1–5.3, 7.2
- STACK.md (URL Normalization section)

---

## 6. Zod Validation for Tier 2 Output

### Approach

Zod v4 (breaking changes from v3 — check migration guide if upgrading existing code, but this project starts fresh with v4):

```typescript
import { z } from 'zod';

// Tier 2 tool output schema — must match the tool's input_schema
export const OfferExtractionSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  brand: z.string().optional(),
  destination_url: z.string().url(),
  category: z.enum(['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other']).optional(),
  offer_type: z.enum(['sample', 'full_product', 'bundle', 'other']).optional(),
  shipping_cost: z.number().min(0).default(0),
  restrictions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  is_excluded: z.boolean(),
  exclusion_reason: z.string().optional(),
});

export type OfferExtraction = z.infer<typeof OfferExtractionSchema>;

// Tier 1 result schema
export const Tier1ResultSchema = z.object({
  decision: z.enum(['pass', 'reject']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  prompt_version: z.string(),
});

export type Tier1Result = z.infer<typeof Tier1ResultSchema>;
```

Usage in Tier 2 handler:

```typescript
const rawInput: unknown = toolBlock.input;

const parseResult = OfferExtractionSchema.safeParse(rawInput);

if (!parseResult.success) {
  // Zod validation failure — route to human_review_queue
  logger.error({ 
    event: 'tier2_zod_failure', 
    issues: parseResult.error.issues,
    raw_input: rawInput 
  });
  await routeToHumanReview(db, postId, rawInput, 0, 'zod_validation_failure');
  return;
}

const extraction = parseResult.data;

// Exclusion check (CLS-04)
if (extraction.is_excluded) {
  await markPostRejected(db, postId, extraction.exclusion_reason ?? 'excluded');
  return;
}

// Shipping cost check (belt and suspenders)
if (extraction.shipping_cost > 0) {
  await markPostRejected(db, postId, 'paid_shipping');
  return;
}

// Low confidence routing (CLS-05)
if (extraction.confidence < 0.7) {
  await routeToHumanReview(db, postId, extraction, extraction.confidence, 'low_confidence');
  return;
}
```

### Key Details

- **Zod v4 vs v3**: `zod@4.3.6` is the target. Key API differences from v3: `z.string().url()` behavior may differ slightly; `z.object()` strict mode is `z.strictObject()` in v4. For this use case, the API is largely compatible.
- **`safeParse` vs `parse`**: Use `safeParse` to get a result object instead of throwing. This allows routing to DLQ/human review instead of crashing the consumer.
- **`toolBlock.input` type**: The Anthropic SDK types `toolBlock.input` as `unknown` in recent versions — this is correct. Always validate before use.
- **Schema in tool definition vs Zod schema**: The JSON Schema passed to the Anthropic API (`input_schema`) and the Zod schema (`OfferExtractionSchema`) must be kept in sync manually. Consider generating one from the other, or at minimum add a comment linking them.
- **`required` fields**: The Anthropic tool schema's `required` array and the Zod schema's `.optional()` designations must be consistent. If the model can omit `brand`, both schemas should reflect that.

### References

- `zod`: `4.3.6`
- Zod docs: https://zod.dev
- PITFALLS.md section 4.4

---

## 7. Worker Architecture

### Approach

**Startup sequence** (`apps/worker/src/index.ts`):

```typescript
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createClient } from '@repo/db';

async function main(): Promise<void> {
  // 1. Capture git hash for prompt versioning (D-12)
  const promptVersion = execSync('git rev-parse --short HEAD').toString().trim();
  
  // 2. Load prompts from disk once (D-11)
  const tier1Prompt = readFileSync(new URL('../../prompts/tier1-classify.md', import.meta.url), 'utf-8');
  const tier2Prompt = readFileSync(new URL('../../prompts/tier2-extract.md', import.meta.url), 'utf-8');
  
  // 3. Initialize DB client
  const db = createClient();
  
  // 4. Assert extensions are present (D-18, WRK-02)
  const { data: extensions } = await db.rpc('check_required_extensions');
  const installed = new Set(extensions?.map((e: { extname: string }) => e.extname));
  for (const ext of ['vector', 'pgmq', 'pg_cron']) {
    if (!installed.has(ext)) {
      throw new Error(`Required Postgres extension missing: ${ext}`);
    }
  }
  
  // 5. HTTP health endpoint (D-16)
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(process.env.PORT ? parseInt(process.env.PORT) : 3001, '0.0.0.0');
  
  // 6. Graceful shutdown setup (D-15)
  const shutdown = { stop: false };
  const gracefulShutdown = () => {
    shutdown.stop = true;
    server.close();
    // Allow in-flight messages to complete — process exits when all loops return
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
  
  // 7. Start three concurrent loops (D-14)
  await Promise.all([
    runRedditIngestionLoop(db, promptVersion, shutdown),
    runTier1Consumer(db, tier1Prompt, promptVersion, shutdown),
    runTier2Consumer(db, tier2Prompt, promptVersion, shutdown),
  ]);
}

main().catch(err => {
  console.error('Worker fatal error:', err);
  process.exit(1);
});
```

**Polling loop pattern** — use recursive `setTimeout` to avoid drift:

```typescript
async function runRedditIngestionLoop(
  db: ReturnType<typeof createClient>,
  promptVersion: string,
  shutdown: { stop: boolean }
): Promise<void> {
  while (!shutdown.stop) {
    const startTime = Date.now();
    try {
      await runIngestionCycle(db, promptVersion);
    } catch (err) {
      logger.error({ event: 'ingestion_cycle_error', error: err });
    }
    
    const elapsed = Date.now() - startTime;
    const sleepMs = Math.max(0, 5 * 60 * 1000 - elapsed);  // 5-min interval
    await sleep(sleepMs);
  }
}
```

**File path for prompts**: Since the worker is compiled by tsup into `dist/`, use `import.meta.url` relative paths carefully, or pass the resolved path at startup time before compilation. Safest approach: resolve prompt paths from `process.cwd()` which is the monorepo root when run in dev/prod, or use an env var `PROMPTS_DIR`.

### Key Details

- **Three concurrent loops via `Promise.all`**: The Reddit polling loop and two pgmq consumers run concurrently. `Promise.all` keeps the process alive until all loops complete (on shutdown). If any loop throws an unhandled error, `Promise.all` rejects and the process exits.
- **`shutdown.stop` flag**: A shared mutable object flag is the simplest approach for coordinating shutdown across loops. Railway sends SIGTERM ~10 seconds before SIGKILL, giving time for in-flight messages.
- **Health endpoint port**: Use `process.env.PORT` (Railway injects this) with a fallback of `3001`. Railway health checks are HTTP GET `/health` — respond 200 OK.
- **`git rev-parse --short HEAD`**: Works in Railway deployments since Railway runs from a git checkout. In CI/CD where `git` may not be available, fall back to an env var `DEPLOY_SHA` or `RAILWAY_GIT_COMMIT_SHA` (Railway provides this).
- **`readFileSync` for prompts**: The `prompts/` directory is at the monorepo root. The worker in dev is run from `apps/worker/` via `tsx watch src/index.ts`, but `process.cwd()` is the monorepo root in Turborepo. Safest: use an env var `PROMPTS_DIR=../../prompts` or resolve with `path.resolve(process.cwd(), 'prompts')`.
- **Prompt directory**: The `prompts/` directory does not yet exist — must be created with `tier1-classify.md` and `tier2-extract.md` during this phase.
- **Error isolation**: Each loop should catch errors internally and log them without crashing. Only fatal errors (DB connection failure, missing extensions) should propagate to `main()`.
- **`setInterval` vs recursive `setTimeout`**: Recursive `setTimeout` with `Math.max(0, interval - elapsed)` is preferred because it prevents drift when an ingestion cycle takes longer than the interval. `setInterval` would fire immediately after a slow cycle.
- **DLQ queue creation**: Create `tier1_dlq` and `tier2_dlq` queues during worker startup startup assertion, or in the schema.sql alongside the main queues. Startup is the right place since it can verify and create idempotently.

### References

- Node.js `http.createServer`: built-in
- Node.js `child_process.execSync`: built-in
- Railway env vars: `PORT`, `RAILWAY_GIT_COMMIT_SHA`
- CONTEXT.md D-14 through D-18

---

## 8. Key Integration Gotcha: env var name mismatch

The `.env.example` file uses `SUPABASE_SERVICE_KEY` but `packages/db/src/client.ts` reads `SUPABASE_SERVICE_ROLE_KEY`. These must be reconciled before the worker can connect to the database. Check which is correct against the Supabase project settings (it is conventionally `SUPABASE_SERVICE_ROLE_KEY`) and update `.env.example` to match.

---

## 9. SourceAdapter Interface

Per ING-01, the interface must be:

```typescript
// apps/worker/src/ingestion/source-adapter.ts
export interface RawPost {
  external_id: string;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  posted_at: Date | null;
}

export interface SourceAdapter {
  fetchNewPosts(since: Date): Promise<RawPost[]>;
}
```

Decision D-53 (Claude's discretion): Keep `SourceAdapter` worker-local in `apps/worker/src/ingestion/` rather than in `@repo/db`. The interface is only relevant to the worker; moving it to `@repo/db` would add a worker-specific concept to a shared package.

---

## Dependencies to Install

Add to `apps/worker/package.json` dependencies:

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "0.90.0",
    "@axiomhq/js": "1.6.0",
    "@repo/db": "workspace:*",
    "normalize-url": "9.0.0",
    "p-limit": "7.3.0",
    "p-retry": "8.0.0",
    "snoowrap": "1.23.0",
    "voyageai": "0.2.1",
    "zod": "4.3.6"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "@types/node": "22.15.3",
    "tsx": "^4.19.4",
    "tsup": "^8.5.0",
    "typescript": "^5",
    "vitest": "^3.2.1"
  }
}
```

**Notes:**
- `snoowrap` is pinned without `^` (exact version) per PITFALLS.md 1.1
- `normalize-url` v9 is ESM-only — works fine with worker's `"type": "module"`
- `voyageai` uses `node-fetch` as a dep; if ESM compatibility issues arise with Node 22, use the native `fetch` fallback pattern documented above
- Do NOT install `@types/snoowrap` — it's a deprecated stub, snoowrap ships its own types

**New SQL functions needed in schema.sql:**
- `find_similar_offer(query_embedding, similarity_threshold, match_count)` — for pgvector cosine dedup via RPC

---

## Risk Areas

| Risk | Mitigation |
|---|---|
| pgmq RPC function names differ from raw SQL names | Verify `pgmq_send` vs `pgmq.send` against Supabase SQL editor before coding; document verified names in a comment at the top of the queue module |
| `voyageai` package ESM compatibility | Test import in isolation first; have native `fetch` fallback ready |
| snoowrap `MoreComments` traversal gives empty bodies | Check `constructor.name` before accessing `.body`; add integration test with a real subreddit |
| pgvector `ivfflat.probes` session setting via Supabase RPC | Embed the `SET` call inside the `find_similar_offer` PL/pgSQL function so it always fires in the same transaction |
| `git rev-parse` fails on Railway if git is not in PATH | Read `RAILWAY_GIT_COMMIT_SHA` env var as fallback; log a warning if both fail |
| Prompts directory path resolution between dev and Railway | Use an env var `PROMPTS_DIR` with a sensible default; resolve to absolute path at startup |
| `SUPABASE_SERVICE_KEY` vs `SUPABASE_SERVICE_ROLE_KEY` mismatch in .env.example | Standardize on `SUPABASE_SERVICE_ROLE_KEY` everywhere — fix `.env.example` in this phase |
| Zod v4 breaking changes if examples use v3 syntax | Start with v4 from scratch — no migration needed since no existing code uses Zod |
| Anthropic SDK v0.90 has `"type": "commonjs"` in package.json | The worker is `"type": "module"` — SDK exports both CJS and ESM via its `exports` map; use the ESM import path |
| Race condition on dual Tier 2 workers inserting same offer | For v1 single worker this is low risk; document and add `pg_advisory_xact_lock` before scaling |

---

## Implementation Order

Build in this strict dependency order within the phase:

1. **`apps/worker/package.json`** — add all dependencies, run `pnpm install`
2. **`apps/worker/tsconfig.json`** — verify TypeScript config inherits base correctly
3. **`apps/worker/src/config.ts`** — model strings, pricing constants, prompt paths
4. **`prompts/tier1-classify.md`** and **`prompts/tier2-extract.md`** — write initial prompt files
5. **`apps/worker/src/ingestion/source-adapter.ts`** — `SourceAdapter` interface + `RawPost` type
6. **`apps/worker/src/ingestion/reddit-adapter.ts`** — snoowrap OAuth, comment traversal, bot guards
7. **`apps/worker/src/tiers/tier0-keywords.ts`** — initial keyword list
8. **`apps/worker/src/tiers/tier0.ts`** — keyword filter function
9. **`apps/worker/src/queue/producer.ts`** — `enqueueTier1()`, `enqueueTier2()`
10. **`apps/worker/src/ingestion/ingest.ts`** — orchestrates adapter → Tier 0 → DB write → enqueue
11. **`apps/worker/src/tiers/schemas.ts`** — Zod schemas for Tier 1/2 validation
12. **`apps/worker/src/tiers/tier1.ts`** — Haiku classifier, `ai_calls` logging
13. **`apps/worker/src/tiers/tier2.ts`** — Sonnet extractor, forced tool use, exclusion checks
14. **`apps/worker/src/dedup/url-hash.ts`** — redirect follow, normalize-url, SHA-256
15. **`apps/worker/src/dedup/embedding-dedup.ts`** — Voyage embed, pgvector cosine query
16. **`apps/worker/src/dedup/index.ts`** — orchestrates hash → embedding dedup → offer insert
17. **`apps/worker/src/queue/consumer.ts`** — generic consumer loop with finally-archive pattern
18. **`apps/worker/src/index.ts`** — startup assertions, prompt loading, health endpoint, three loops
19. **Add `find_similar_offer` SQL function to `packages/db/src/schema.sql`**
20. **Fix `.env.example`** — reconcile `SUPABASE_SERVICE_KEY` → `SUPABASE_SERVICE_ROLE_KEY`

---

*Phase: 02-worker-pipeline-ingestion-classification-dedup-logging*
*Research completed: 2026-04-20*
