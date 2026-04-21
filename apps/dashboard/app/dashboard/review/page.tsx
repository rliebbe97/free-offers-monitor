import type { Metadata } from 'next';
import { createClient } from '@repo/db';
import { ReviewTable } from '@/components/review/review-table';

export const metadata: Metadata = {
  title: 'Review Queue — Free Offers Monitor',
};

export default async function ReviewPage() {
  const db = createClient();

  const { data, error } = await db
    .from('human_review_queue')
    .select(
      `
      id,
      post_id,
      tier2_result,
      confidence,
      created_at,
      posts!inner(url, title, tier1_result)
    `
    )
    .is('decision', null)
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Review Queue</h1>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load review queue. Refresh to try again.
        </div>
      )}

      {!error && (!data || data.length === 0) && (
        <div className="py-12 text-center space-y-2">
          <h2 className="text-base font-semibold">Queue is empty</h2>
          <p className="text-sm text-muted-foreground">
            All pending offers have been reviewed.
          </p>
        </div>
      )}

      {!error && data && data.length > 0 && (
        <ReviewTable
          items={data.map((item) => ({
            ...item,
            posts: Array.isArray(item.posts) ? item.posts[0] ?? null : item.posts,
          }))}
        />
      )}
    </div>
  );
}
