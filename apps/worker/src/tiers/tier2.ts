import Anthropic from '@anthropic-ai/sdk';
import type { createClient } from '@repo/db';
import type { Json } from '@repo/db';
import { logger } from '../logger.js';
import { TIER2_MODEL, computeCost } from '../config.js';
import { OfferExtractionSchema } from './schemas.js';
import { runDedup } from '../dedup/index.js';

type DbClient = ReturnType<typeof createClient>;

/**
 * SYNC WARNING: This JSON Schema must be kept in sync with OfferExtractionSchema
 * in schemas.ts. Any field additions or type changes must be mirrored in both places.
 */
export const EXTRACT_OFFER_TOOL = {
  name: 'extract_offer',
  description: 'Extract structured offer data from a post about a free product offer',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'Concise offer title (e.g., "Free Pampers Sample Pack")',
      },
      description: {
        type: 'string',
        description: 'Brief summary of what the user receives',
      },
      brand: {
        type: 'string',
        description: 'The company or brand offering the product',
      },
      destination_url: {
        type: 'string',
        description: 'Primary URL to claim the offer; use the post URL if none is provided',
      },
      category: {
        type: 'string',
        enum: ['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other'],
        description: 'Product category',
      },
      offer_type: {
        type: 'string',
        enum: ['sample', 'full_product', 'bundle', 'other'],
        description: 'Type of offer',
      },
      shipping_cost: {
        type: 'number',
        minimum: 0,
        description: 'Shipping cost in USD. Use 0 if explicitly free shipping.',
      },
      restrictions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Any limitations stated (e.g., "US only", "first-time customers")',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence score 0-1 that this is a genuine free physical goods offer',
      },
      is_excluded: {
        type: 'boolean',
        description:
          'True if the offer fails exclusion criteria (coupon, service, trial, sweepstakes, shipping > 0, digital-only, requires purchase)',
      },
      exclusion_reason: {
        type: 'string',
        description:
          'If is_excluded is true: reason (coupon, service, trial, sweepstakes, paid_shipping, digital, requires_purchase)',
      },
    },
    required: ['title', 'destination_url', 'confidence', 'is_excluded'],
  },
} as const;

// Pipeline statuses that indicate Tier 2 processing should be skipped
const ALREADY_PROCESSED_STATUSES = new Set([
  'tier2_done',
  'tier2_excluded',
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
    requestPayload: Json;
    responsePayload: Json | null;
    error: string | null;
  },
): Promise<void> {
  const { error: insertError } = await db.from('ai_calls').insert({
    post_id: params.postId,
    tier: 2,
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
      tier: 2,
      error: insertError.message,
    });
  }
}

export interface ProcessTier2Options {
  db: DbClient;
  anthropic: Anthropic;
  postId: string;
  prompt: string;
  promptVersion: string;
}

/**
 * Process a single post through the Tier 2 Sonnet structured extractor.
 *
 * Steps:
 * 1. Idempotency guard — skip if post is already past tier1_passed
 * 2. Fetch post title and body
 * 3. Call Anthropic Sonnet with forced tool use (extract_offer tool)
 * 4. Assert stop_reason === 'tool_use'
 * 5. Extract and validate tool block with OfferExtractionSchema
 * 6. Log to ai_calls (always — success and failure)
 * 7. Apply exclusion checks (is_excluded, shipping_cost > 0)
 * 8. Route low-confidence results (< 0.7) to human_review_queue
 * 9. Pass qualifying offers to dedup pipeline
 */
