import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// NOTE: ai_calls logging exemption — this eval script is a dev-time-only tool
// that runs outside the production worker pipeline. No DB connection exists here.
// CLAUDE.md's "Every Tier 1/2 call MUST log to ai_calls table" applies to the
// worker pipeline only, not standalone eval scripts.

// NOTE: Tier 2 eval execution deferred — the tier2_expected field is populated in
// labeled-posts.json but run-eval.ts only executes Tier 1 classification and dedup
// cosine validation. A future phase will extend the eval runner to invoke Tier 2
// extraction on entries where label === 'pass' and compare against tier2_expected.

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
const MODEL = 'claude-haiku-4-5-20251001'; // matches TIER1_MODEL in config.ts

/**
 * Compute cosine similarity between two vectors.
 * Voyage embeddings are NOT pre-normalized, so full normalization is required.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embed text using the Voyage AI API (same pattern as embedding-dedup.ts).
 * Returns a 1024-dimensional vector.
 */
async function embedTextForEval(text: string, voyageKey: string): Promise<number[]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${voyageKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model: 'voyage-2' }),
  });

  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = data.data[0]?.embedding;

  if (!embedding || embedding.length !== 1024) {
    throw new Error(`Expected 1024-dim embedding, got: ${embedding?.length ?? 'null'}`);
  }

  return embedding;
}

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

      // Newer Haiku versions sometimes wrap JSON in ```json fences despite the prompt
      // forbidding it. Strip them before parsing so we don't false-flag PARSE ERROR.
      const cleaned = rawText
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      let parsed: Tier1Response;
      try {
        parsed = JSON.parse(cleaned) as Tier1Response;
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

  // --- Dedup Cosine Score Validation ---
  // Inline threshold — cannot import from config.ts due to getEnvOrThrow side effects at module load
  const DEDUP_THRESHOLD = 0.85; // mirrors EMBEDDING_SIMILARITY_THRESHOLD in apps/worker/src/config.ts

  // Group entries by cross_source_pair_id
  const pairMap = new Map<string, LabeledPost[]>();
  for (const post of posts) {
    if (post.cross_source_pair_id) {
      const existing = pairMap.get(post.cross_source_pair_id) ?? [];
      existing.push(post);
      pairMap.set(post.cross_source_pair_id, existing);
    }
  }

  // Filter to pairs with exactly 2 members
  const validPairs = Array.from(pairMap.entries()).filter(([, members]) => members.length === 2);

  if (validPairs.length > 0) {
    const voyageKey = process.env.VOYAGE_API_KEY;
    if (!voyageKey) {
      console.warn('\nSKIP: Dedup cosine validation — VOYAGE_API_KEY not set');
    } else {
      console.log(`\n--- Dedup Cosine Score Validation (${validPairs.length} pairs) ---\n`);
      console.log('Pair ID    | Source A   | Source B   | Cosine   | Threshold | Result');
      console.log('-----------|-----------|-----------|----------|-----------|-------');

      let pairsAbove = 0;
      let pairsBelow = 0;

      for (const [pairId, members] of validPairs) {
        const [a, b] = members as [LabeledPost, LabeledPost];
        const textA = `${a.title ?? ''} ${a.body ?? ''}`;
        const textB = `${b.title ?? ''} ${b.body ?? ''}`;

        try {
          const embeddingA = await embedTextForEval(textA, voyageKey);
          const embeddingB = await embedTextForEval(textB, voyageKey);
          const cosine = cosineSimilarity(embeddingA, embeddingB);

          const above = cosine >= DEDUP_THRESHOLD;
          if (above) pairsAbove++;
          else pairsBelow++;

          const paddedPairId = pairId.padEnd(11);
          const paddedSourceA = a.source.padEnd(10);
          const paddedSourceB = b.source.padEnd(10);
          console.log(
            `${paddedPairId}| ${paddedSourceA}| ${paddedSourceB}| ${cosine.toFixed(4).padEnd(9)}| ${DEDUP_THRESHOLD.toFixed(2).padEnd(10)}| ${above ? 'ABOVE' : 'BELOW'}`,
          );
        } catch (err) {
          console.error(`  VOYAGE ERROR for ${pairId}: ${String(err)}`);
        }
      }

      console.log('\n--- Dedup Summary ---');
      console.log(`Total pairs:     ${validPairs.length}`);
      console.log(`Above threshold: ${pairsAbove}`);
      console.log(`Below threshold: ${pairsBelow}`);
      console.log(`Threshold:       ${DEDUP_THRESHOLD}`);

      if (pairsBelow > 0) {
        console.warn(
          `\nWARN: ${pairsBelow} cross-source pair(s) scored below ${DEDUP_THRESHOLD} — ` +
          'consider lowering EMBEDDING_SIMILARITY_THRESHOLD in config.ts',
        );
      }
    }
  }

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
