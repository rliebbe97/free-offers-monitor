export function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable is not set: ${name}`);
  return value;
}

// Validate all required env vars at module load time — fail fast with clear messages
getEnvOrThrow('ANTHROPIC_API_KEY');
getEnvOrThrow('VOYAGE_API_KEY');

// Model strings — pinned to dated versions (PITFALLS.md 4.3: never use unversioned aliases)
export const TIER1_MODEL = 'claude-haiku-4-5-20251001';
export const TIER2_MODEL = 'claude-sonnet-4-6';

// Per-token pricing constants (USD), per Anthropic's published rates as of 2026-04
// Haiku 4.5: $1 / MTok input, $5 / MTok output
// Sonnet 4.6: $3 / MTok input, $15 / MTok output
export const MODEL_PRICING = {
  [TIER1_MODEL]: { input: 1.00 / 1_000_000, output: 5.00 / 1_000_000 },
  [TIER2_MODEL]: { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
} as const;

// Pipeline constants
export const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const POSTS_PER_POLL = 25;
export const TIER1_VISIBILITY_TIMEOUT = 30; // seconds
export const TIER2_VISIBILITY_TIMEOUT = 120; // seconds
export const CONSUMER_BATCH_SIZE = 5;
export const DLQ_RETRY_THRESHOLD = 3;
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;

// Scraping constants (INGEST-05)
export const SCRAPING_REQUEST_TIMEOUT_MS = 15_000;
export const SCRAPING_MAX_RETRIES = 3;
export const SCRAPING_MAX_PAGES = 10;
export const THEBUMP_BASE_URL = process.env.THEBUMP_BASE_URL ?? 'https://community.thebump.com';

// Reddit ingestion (public JSON endpoints — no OAuth)
export const REDDIT_BASE_URL = process.env.REDDIT_BASE_URL ?? 'https://old.reddit.com';
export const REDDIT_USER_AGENT =
  process.env.REDDIT_USER_AGENT ?? 'free-offers-monitor/1.0 (by /u/Alternative-Owl-7042)';

// Validation loop constants
export const VALIDATION_POLL_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
export const VALIDATION_CHECK_INTERVAL_DAYS = 7;              // normal recheck cycle
export const VALIDATION_RETRY_INTERVAL_HOURS = 24;            // after first failure
export const VALIDATION_WAF_RETRY_INTERVAL_HOURS = 6;         // after 403/429 WAF block
export const VALIDATION_REQUEST_TIMEOUT_MS = 10_000;          // 10 seconds per URL
export const VALIDATION_MAX_REDIRECTS = 5;                    // max redirect hops
export const VALIDATION_JITTER_HOURS = 6;                     // max random jitter spread
export const VALIDATION_CONCURRENT_LIMIT = 5;                 // max concurrent requests
export const VALIDATION_RAW_RESPONSE_MAX_CHARS = 2_000;       // verification_log truncation

/**
 * Compute the estimated USD cost of an AI call given model, input tokens, and output tokens.
 * Throws if the model is not found in MODEL_PRICING.
 */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  if (!pricing) throw new Error(`Unknown model for pricing: ${model}`);
  return pricing.input * inputTokens + pricing.output * outputTokens;
}
