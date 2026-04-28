import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createClient } from '@repo/db';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prefer dashboard's .env.local — it has the full SUPABASE_URL.
// (The root .env.local stores only the project ref, which fails URL validation.)
const dashboardEnv = join(__dirname, '..', 'apps', 'dashboard', '.env.local');
const rootEnv = join(__dirname, '..', '.env.local');
if (existsSync(dashboardEnv)) {
  process.loadEnvFile(dashboardEnv);
} else if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

// Synthetic dashboard seed — inserts a believable cross-section of demo data
// into the hosted Supabase instance so the dashboard pages have something to
// render. Pure fixtures: no Anthropic calls, no Voyage embeddings. Idempotent.
//
// Wipes and re-inserts everything tied to the two demo source identifiers
// below, so it is safe to re-run. It does NOT touch real worker-produced data.

const TIER1_MODEL = 'claude-haiku-4-5-20251001';
const TIER2_MODEL = 'claude-sonnet-4-6';
const PROMPT_VERSION = 'demo-seed-v1';

const DEMO_SOURCES = [
  { type: 'discourse', identifier: 'demo-thebump' },
  { type: 'reddit', identifier: 'demo-reddit' },
] as const;

const SOURCE_KEY_BY_LABEL: Record<string, string> = {
  thebump: 'demo-thebump',
  reddit: 'demo-reddit',
};

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
  label_reason: string;
  tier2_expected: { is_valid_offer?: boolean; item?: string; shipping_cost?: string } | null;
}

// Per-pair offer details. The first post we encounter for each pair becomes the
// canonical offer; later posts in the same pair link to that offer with a
// pipeline_status of 'dedup_matched'.
interface PairOfferTemplate {
  title: string;
  description: string;
  brand: string | null;
  category: string;
  offer_type: string;
  shipping_cost: number;
  restrictions: string[];
  destination_url: string;
  confidence: number;
  status: 'active' | 'unverified' | 'review_pending' | 'expired';
  validated: boolean;
  daysAgoCreated: number;
}

const PAIR_TEMPLATES: Record<string, PairOfferTemplate> = {
  'pair-001': {
    title: 'Free Pampers newborn diaper samples',
    description:
      'Pampers ships a free pack of newborn and size 1 diaper samples after a short signup form. No payment, no shipping cost.',
    brand: 'Pampers',
    category: 'diapers',
    offer_type: 'sample',
    shipping_cost: 0,
    restrictions: ['one per household', 'US residents only'],
    destination_url: 'https://www.pampers.com/en-us/rewards/free-samples',
    confidence: 0.93,
    status: 'active',
    validated: true,
    daysAgoCreated: 28,
  },
  'pair-002': {
    title: 'Similac StrongMoms free formula sample box',
    description:
      'Similac sends a multi-can formula sample box to expecting and new parents enrolled in the StrongMoms program. Free shipping.',
    brand: 'Similac',
    category: 'formula',
    offer_type: 'sample',
    shipping_cost: 0,
    restrictions: ['expecting or new parents', 'US residents only'],
    destination_url: 'https://similac.com/baby-product-samples.html',
    confidence: 0.89,
    status: 'active',
    validated: true,
    daysAgoCreated: 19,
  },
  'pair-003': {
    title: 'Hospital baby welcome bag (Pampers / Similac partnership)',
    description:
      'Many hospitals partnered with Pampers or Similac give discharged parents a free welcome bag with diapers, wipes, a onesie, formula sample, and nipple cream.',
    brand: null,
    category: 'baby_gear',
    offer_type: 'bundle',
    shipping_cost: 0,
    restrictions: ['available only at participating hospitals'],
    destination_url: 'https://www.pampers.com/en-us/hospital-program',
    confidence: 0.78,
    status: 'unverified',
    validated: false,
    daysAgoCreated: 12,
  },
  'pair-004': {
    title: 'Free breast pump through insurance (Spectra S2 via Aeroflow)',
    description:
      'Aeroflow Breastpumps verifies ACA insurance coverage and ships a Spectra S2 (or comparable model) at zero out-of-pocket cost, including shipping.',
    brand: 'Spectra',
    category: 'baby_gear',
    offer_type: 'full_product',
    shipping_cost: 0,
    restrictions: ['requires US insurance with ACA breast pump coverage'],
    destination_url: 'https://aeroflowbreastpumps.com/qualify-through-insurance',
    confidence: 0.95,
    status: 'active',
    validated: true,
    daysAgoCreated: 9,
  },
  'pair-005': {
    title: 'Gerber free baby food sample pack',
    description:
      'Gerber mails a small sample pack of puree pouches and a single jar after signing up via their site. Shipping covered, no payment.',
    brand: 'Gerber',
    category: 'food',
    offer_type: 'sample',
    shipping_cost: 0,
    restrictions: [],
    destination_url: 'https://www.gerber.com/free-samples',
    confidence: 0.66,
    status: 'review_pending',
    validated: false,
    daysAgoCreated: 4,
  },
};

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function jitter(min: number, max: number, seed: number): number {
  // Deterministic pseudo-random in [min, max) keyed on seed so reseeds match.
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const r = x - Math.floor(x);
  return min + r * (max - min);
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - days * 24);
  return d.toISOString();
}

