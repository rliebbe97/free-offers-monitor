import Anthropic from '@anthropic-ai/sdk';
import type { createClient } from '@repo/db';
import { logger } from '../logger.js';
import { TIER1_MODEL, computeCost } from '../config.js';
import { enqueueTier2 } from '../queue/producer.js';
import { Tier1ResultSchema } from './schemas.js';

type DbClient = ReturnType<typeof createClient>;

// Pipeline statuses that indicate Tier 1 has already been processed
const ALREADY_PROCESSED_STATUSES = new Set([
  'tier1_passed',
  'tier1_rejected',
  'tier2_done',
  'dedup_matched',
  'published',
  'review_queued',
  'error',
]);

/**
 * Log an AI call to the ai_calls table. Always called — on both success and failure.
 */
async function logAiCall(
  db: DbClient,
  params: {
    postId: string;
    model: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown> | null;
    error: string | null;
  },
): Promise<void> {
  const { error: insertError } = await db.from('ai_calls').insert({
    post_id: params.postId,
    tier: 1,
    model: params.model,
    prompt_version: params.promptVersion,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    cost_usd: params.costUsd,
    latency_ms: params.latencyMs,
    request_payload: params.requestPayload,
    response_payload: params.responsePayload,
    error: params.error,
  });

  if (insertError) {
    logger.error('ai_calls_insert_error', {
      post_id: params.postId,
      tier: 1,
      error: insertError.message,
    });
  }
}

export interface ProcessTier1Options {
  db: DbClient;
  anthropic: Anthropic;
  postId: string;
  prompt: string;
  promptVersion: string;
}

/**
 * Process a single post through the Tier 1 Haiku binary classifier.
 *
 * Steps:
 * 1. Idempotency guard — skip if post is already beyond tier0_passed
 * 2. Fetch post title and body
 * 3. Call Anthropic Haiku with the tier1-classify prompt
 * 4. Parse and validate the JSON response
 * 5. Log to ai_calls (always, on both success and failure)
 * 6. Update post with tier1_result and pipeline_status
 * 7. Enqueue passing posts to tier2_queue
 *
 * Throws on parse/validation errors — the consumer routes to DLQ after threshold.
 */
export async function processTier1(options: ProcessTier1Options): Promise<void> {
  const { db, anthropic, postId, prompt, promptVersion } = options;

  // Step 1: Idempotency guard — check current pipeline_status
  const { data: postCheck, error: checkError } = await db
    .from('posts')
    .select('pipeline_status')
    .eq('id', postId)
    .single();

  if (checkError) {
    throw new Error(`Failed to fetch post status for idempotency check: ${checkError.message}`);
  }

  if (!postCheck) {
    throw new Error(`Post not found: ${postId}`);
  }

  if (ALREADY_PROCESSED_STATUSES.has(postCheck.pipeline_status)) {
    logger.info('tier1_idempotency_skip', {
      post_id: postId,
      pipeline_status: postCheck.pipeline_status,
    });
    return;
  }

  // Step 2: Fetch post content
  const { data: post, error: fetchError } = await db
    .from('posts')
    .select('title, body')
    .eq('id', postId)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch post content: ${fetchError.message}`);
  }

  if (!post) {
    throw new Error(`Post not found: ${postId}`);
  }

  const postContent = `Title: ${post.title ?? ''}\n\nBody: ${post.body ?? ''}`;
  const requestPayload: Record<string, unknown> = {
    model: TIER1_MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
  };

  // Step 3: Call Anthropic Haiku, measure latency
  const startMs = Date.now();
  let response: Anthropic.Message;
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let rawText = '';

  try {
    response = await anthropic.messages.create({
      model: TIER1_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
    });

    latencyMs = Date.now() - startMs;
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;

    const textBlock = response.content.find((block) => block.type === 'text');
    rawText = textBlock?.type === 'text' ? textBlock.text : '';
  } catch (err) {
    latencyMs = Date.now() - startMs;
    const errorMsg = String(err);

    await logAiCall(db, {
      postId,
      model: TIER1_MODEL,
      promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs,
      requestPayload,
      responsePayload: null,
      error: errorMsg,
    });

    throw new Error(`Anthropic API error for post ${postId}: ${errorMsg}`);
  }

  const costUsd = computeCost(TIER1_MODEL, inputTokens, outputTokens);
  const responsePayload: Record<string, unknown> = {
    stop_reason: response.stop_reason,
    usage: response.usage,
    content: rawText.slice(0, 1000), // truncate for storage
  };

  // Step 4: Parse and validate the JSON response
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (parseErr) {
    const errorMsg = `JSON parse failed: ${String(parseErr)}. Raw: ${rawText.slice(0, 200)}`;

    await logAiCall(db, {
      postId,
      model: TIER1_MODEL,
      promptVersion,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      requestPayload,
      responsePayload,
      error: errorMsg,
    });

    throw new Error(`Tier 1 JSON parse failure for post ${postId}: ${errorMsg}`);
  }

  // Inject prompt_version into parsed object for schema validation
  const withVersion =
    parsedJson !== null && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
      ? { ...(parsedJson as Record<string, unknown>), prompt_version: promptVersion }
      : parsedJson;

  const validation = Tier1ResultSchema.safeParse(withVersion);

  if (!validation.success) {
    const errorMsg = `Zod validation failed: ${validation.error.message}`;

    await logAiCall(db, {
      postId,
      model: TIER1_MODEL,
      promptVersion,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      requestPayload,
      responsePayload,
      error: errorMsg,
    });

    throw new Error(`Tier 1 Zod validation failure for post ${postId}: ${errorMsg}`);
  }

  const result = validation.data;

  // Step 5: Log to ai_calls on success
  await logAiCall(db, {
    postId,
    model: TIER1_MODEL,
    promptVersion,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    requestPayload,
    responsePayload,
    error: null,
  });

  logger.info('tier1_classified', {
    post_id: postId,
    decision: result.decision,
    confidence: result.confidence,
    reason: result.reason,
    latency_ms: latencyMs,
    cost_usd: costUsd,
  });

  // Step 6: Update post with tier1_result and pipeline_status
  const tier1Result = {
    decision: result.decision,
    confidence: result.confidence,
    reason: result.reason,
    prompt_version: promptVersion,
  };

  if (result.decision === 'pass') {
    const { error: updateError } = await db
      .from('posts')
      .update({
        tier1_result: tier1Result,
        pipeline_status: 'tier1_passed',
      })
      .eq('id', postId);

    if (updateError) {
      throw new Error(`Failed to update post as tier1_passed: ${updateError.message}`);
    }

    // Step 7: Enqueue to tier2_queue
    await enqueueTier2(db, postId);

    logger.info('tier1_enqueued_tier2', { post_id: postId });
  } else {
    const { error: updateError } = await db
      .from('posts')
      .update({
        tier1_result: tier1Result,
        pipeline_status: 'tier1_rejected',
      })
      .eq('id', postId);

    if (updateError) {
      throw new Error(`Failed to update post as tier1_rejected: ${updateError.message}`);
    }
  }
}
