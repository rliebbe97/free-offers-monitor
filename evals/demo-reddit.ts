import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { OfferExtractionSchema } from '../apps/worker/src/tiers/schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envFile = join(__dirname, '..', '.env.local');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// One-off demo: runs Tier 1 (Haiku) + Tier 2 (Sonnet) on a single live Reddit
// post fetched from r/BabyBumps. Mirrors demo.ts but for a Reddit-shaped input
// to confirm the AI tiers handle Reddit content end to end. Dev-time only —
// does not log to ai_calls.

const TIER1_MODEL = 'claude-haiku-4-5-20251001';
const TIER2_MODEL = 'claude-sonnet-4-6';

// Real post fetched from r/BabyBumps via Reddit's public JSON endpoint.
// Source: https://old.reddit.com/r/BabyBumps/comments/1sr55su/babylist_welcome_box_april_2026/
const REDDIT_POST = {
  external_id: '1sr55su',
  source: 'reddit:BabyBumps',
  url: 'https://old.reddit.com/r/BabyBumps/comments/1sr55su/babylist_welcome_box_april_2026/',
  author: 'mucholderreddit',
  posted_at: new Date(1776724023 * 1000),
  title: 'Babylist welcome box April 2026',
  body: `Just got my box today and this is what was included. It was more than I expected. I think this was better than the Target and Amazon boxes I received. Inventory below:

Dr. browns anti colic bottle

Philips Avent bottle

Mam easy start anti colic bottle

sample size Aveeno healthy start newborn baby balm

Lansinoh breastmilk storage bag

Set of lansinoh breast pads

Huggies diaper sample, size 1(qty 3)

Rascals newborn diapers, size 0/N & 1 (qty 2)

Sample of Tubby Todd all over colloidal oatmeal ointment

Sample of Jack n Jill natural toothpaste

Samples of Palmers skin oil and stretch mark lotion

Sample of Noodle & Boo laundry detergent

Parasol disposable bibs (qty 5)

Small story teddy bear onesie, size 0-3 m

Honest company wet wipes (qty 10)

Water wipes (qty 10)

Huggies skin essentials wet wipes (qty 24)

Motif breast milk storage bag (qty 10)

COUPON - for free Dyper diapers & wipes

COUPON - for free can of Bobbie Organic Whole Milk Formula

ETA: forgot to include the sample sized Lume whole body deodorant stick!! This was the one I was most excited for because I use Lume as my whole body deodorant already. As soon as I saw it I threw it into my purse as an emergency item!`,
};

const EXTRACT_OFFER_TOOL = {
  name: 'extract_offer',
  description: 'Extract structured offer data from a post about a free product offer',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      brand: { type: 'string' },
      destination_url: { type: 'string' },
      category: {
        type: 'string',
        enum: ['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other'],
      },
      offer_type: {
        type: 'string',
        enum: ['sample', 'full_product', 'bundle', 'other'],
      },
      shipping_cost: { type: 'number', minimum: 0 },
      restrictions: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      is_excluded: { type: 'boolean' },
      exclusion_reason: { type: 'string' },
    },
    required: ['title', 'destination_url', 'confidence', 'is_excluded'],
  },
} as const;

function hr(char = '─', n = 78): string {
  return char.repeat(n);
}

function header(label: string): void {
  console.log(`\n${hr('═')}`);
  console.log(`  ${label}`);
  console.log(hr('═'));
}

function section(label: string): void {
  console.log(`\n${hr('─')}`);
  console.log(`  ${label}`);
  console.log(hr('─'));
}

async function runTier1(
  anthropic: Anthropic,
  prompt: string,
  postContent: string,
): Promise<{ raw: string; parsed: unknown; latencyMs: number }> {
  const start = Date.now();
  const response = await anthropic.messages.create({
    model: TIER1_MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
  });
  const latencyMs = Date.now() - start;

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock?.type === 'text' ? textBlock.text : '';
  const stripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = { error: 'failed to parse JSON', raw };
  }
  return { raw, parsed, latencyMs };
}

