import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Standalone demo — runs a small set of labeled posts through Tier 1 (Haiku) and,
// when Tier 1 passes, Tier 2 (Sonnet w/ tool use). Prints input + raw output for
// each call so a non-engineer can see what the pipeline does end to end.
//
// Like run-eval.ts, this script bypasses the worker pipeline and does NOT log
// to the ai_calls table. It is dev-time only.

// NOTE: Using current available model IDs. The IDs pinned in apps/worker/src/config.ts
// (claude-haiku-4-20250514 / claude-sonnet-4-5-20250514) return 404 from the Anthropic API
// — they appear to be stale or never-released aliases. This demo overrides with real IDs.
const TIER1_MODEL = process.env.DEMO_TIER1_MODEL ?? 'claude-haiku-4-5-20251001';
const TIER2_MODEL = process.env.DEMO_TIER2_MODEL ?? 'claude-sonnet-4-6';

const DEMO_IDS = [
  'thebump-10234567', // clear pass — free diaper samples
  'thebump-10701245', // reject — coupon (50% off)
  'thebump-10789034', // reject — free trial subscription
  'thebump-10512034', // pass — breast pump via insurance
];

interface LabeledPost {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string;
  label: 'pass' | 'reject';
  label_reason: string;
}

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

  // Strip ```json ... ``` fences if the model added them despite the prompt.
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

  const posts: LabeledPost[] = JSON.parse(
    readFileSync(join(__dirname, 'labeled-posts.json'), 'utf-8'),
  );
  const tier1Prompt = readFileSync(
    join(__dirname, '..', 'prompts', 'tier1-classify.md'),
    'utf-8',
  );
  const tier2Prompt = readFileSync(
    join(__dirname, '..', 'prompts', 'tier2-extract.md'),
    'utf-8',
  );

  const selected = DEMO_IDS.map((id) => posts.find((p) => p.id === id)).filter(
    (p): p is LabeledPost => Boolean(p),
  );

  if (selected.length === 0) {
    console.error('ERROR: No demo posts found. Check DEMO_IDS against labeled-posts.json.');
    process.exit(1);
  }

  console.log(`Free Offers Monitor — Pipeline Demo`);
  console.log(`Tier 1 model: ${TIER1_MODEL}`);
  console.log(`Tier 2 model: ${TIER2_MODEL}`);
  console.log(`Posts: ${selected.length}`);

  for (const post of selected) {
    header(`POST: ${post.id}  (human label: ${post.label.toUpperCase()})`);
    console.log(`Source: ${post.source}`);
    console.log(`URL:    ${post.url}`);
    console.log(`\nINPUT — Post content fed to the classifier:`);
    console.log(hr('·'));
    console.log(`Title: ${post.title}`);
    console.log(`\nBody:  ${post.body}`);
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
      continue;
    }

    section(`TIER 2 — Sonnet structured extractor (tool use)`);
    const t2 = await runTier2(anthropic, tier2Prompt, postContent);
    console.log(`Latency: ${t2.latencyMs} ms`);
    console.log(`\nExtracted offer (tool input from model):`);
    console.log(JSON.stringify(t2.toolInput, null, 2));
  }

  console.log(`\n${hr('═')}`);
  console.log(`  Demo complete.`);
  console.log(hr('═'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
