import type { Metadata } from 'next';
import { createClient } from '@repo/db';
import { OffersTable } from '@/components/offers/offers-table';
import { OffersFilters } from '@/components/offers/offers-filters';
import { OffersPagination } from '@/components/offers/offers-pagination';

export const metadata: Metadata = {
  title: 'Offers — Free Offers Monitor',
};

const PAGE_SIZE = 25;

type SearchParams = Promise<{
  status?: string;
  page?: string;
  sort?: string;
}>;

export default async function OffersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;

  const status = params.status ?? 'active';
  const page = Math.max(1, Number(params.page ?? '1'));
  const sort = params.sort ?? 'newest';

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const db = createClient();

  let query = db
    .from('offers')
    .select('id, title, status, destination_url, extraction_confidence, created_at', {
      count: 'exact',
    });

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  if (sort === 'oldest') {
    query = query.order('created_at', { ascending: true });
  } else if (sort === 'confidence') {
    query = query.order('extraction_confidence', { ascending: false, nullsFirst: false });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  query = query.range(from, to);

  const { data: offers, error, count } = await query;

  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Offers</h1>

      <OffersFilters status={status} sort={sort} />

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load offers. Refresh the page to try again.
        </div>
      )}

      {!error && (!offers || offers.length === 0) && (
        <div className="py-12 text-center space-y-2">
          <h2 className="text-base font-semibold">No offers found</h2>
          <p className="text-sm text-muted-foreground">
            {status === 'active'
              ? 'No active offers yet. The pipeline will populate this list as offers are processed.'
              : 'No offers match the current filters. Try changing the status filter.'}
          </p>
        </div>
      )}

      {!error && offers && offers.length > 0 && (
        <>
          <OffersTable offers={offers} />
          <OffersPagination currentPage={page} totalPages={totalPages} />
        </>
      )}
    </div>
  );
}