function tier1CostUsd(inputTokens: number, outputTokens: number): number {
  return inputTokens * (1.0 / 1_000_000) + outputTokens * (5.0 / 1_000_000);
}

function tier2CostUsd(inputTokens: number, outputTokens: number): number {
  return inputTokens * (3.0 / 1_000_000) + outputTokens * (15.0 / 1_000_000);
}

async function main(): Promise<void> {
  const db = createClient();

  const posts: LabeledPost[] = JSON.parse(
    readFileSync(join(__dirname, 'labeled-posts.json'), 'utf-8'),
  );

  console.log(`Seeding dashboard from ${posts.length} labeled posts…`);

  // ---------- 1. Sources (upsert) ----------
  const sourceIdByIdentifier = new Map<string, string>();
  for (const src of DEMO_SOURCES) {
    const { data: existing, error: selErr } = await db
      .from('sources')
      .select('id')
      .eq('identifier', src.identifier)
      .maybeSingle();
    if (selErr) throw new Error(`source select failed: ${selErr.message}`);

    if (existing) {
      sourceIdByIdentifier.set(src.identifier, existing.id);
    } else {
      const { data: inserted, error: insErr } = await db
        .from('sources')
        .insert({ type: src.type, identifier: src.identifier, config: {} })
        .select('id')
        .single();
      if (insErr) throw new Error(`source insert failed: ${insErr.message}`);
      sourceIdByIdentifier.set(src.identifier, inserted.id);
    }
  }
  const sourceIds = Array.from(sourceIdByIdentifier.values());
  console.log(`  sources ready: ${sourceIds.length}`);

  // ---------- 2. Wipe prior demo data tied to demo sources ----------
  // Order matters: ai_calls + post_offers + human_review_queue + verification_log
  // first, then offers and posts.
  const { data: priorPosts } = await db
    .from('posts')
    .select('id')
    .in('source_id', sourceIds);
  const priorPostIds = (priorPosts ?? []).map((p) => p.id);

  const { data: priorOfferLinks } = await db
    .from('post_offers')
    .select('offer_id')
    .in('post_id', priorPostIds.length ? priorPostIds : ['00000000-0000-0000-0000-000000000000']);
  const priorOfferIds = Array.from(
    new Set((priorOfferLinks ?? []).map((l) => l.offer_id)),
  );

  if (priorPostIds.length > 0) {
    await db.from('ai_calls').delete().in('post_id', priorPostIds);
    await db.from('human_review_queue').delete().in('post_id', priorPostIds);
    await db.from('post_offers').delete().in('post_id', priorPostIds);
  }
  if (priorOfferIds.length > 0) {
    await db.from('verification_log').delete().in('offer_id', priorOfferIds);
    await db.from('offers').delete().in('id', priorOfferIds);
  }
  if (priorPostIds.length > 0) {
    await db.from('posts').delete().in('id', priorPostIds);
  }
  console.log(
    `  wiped prior demo rows: ${priorPostIds.length} posts, ${priorOfferIds.length} offers`,
  );

  // ---------- 3. Insert posts + ai_calls + offers + reviews ----------
  const offerIdByPair = new Map<string, string>();
  let tier1Calls = 0;
  let tier2Calls = 0;
  let offersInserted = 0;
  let postOffersInserted = 0;
  let reviewQueueInserted = 0;
  let postsInserted = 0;

  // Sort so each cross_source_pair_id's first post is the canonical/winner.
  const ordered = [...posts].sort((a, b) =>
    a.posted_at < b.posted_at ? -1 : a.posted_at > b.posted_at ? 1 : 0,
  );

  for (let i = 0; i < ordered.length; i++) {
    const post = ordered[i];
    const sourceKey = SOURCE_KEY_BY_LABEL[post.source];
    if (!sourceKey) {
      console.warn(`  skipping ${post.id} (unknown source: ${post.source})`);
      continue;
    }
    const sourceId = sourceIdByIdentifier.get(sourceKey);
    if (!sourceId) throw new Error(`missing source id for ${sourceKey}`);

    const pair = post.cross_source_pair_id;
    const template = pair ? PAIR_TEMPLATES[pair] : undefined;

    const isPass = post.label === 'pass';
    const isFirstInPair = pair ? !offerIdByPair.has(pair) : true;
    const isDedupMatch = isPass && pair !== undefined && !isFirstInPair;
    const isCanonical = isPass && isFirstInPair;

    const tier1Decision = isPass ? 'pass' : 'reject';
    const tier1Confidence = isPass
      ? 0.85 + jitter(0, 0.12, i + 1)
      : 0.7 + jitter(0, 0.25, i + 1);
    const tier1Reason = isPass
      ? 'Mentions a free physical product mailed at no cost.'
      : post.label_reason;

    const tier1Result = {
      decision: tier1Decision,
      confidence: Number(tier1Confidence.toFixed(2)),
      reason: tier1Reason,
      prompt_version: PROMPT_VERSION,
    };

    const tier2Result =
      isPass && template
        ? {
            title: template.title,
            description: template.description,
            brand: template.brand,
            destination_url: template.destination_url,
            category: template.category,
            offer_type: template.offer_type,
            shipping_cost: template.shipping_cost,
            restrictions: template.restrictions,
            confidence: template.confidence,
            is_excluded: false,
          }
        : null;

    const pipelineStatus = !isPass
      ? 'tier1_rejected'
      : isDedupMatch
      ? 'dedup_matched'
      : template?.status === 'review_pending'
      ? 'review_queued'
      : 'published';

    const postCreatedAt = daysAgo(template?.daysAgoCreated ?? 25 - i);

    // Insert post
    const { data: postRow, error: postErr } = await db
      .from('posts')
      .insert({
        source_id: sourceId,
        external_id: post.external_id,
        url: post.url,
        title: post.title,
        body: post.body,
        author: post.author,
        posted_at: post.posted_at,
        tier0_passed: true,
        tier1_result: tier1Result,
        tier2_result: tier2Result,
        pipeline_status: pipelineStatus,
        created_at: postCreatedAt,
      })
      .select('id')
      .single();
    if (postErr) throw new Error(`post insert failed for ${post.id}: ${postErr.message}`);
    const postId = postRow.id;
    postsInserted++;

    // Tier 1 ai_calls row (every post gets a Tier 1 call)
    {
      const inputTokens = 280 + Math.floor(jitter(0, 80, i * 7 + 1));
      const outputTokens = 80 + Math.floor(jitter(0, 60, i * 7 + 2));
      const latency = Math.floor(700 + jitter(0, 900, i * 7 + 3));
      const callCreatedAt = new Date(
        new Date(postCreatedAt).getTime() + 1000 * 60 * 5,
      ).toISOString();
      const { error: aiErr } = await db.from('ai_calls').insert({
        post_id: postId,
        tier: 1,
        model: TIER1_MODEL,
        prompt_version: PROMPT_VERSION,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: Number(tier1CostUsd(inputTokens, outputTokens).toFixed(6)),
        latency_ms: latency,
        request_payload: { messages: [{ role: 'user', truncated: true }] },
        response_payload: tier1Result,
        created_at: callCreatedAt,
      });
      if (aiErr) throw new Error(`tier1 ai_calls insert failed: ${aiErr.message}`);
      tier1Calls++;
    }

    if (!isPass) continue;

    // Tier 2 ai_calls row (passes only — even dedup_matched gets a Tier 2 call,
    // because in the real pipeline extraction runs before dedup)
    {
      const inputTokens = 580 + Math.floor(jitter(0, 180, i * 11 + 1));
      const outputTokens = 220 + Math.floor(jitter(0, 140, i * 11 + 2));
      const latency = Math.floor(1800 + jitter(0, 2200, i * 11 + 3));
      const callCreatedAt = new Date(
        new Date(postCreatedAt).getTime() + 1000 * 60 * 7,
      ).toISOString();
      const { error: aiErr } = await db.from('ai_calls').insert({
        post_id: postId,
        tier: 2,
        model: TIER2_MODEL,
        prompt_version: PROMPT_VERSION,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: Number(tier2CostUsd(inputTokens, outputTokens).toFixed(6)),
        latency_ms: latency,
        request_payload: { messages: [{ role: 'user', truncated: true }] },
        response_payload: { tool_use: { name: 'extract_offer', input: tier2Result } },
        created_at: callCreatedAt,
      });
      if (aiErr) throw new Error(`tier2 ai_calls insert failed: ${aiErr.message}`);
      tier2Calls++;
    }

    // Offer creation (canonical only) or post_offers link to existing (dedup match)
    let offerId: string;
    if (isCanonical && template) {
      const urlHash = sha256(template.destination_url);
      const offerCreatedAt = postCreatedAt;
      const { data: offerRow, error: offerErr } = await db
        .from('offers')
        .insert({
          destination_url: template.destination_url,
          destination_url_hash: urlHash,
          title: template.title,
          description: template.description,
          brand: template.brand,
          category: template.category,
          offer_type: template.offer_type,
          shipping_cost: template.shipping_cost,
          restrictions: template.restrictions,
          status: template.status,
          extraction_confidence: template.confidence,
          last_verified_at: template.validated
            ? daysAgo(Math.max(0, template.daysAgoCreated - 1))
            : null,
          next_check_at: daysAgo(template.daysAgoCreated - 7),
          created_at: offerCreatedAt,
          updated_at: offerCreatedAt,
        })
        .select('id')
        .single();
      if (offerErr) throw new Error(`offer insert failed: ${offerErr.message}`);
      offerId = offerRow.id;
      offersInserted++;
      if (pair) offerIdByPair.set(pair, offerId);

      // Verification log row for validated offers
      if (template.validated) {
        const { error: vErr } = await db.from('verification_log').insert({
          offer_id: offerId,
          checked_at: daysAgo(Math.max(0, template.daysAgoCreated - 1)),
          http_status: 200,
          is_live: true,
          dead_signals: [],
          raw_response: 'Page reachable, no expiry signals detected (seed).',
        });
        if (vErr) throw new Error(`verification_log insert failed: ${vErr.message}`);
      }

      // Low-confidence offers go to human_review_queue
      if (template.status === 'review_pending') {
        const { error: rqErr } = await db.from('human_review_queue').insert({
          post_id: postId,
          tier2_result: tier2Result,
          confidence: template.confidence,
          created_at: offerCreatedAt,
        });
        if (rqErr) throw new Error(`human_review_queue insert failed: ${rqErr.message}`);
        reviewQueueInserted++;
      }
    } else if (pair && offerIdByPair.has(pair)) {
      offerId = offerIdByPair.get(pair)!;
    } else {
      // Pass post with no template / no pair — skip offer creation
      continue;
    }

    // post_offers link (canonical and dedup_matched both link to the offer)
    const { error: linkErr } = await db.from('post_offers').insert({
      post_id: postId,
      offer_id: offerId,
    });
    if (linkErr) throw new Error(`post_offers insert failed: ${linkErr.message}`);
    postOffersInserted++;
  }

  console.log('');
  console.log('Seed complete:');
  console.log(`  posts:               ${postsInserted}`);
  console.log(`  offers:              ${offersInserted}`);
  console.log(`  post_offers links:   ${postOffersInserted}`);
  console.log(`  human_review_queue:  ${reviewQueueInserted}`);
  console.log(`  ai_calls (tier 1):   ${tier1Calls}`);
  console.log(`  ai_calls (tier 2):   ${tier2Calls}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
