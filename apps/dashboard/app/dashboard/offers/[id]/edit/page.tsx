import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createClient } from '@repo/db';
import { OfferEditForm } from '@/components/offers/offer-edit-form';

export const metadata: Metadata = {
  title: 'Edit Offer — Free Offers Monitor',
};

type PageParams = Promise<{ id: string }>;

export default async function EditOfferPage({ params }: { params: PageParams }) {
  const { id } = await params;

  const db = createClient();
  const { data: offer, error } = await db
    .from('offers')
    .select(
      'id, title, destination_url, description, brand, category, offer_type, shipping_cost, restrictions, status',
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Edit Offer</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load offer: {error.message}
        </div>
      </div>
    );
  }

  if (!offer) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Edit Offer</h1>
        <p className="text-xs text-muted-foreground font-mono">{offer.id}</p>
      </div>
      <OfferEditForm offer={offer} />
    </div>
  );
}
