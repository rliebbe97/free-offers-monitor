import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// NOTE: ai_calls logging exemption — this eval script is a dev-time-only tool
// that runs outside the production worker pipeline. No DB connection exists here.
// CLAUDE.md's "Every Tier 1/2 call MUST log to ai_calls table" applies to the
// worker pipeline only, not standalone eval scripts.

// NOTE: Tier 2 eval execution deferred to Phase 6 — the tier2_expected field is
// populated in labeled-posts.json now (ROADMAP SC#3 compliance), but run-eval.ts
// only executes Tier 1 classification in this phase. Phase 6 will extend the eval
// runner to invoke Tier 2 extraction on entries where label === 'pass' and compare
// against tier2_expected. The labeled data is ready; only the execution code is deferred.

interface Tier2Expected {
  is_valid_offer: boolean;
  item: string;
  shipping_cost?: string;
}

interface LabeledPost {
  id: string;
  source: string;
  cross_source_pair_id?: string;
  url: string;
  external_id: string;
  title: string;
  body: string;
  author: string;
  posted_at: string;
  label: 'pass' | 'reject';
  tier2_expected: Tier2Expected | null;
  label_reason: string;
  notes?: string;
}

interface Tier1Response {
  decision: 'pass' | 'reject';
  confidence: number;
  reason: string;
}

const PASS_THRESHOLD = 0.7; // minimum accuracy to exit 0
const MODEL = 'claude-haiku-4-20250514'; // matches TIER1_MODEL in config.ts

async function main(): Promise<void> {
  const posts: LabeledPost[] = JSON.parse(
    readFileSync(join(__dirname, 'labeled-posts.json'), 'utf-8'),
  );
  const prompt = readFileSync(
    join(__dirname, '..', 'prompts', 'tier1-classify.md'),
    'utf-8',
  );

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  let correct = 0;
  let total = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  console.log(`Running Tier 1 eval on ${posts.length} posts with model ${MODEL}\n`);
  console.log('ID                      | Expected | Predicted | Confidence | Match');
  console.log('------------------------|----------|-----------|------------|------');

  for (const post of posts) {
    const postContent = `Title: ${post.title}\n\nBody: ${post.body}`;

    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: `${prompt}\n\n${postContent}` }],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      const rawText = textBlock?.type === 'text' ? textBlock.text : '';

      let parsed: Tier1Response;
      try {
        parsed = JSON.parse(rawText) as Tier1Response;
      } catch {
        console.error(`  PARSE ERROR for ${post.id}: ${rawText.slice(0, 100)}`);
        total++;
        continue;
      }

      const match = parsed.decision === post.label;
      if (match) correct++;

      // Confusion matrix
      if (parsed.decision === 'pass' && post.label === 'pass') truePositives++;
      if (parsed.decision === 'pass' && post.label === 'reject') falsePositives++;
      if (parsed.decision === 'reject' && post.label === 'reject') trueNegatives++;
      if (parsed.decision === 'reject' && post.label === 'pass') falseNegatives++;

      const paddedId = post.id.padEnd(24);
      console.log(
        `${paddedId}| ${post.label.padEnd(9)}| ${parsed.decision.padEnd(10)}| ${parsed.confidence.toFixed(2).padEnd(11)}| ${match ? 'OK' : 'MISS'}`,
      );

      total++;
    } catch (err) {
      console.error(`  API ERROR for ${post.id}: ${String(err)}`);
      total++;
    }
  }

  // Summary statistics
  const accuracy = total > 0 ? correct / total : 0;
  const precision =
    truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 0;
  const recall =
    truePositives + falseNegatives > 0
      ? truePositives / (truePositives + falseNegatives)
      : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  console.log('\n--- Summary ---');
  console.log(`Total:       ${total}`);
  console.log(`Correct:     ${correct}`);
  console.log(`Accuracy:    ${accuracy.toFixed(2)}`);
  console.log(`Precision:   ${precision.toFixed(2)}`);
  console.log(`Recall:      ${recall.toFixed(2)}`);
  console.log(`F1:          ${f1.toFixed(2)}`);
  console.log(`Threshold:   ${PASS_THRESHOLD}`);
  console.log('\nConfusion Matrix:');
  console.log(`  TP=${truePositives}  FP=${falsePositives}`);
  console.log(`  FN=${falseNegatives}  TN=${trueNegatives}`);

  if (accuracy < PASS_THRESHOLD) {
    console.error(`\nFAIL: accuracy ${accuracy.toFixed(2)} below threshold ${PASS_THRESHOLD}`);
    process.exit(1);
  }

  console.log(`\nPASS: accuracy ${accuracy.toFixed(2)} meets threshold ${PASS_THRESHOLD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
