'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateOffer } from '@/lib/actions/offers';

const CATEGORIES = ['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other'] as const;
const OFFER_TYPES = ['sample', 'full_product', 'bundle', 'other'] as const;
const STATUSES = ['active', 'expired', 'unverified', 'review_pending'] as const;

type OfferDefaults = {
  id: string;
  title: string;
  destination_url: string | null;
  description: string | null;
  brand: string | null;
  category: string | null;
  offer_type: string | null;
  shipping_cost: number | null;
  restrictions: string[] | null;
  status: string;
};

type Props = {
  offer: OfferDefaults;
};

export function OfferEditForm({ offer }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await updateOffer(offer.id, formData);
      // updateOffer redirects on success — we only get here on error
      if (result?.error) toast.error(result.error);
    });
  }

  return (
    <form action={handleSubmit} className="space-y-5 max-w-2xl">
      <div className="space-y-1.5">
        <Label htmlFor="title">Title *</Label>
        <Input id="title" name="title" defaultValue={offer.title} required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="destination_url">Destination URL</Label>
        <Input
          id="destination_url"
          name="destination_url"
          type="url"
          defaultValue={offer.destination_url ?? ''}
          placeholder="https://example.com/free-sample"
        />
        {offer.destination_url === null && (
          <p className="text-xs text-amber-600">
            No URL on file. Tier 2 didn&apos;t find one in the post — please hunt for the claim
            link and paste it here.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brand">Brand</Label>
        <Input id="brand" name="brand" defaultValue={offer.brand ?? ''} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            name="category"
            defaultValue={offer.category ?? ''}
            className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="">—</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="offer_type">Offer type</Label>
          <select
            id="offer_type"
            name="offer_type"
            defaultValue={offer.offer_type ?? ''}
            className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="">—</option>
            {OFFER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="shipping_cost">Shipping cost (USD)</Label>
          <Input
            id="shipping_cost"
            name="shipping_cost"
            type="number"
            min="0"
            step="0.01"
            defaultValue={offer.shipping_cost ?? ''}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="status">Status *</Label>
          <select
            id="status"
            name="status"
            defaultValue={offer.status}
            className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm"
            required
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          name="description"
          defaultValue={offer.description ?? ''}
          rows={4}
          className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="restrictions">Restrictions (one per line)</Label>
        <textarea
          id="restrictions"
          name="restrictions"
          defaultValue={offer.restrictions?.join('\n') ?? ''}
          rows={3}
          className="border-input bg-transparent w-full rounded-md border px-3 py-2 text-sm font-mono"
          placeholder={'US only\nWhile supplies last'}
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? <Loader2 size={14} className="animate-spin" /> : null}
          Save changes
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => router.back()}
        >
          Cancel
        </Button>
        <Link
          href="/dashboard/offers"
          className="text-xs text-muted-foreground hover:underline ml-auto"
        >
          Back to offers
        </Link>
      </div>
    </form>
  );
}
