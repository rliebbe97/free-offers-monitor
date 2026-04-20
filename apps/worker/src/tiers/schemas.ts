import { z } from 'zod';

/**
 * Zod schema for Haiku Tier 1 binary classification response.
 * Use safeParse() when parsing Haiku's raw text output —
 * parse failures should throw to route the message to DLQ.
 */
export const Tier1ResultSchema = z.object({
  decision: z.enum(['pass', 'reject']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  prompt_version: z.string(),
});

export type Tier1Result = z.infer<typeof Tier1ResultSchema>;

/**
 * SYNC WARNING: The JSON Schema in EXTRACT_OFFER_TOOL (apps/worker/src/tiers/tier2.ts)
 * must be kept in sync with this Zod schema. Any field additions or type changes here
 * must be mirrored there.
 *
 * Zod schema for Sonnet Tier 2 structured extraction output.
 * Use safeParse() after validating the tool use response —
 * validation failures should throw to route the message to DLQ.
 */
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
