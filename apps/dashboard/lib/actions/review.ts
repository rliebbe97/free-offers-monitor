'use server';

import { revalidatePath } from 'next/cache';
import { createHash } from 'node:crypto';
import { createClient } from '@repo/db';
import type { Json } from '@repo/db';
import { createServerClient } from '@/lib/supabase/server';

export async function approveReviewItem(id: string): Promise<{ error?: string }> {
  // Re-verify session independently — proxy is NOT a security boundary for server actions
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const db = createClient();

  const { data: item, error: fetchError } = await db
    .from('human_review_queue')
    .select('post_id, tier2_result, confidence')
    .eq('id', id)
    .single();

  if (fetchError || !item) return { error: 'Review item not found' };

  const t2 = item.tier2_result as Record<string, Json>;
  const destinationUrl = String(t2['destination_url'] ?? '');
  const title = String(t2['title'] ?? '');

  // Recompute URL hash server-side — never trust client data
  const urlHash = createHash('sha256').update(destinationUrl).digest('hex');

  const { data: newOffer, error: insertError } = await db
    .from('offers')
    .insert({
      destination_url: destinationUrl,
      destination_url_hash: urlHash,
      title: title,
      description: t2['description'] ? String(t2['description']) : null,
      brand: t2['brand'] ? String(t2['brand']) : null,
      category: t2['category'] ? String(t2['category']) : null,
      offer_type: t2['offer_type'] ? String(t2['offer_type']) : null,
      shipping_cost: t2['shipping_cost'] != null ? Number(t2['shipping_cost']) : null,
      restrictions: Array.isArray(t2['restrictions']) ? (t2['restrictions'] as string[]) : null,
      extraction_confidence: item.confidence,
      status: 'active',
    })
    .select('id')
    .single();

  if (insertError || !newOffer) return { error: 'Failed to create offer' };

  await db
    .from('post_offers')
    .insert({ post_id: item.post_id, offer_id: newOffer.id });

  const { error: updateError } = await db
    .from('human_review_queue')
    .update({
      decision: 'approved',
      reviewer_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) return { error: 'Failed to update review item' };

  revalidatePath('/dashboard/review');
  revalidatePath('/dashboard/offers');

  return {};
}

export async function rejectReviewItem(id: string): Promise<{ error?: string }> {
  // Re-verify session independently — proxy is NOT a security boundary for server actions
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const db = createClient();

  const { data: item, error: fetchError } = await db
    .from('human_review_queue')
    .select('post_id, tier2_result, confidence')
    .eq('id', id)
    .single();

  if (fetchError || !item) return { error: 'Review item not found' };

  const t2 = item.tier2_result as Record<string, Json>;
  const destinationUrl = String(t2['destination_url'] ?? '');
  const title = String(t2['title'] ?? '');

  // Recompute URL hash server-side — never trust client data
  const urlHash = createHash('sha256').update(destinationUrl).digest('hex');

  const { data: newOffer, error: insertError } = await db
    .from('offers')
    .insert({
      destination_url: destinationUrl,
      destination_url_hash: urlHash,
      title: title,
      description: t2['description'] ? String(t2['description']) : null,
      brand: t2['brand'] ? String(t2['brand']) : null,
      category: t2['category'] ? String(t2['category']) : null,
      offer_type: t2['offer_type'] ? String(t2['offer_type']) : null,
      shipping_cost: t2['shipping_cost'] != null ? Number(t2['shipping_cost']) : null,
      restrictions: Array.isArray(t2['restrictions']) ? (t2['restrictions'] as string[]) : null,
      extraction_confidence: item.confidence,
      status: 'expired',
    })
    .select('id')
    .single();

  if (insertError || !newOffer) return { error: 'Failed to create offer' };

  await db
    .from('post_offers')
    .insert({ post_id: item.post_id, offer_id: newOffer.id });

  const { error: updateError } = await db
    .from('human_review_queue')
    .update({
      decision: 'rejected',
      reviewer_id: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) return { error: 'Failed to reject item' };

  revalidatePath('/dashboard/review');
  revalidatePath('/dashboard/offers');

  return {};
}