export async function processTier2(options: ProcessTier2Options): Promise<void> {
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
    logger.info('tier2_idempotency_skip', {
      post_id: postId,
      pipeline_status: postCheck.pipeline_status,
    });
    return;
  }

  // Step 2: Fetch post content
  const { data: post, error: fetchError } = await db
    .from('posts')
    .select('title, body, url')
    .eq('id', postId)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch post content: ${fetchError.message}`);
  }

  if (!post) {
    throw new Error(`Post not found: ${postId}`);
  }

  const postContent = `Title: ${post.title ?? ''}\n\nBody: ${post.body ?? ''}\n\nPost URL: ${post.url}`;
  const requestPayload: Json = {
    model: TIER2_MODEL,
    max_tokens: 1024,
    tool_choice: { type: 'tool', name: 'extract_offer' },
    messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
  };

  // Step 3: Call Anthropic Sonnet with forced tool use, measure latency
  const startMs = Date.now();
  let response: Anthropic.Message;
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    response = await anthropic.messages.create({
      model: TIER2_MODEL,
      max_tokens: 1024,
      tools: [EXTRACT_OFFER_TOOL],
      tool_choice: { type: 'tool', name: 'extract_offer' },
      messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
    });

    latencyMs = Date.now() - startMs;
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  } catch (err) {
    latencyMs = Date.now() - startMs;
    const errorMsg = String(err);

    await logAiCall(db, {
      postId,
      model: TIER2_MODEL,
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

  const costUsd = computeCost(TIER2_MODEL, inputTokens, outputTokens);
  const responsePayload: Json = {
    stop_reason: response.stop_reason as string | null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  // Step 4: Assert stop_reason === 'tool_use'
  if (response.stop_reason !== 'tool_use') {
    const errorMsg = `Expected stop_reason 'tool_use', got: '${response.stop_reason}'`;

    await logAiCall(db, {
      postId,
      model: TIER2_MODEL,
      promptVersion,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      requestPayload,
      responsePayload,
      error: errorMsg,
    });

    throw new Error(`Tier 2 stop_reason assertion failed for post ${postId}: ${errorMsg}`);
  }

  // Step 5: Extract tool block
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'extract_offer',
  );

  if (!toolBlock) {
    const errorMsg = 'No extract_offer tool block found in response content';

    await logAiCall(db, {
      postId,
      model: TIER2_MODEL,
      promptVersion,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      requestPayload,
      responsePayload,
      error: errorMsg,
    });

    throw new Error(`Tier 2 tool block missing for post ${postId}: ${errorMsg}`);
  }

  // Validate with Zod
  const parseResult = OfferExtractionSchema.safeParse(toolBlock.input);

  if (!parseResult.success) {
    const errorMsg = `Zod validation failed: ${parseResult.error.message}`;

    await logAiCall(db, {
      postId,
      model: TIER2_MODEL,
      promptVersion,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      requestPayload,
      responsePayload: {
        ...responsePayload,
        tool_input: toolBlock.input as Json,
        zod_error: errorMsg,
      },
      error: errorMsg,
    });

    logger.error('tier2_zod_failure', {
      post_id: postId,
      issues: parseResult.error.issues,
    });

    // Route Zod failure to human_review_queue — not DLQ
    const tier2Result: Json = {
      error: 'zod_validation_failure',
      raw_input: toolBlock.input as Json,
      zod_error: errorMsg,
    };

    await db.from('human_review_queue').insert({
      post_id: postId,
      tier2_result: tier2Result,
      confidence: 0,
    });

    await db
      .from('posts')
      .update({ pipeline_status: 'review_queued', tier2_result: tier2Result })
      .eq('id', postId);

    return;
  }

  const extraction = parseResult.data;

  // Step 6: Log to ai_calls on success
  await logAiCall(db, {
    postId,
    model: TIER2_MODEL,
    promptVersion,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    requestPayload,
    responsePayload: {
      ...responsePayload,
      extraction: {
        title: extraction.title,
        destination_url: extraction.destination_url,
        confidence: extraction.confidence,
        is_excluded: extraction.is_excluded,
        exclusion_reason: extraction.exclusion_reason ?? null,
      },
    },
    error: null,
  });

  logger.info('tier2_extracted', {
    post_id: postId,
    title: extraction.title,
    confidence: extraction.confidence,
    is_excluded: extraction.is_excluded,
    exclusion_reason: extraction.exclusion_reason,
    latency_ms: latencyMs,
    cost_usd: costUsd,
  });

  const tier2Result: Json = {
    title: extraction.title,
    description: extraction.description ?? null,
    brand: extraction.brand ?? null,
    destination_url: extraction.destination_url,
    category: extraction.category ?? null,
    offer_type: extraction.offer_type ?? null,
    shipping_cost: extraction.shipping_cost,
    restrictions: extraction.restrictions,
    confidence: extraction.confidence,
    is_excluded: extraction.is_excluded,
    exclusion_reason: extraction.exclusion_reason ?? null,
    prompt_version: promptVersion,
  };

  // Step 7: Exclusion checks
  if (extraction.is_excluded) {
    const { error: updateError } = await db
      .from('posts')
      .update({ tier2_result: tier2Result, pipeline_status: 'tier2_excluded' })
      .eq('id', postId);

    if (updateError) {
      throw new Error(`Failed to update post as tier2_excluded: ${updateError.message}`);
    }

    logger.info('tier2_excluded', {
      post_id: postId,
      reason: extraction.exclusion_reason ?? 'is_excluded=true',
    });
    return;
  }

  if (extraction.shipping_cost > 0) {
    const { error: updateError } = await db
      .from('posts')
      .update({
        tier2_result: { ...tier2Result, exclusion_reason: 'paid_shipping' },
        pipeline_status: 'tier2_excluded',
      })
      .eq('id', postId);

    if (updateError) {
      throw new Error(`Failed to update post as tier2_excluded (paid_shipping): ${updateError.message}`);
    }

    logger.info('tier2_excluded', {
      post_id: postId,
      reason: 'paid_shipping',
      shipping_cost: extraction.shipping_cost,
    });
    return;
  }

  // Step 8: Low-confidence routing
  if (extraction.confidence < 0.7) {
    const { error: reviewError } = await db.from('human_review_queue').insert({
      post_id: postId,
      tier2_result: tier2Result,
      confidence: extraction.confidence,
    });

    if (reviewError) {
      throw new Error(`Failed to insert into human_review_queue: ${reviewError.message}`);
    }

    const { error: updateError } = await db
      .from('posts')
      .update({ tier2_result: tier2Result, pipeline_status: 'review_queued' })
      .eq('id', postId);

    if (updateError) {
      throw new Error(`Failed to update post as review_queued: ${updateError.message}`);
    }

    logger.info('tier2_review_queued', {
      post_id: postId,
      confidence: extraction.confidence,
    });
    return;
  }

  // Step 9: Store tier2_result and proceed to dedup
  const { error: updateError } = await db
    .from('posts')
    .update({ tier2_result: tier2Result, pipeline_status: 'tier2_done' })
    .eq('id', postId);

  if (updateError) {
    throw new Error(`Failed to update post as tier2_done: ${updateError.message}`);
  }

  // Run dedup pipeline
  const dedupResult = await runDedup({ db, postId, extraction });

  if (dedupResult.isNew) {
    const { error: publishError } = await db
      .from('posts')
      .update({ pipeline_status: 'published' })
      .eq('id', postId);

    if (publishError) {
      throw new Error(`Failed to update post as published: ${publishError.message}`);
    }

    logger.info('tier2_offer_published', {
      post_id: postId,
      offer_id: dedupResult.offerId,
      is_new: true,
    });
  } else {
    const { error: dedupMatchError } = await db
      .from('posts')
      .update({ pipeline_status: 'dedup_matched' })
      .eq('id', postId);

    if (dedupMatchError) {
      throw new Error(`Failed to update post as dedup_matched: ${dedupMatchError.message}`);
    }

    logger.info('tier2_dedup_matched', {
      post_id: postId,
      offer_id: dedupResult.offerId,
    });
  }
}