async function runTier2(
  anthropic: Anthropic,
  prompt: string,
  postContent: string,
): Promise<{ toolInput: unknown; latencyMs: number }> {
  const start = Date.now();
  const response = await anthropic.messages.create({
    model: TIER2_MODEL,
    max_tokens: 1024,
    tools: [EXTRACT_OFFER_TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'extract_offer' },
    messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
  });
  const latencyMs = Date.now() - start;

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'extract_offer',
  );
  return { toolInput: toolBlock?.input ?? null, latencyMs };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  const tier1Prompt = readFileSync(
    join(__dirname, '..', 'prompts', 'tier1-classify.md'),
    'utf-8',
  );
  const tier2Prompt = readFileSync(
    join(__dirname, '..', 'prompts', 'tier2-extract.md'),
    'utf-8',
  );

  console.log(`Free Offers Monitor — Reddit Pipeline Demo`);
  console.log(`Tier 1 model: ${TIER1_MODEL}`);
  console.log(`Tier 2 model: ${TIER2_MODEL}`);

  const post = REDDIT_POST;
  header(`POST: ${post.external_id}  (source: ${post.source})`);
  console.log(`Author:    ${post.author}`);
  console.log(`Posted at: ${post.posted_at.toISOString()}`);
  console.log(`URL:       ${post.url}`);
  console.log(`\nINPUT — Post content fed to the classifier:`);
  console.log(hr('·'));
  console.log(`Title: ${post.title}`);
  console.log(`\nBody:\n${post.body}`);
  console.log(hr('·'));

  const postContent = `Title: ${post.title}\n\nBody: ${post.body}`;

  section(`TIER 1 — Haiku binary classifier`);
  const t1 = await runTier1(anthropic, tier1Prompt, postContent);
  console.log(`Latency: ${t1.latencyMs} ms`);
  console.log(`\nRaw model response:`);
  console.log(t1.raw);
  console.log(`\nParsed:`);
  console.log(JSON.stringify(t1.parsed, null, 2));

  const decision = (t1.parsed as { decision?: string } | null)?.decision;
  if (decision !== 'pass') {
    console.log(`\n→ Tier 1 ${decision ?? 'unknown'} — pipeline stops here, no Tier 2 call.`);
    return;
  }

  section(`TIER 2 — Sonnet structured extractor (tool use)`);
  const t2 = await runTier2(anthropic, tier2Prompt, postContent);
  console.log(`Latency: ${t2.latencyMs} ms`);
  console.log(`\nExtracted offer (raw tool input from model):`);
  console.log(JSON.stringify(t2.toolInput, null, 2));

  // Run the same Zod validation the worker uses, so the demo shows what the
  // pipeline would actually store (after preprocessing "null" strings, etc.).
  const validation = OfferExtractionSchema.safeParse(t2.toolInput);
  console.log(`\nAfter OfferExtractionSchema (worker-side validation):`);
  if (validation.success) {
    console.log(JSON.stringify(validation.data, null, 2));
    if (validation.data.destination_url === null) {
      console.log(
        `\n→ destination_url is null — worker would route to human_review_queue. Admin fills URL via /dashboard/offers/<id>/edit.`,
      );
    } else if (validation.data.confidence < 0.7) {
      console.log(
        `\n→ confidence ${validation.data.confidence} < 0.7 — worker would route to human_review_queue.`,
      );
    } else {
      console.log(`\n→ Would proceed to dedup + publish.`);
    }
  } else {
    console.log(`Zod validation FAILED → worker would route to human_review_queue.`);
    console.log(JSON.stringify(validation.error.issues, null, 2));
  }

  console.log(`\n${hr('═')}`);
  console.log(`  Demo complete.`);
  console.log(hr('═'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
