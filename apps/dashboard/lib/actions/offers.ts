'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { createClient } from '@repo/db';
import { createServerClient } from '@/lib/supabase/server';

const CATEGORY_VALUES = ['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other'] as const;
const OFFER_TYPE_VALUES = ['sample', 'full_product', 'bundle', 'other'] as const;
const STATUS_VALUES = ['active', 'expired', 'unverified', 'review_pending'] as const;

type Category = (typeof CATEGORY_VALUES)[number];
type OfferType = (typeof OFFER_TYPE_VALUES)[number];
type Status = (typeof STATUS_VALUES)[number];

function asEnum<T extends readonly string[]>(
  values: T,
  raw: FormDataEntryValue | null,
): T[number] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return (values as readonly string[]).includes(raw) ? (raw as T[number]) : null;
}

function trimOrNull(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function parseRestrictions(raw: FormDataEntryValue | null): string[] | null {
  if (typeof raw !== 'string') return null;
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : null;
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function updateOffer(
  offerId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const title = trimOrNull(formData.get('title'));
  if (!title) return { error: 'Title is required' };

  const destinationUrl = trimOrNull(formData.get('destination_url'));
  if (destinationUrl !== null && !isValidUrl(destinationUrl)) {
    return { error: 'destination_url must be a valid http(s) URL' };
  }

  const description = trimOrNull(formData.get('description'));
  const brand = trimOrNull(formData.get('brand'));
  const category: Category | null = asEnum(CATEGORY_VALUES, formData.get('category'));
  const offerType: OfferType | null = asEnum(OFFER_TYPE_VALUES, formData.get('offer_type'));
  const status: Status | null = asEnum(STATUS_VALUES, formData.get('status'));
  if (!status) return { error: 'Invalid status' };

  const restrictions = parseRestrictions(formData.get('restrictions'));

  const shippingRaw = formData.get('shipping_cost');
  let shippingCost: number | null = null;
  if (typeof shippingRaw === 'string' && shippingRaw.trim() !== '') {
    const parsed = Number(shippingRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: 'shipping_cost must be a non-negative number' };
    }
    shippingCost = parsed;
  }

  // Recompute URL hash whenever a URL is present. Matches review.ts (sha256 of
  // the raw URL); a future cleanup should normalize via the worker's
  // normalizeAndHash so dashboard-set URLs dedup against ingested ones.
  const urlHash =
    destinationUrl === null
      ? null
      : createHash('sha256').update(destinationUrl).digest('hex');

  const db = createClient();
  const { error } = await db
    .from('offers')
    .update({
      title,
      destination_url: destinationUrl,
      destination_url_hash: urlHash,
      description,
      brand,
      category,
      offer_type: offerType,
      shipping_cost: shippingCost,
      restrictions,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', offerId);

  if (error) return { error: `Failed to update offer: ${error.message}` };

  revalidatePath('/dashboard/offers');
  revalidatePath(`/dashboard/offers/${offerId}/edit`);
  redirect('/dashboard/offers');
}
