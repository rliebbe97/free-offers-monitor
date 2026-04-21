import type { Metadata } from 'next';
import { createClient } from '@repo/db';
import { AiLogsTable } from '@/components/ai-logs/ai-logs-table';
import { OffersPagination } from '@/components/offers/offers-pagination';

export const metadata: Metadata = {
  title: 'AI Call Log — Free Offers Monitor',
};

const PAGE_SIZE = 25;

const ALLOWED_SORT_COLS = [
  'created_at',
  'model',
  'tier',
  'cost_usd',
  'latency_ms',
  'input_tokens',
  'output_tokens',
] as const;

type AllowedSortCol = (typeof ALLOWED_SORT_COLS)[number];

function isAllowedSortCol(col: string): col is AllowedSortCol {
  return (ALLOWED_SORT_COLS as readonly string[]).includes(col);
}

type SearchParams = Promise<{
  sort?: string;
  dir?: string;
  page?: string;
}>;

export default async function AiLogsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;

  const rawSort = params.sort ?? 'created_at';
  const sortCol: AllowedSortCol = isAllowedSortCol(rawSort) ? rawSort : 'created_at';
  const sortDir = params.dir === 'asc';
  const page = Math.max(1, Number(params.page ?? '1'));

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const db = createClient();

  const { data: calls, error, count } = await db
    .from('ai_calls')
    .select(
      'id, tier, model, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms, created_at, error',
      { count: 'exact' }
    )
    .order(sortCol, { ascending: sortDir })
    .range(from, to);

  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">AI Call Log</h1>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load AI call log. Refresh to try again.
        </div>
      )}

      {!error && (!calls || calls.length === 0) && (
        <div className="py-12 text-center space-y-2">
          <h2 className="text-base font-semibold">No calls logged</h2>
          <p className="text-sm text-muted-foreground">
            AI call logs will appear here once the worker processes posts.
          </p>
        </div>
      )}

      {!error && calls && calls.length > 0 && (
        <>
          <AiLogsTable
            calls={calls}
            currentSort={sortCol}
            currentDir={params.dir ?? 'desc'}
          />
          <OffersPagination currentPage={page} totalPages={totalPages} />
        </>
      )}
    </div>
  );
}
