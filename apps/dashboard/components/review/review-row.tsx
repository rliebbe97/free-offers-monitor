'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TableRow, TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { approveReviewItem, rejectReviewItem } from '@/lib/actions/review';
import type { Json } from '@repo/db';

type ReviewRowItem = {
  id: string;
  post_id: string;
  tier2_result: Json;
  confidence: number;
  created_at: string;
  posts: {
    url: string;
    title: string | null;
    tier1_result: Json | null;
  } | null;
};

type Props = {
  item: ReviewRowItem;
};

export function ReviewRow({ item }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();

  const t2 = item.tier2_result as Record<string, Json>;
  const title = t2['title'] ? String(t2['title']) : '(untitled)';
  const destinationUrl = t2['destination_url'] ? String(t2['destination_url']) : null;
  const brand = t2['brand'] ? String(t2['brand']) : null;
  const category = t2['category'] ? String(t2['category']) : null;
  const description = t2['description'] ? String(t2['description']) : null;

  const tier1 = item.posts?.tier1_result as Record<string, Json> | null;
  const aiReasoning = tier1?.['reason'] ? String(tier1['reason']) : null;

  function handleRowClick(e: React.MouseEvent) {
    // Don't toggle on button clicks
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    setExpanded((prev) => !prev);
  }

  function handleApprove() {
    startTransition(async () => {
      const result = await approveReviewItem(item.id);
      if (result.error) {
        toast.error('Action failed. Please try again.');
      } else {
        toast.success('Offer approved and published.');
      }
    });
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectReviewItem(item.id);
      if (result.error) {
        toast.error('Action failed. Please try again.');
      } else {
        toast.success('Offer rejected.');
      }
    });
  }

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={handleRowClick}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown size={14} className="text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight size={14} className="text-muted-foreground shrink-0" />
            )}
            <span className="max-w-[200px] truncate">{title}</span>
          </div>
        </TableCell>
        <TableCell>
          <span
            className={cn(
              'font-mono text-xs',
              item.confidence < 0.7 ? 'text-amber-600' : ''
            )}
          >
            {item.confidence.toFixed(2)}
          </span>
        </TableCell>
        <TableCell className="text-sm">
          {new Date(item.created_at).toLocaleDateString()}
        </TableCell>
        <TableCell>
          {item.posts?.url ? (
            <a
              href={item.posts.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm hover:underline text-blue-600 dark:text-blue-400"
              onClick={(e) => e.stopPropagation()}
            >
              {item.posts.title ?? 'Source post'}
            </a>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          )}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={isPending}
              onClick={(e) => {
                e.stopPropagation();
                handleApprove();
              }}
            >
              {isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={(e) => {
                e.stopPropagation();
                handleReject();
              }}
            >
              {isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Reject
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/30 px-6 py-4">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Offer Details</h3>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground uppercase tracking-wider">Title</dt>
                  <dd>{title}</dd>
                </div>
                {destinationUrl && (
                  <div>
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">URL</dt>
                    <dd>
                      <a
                        href={destinationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline text-blue-600 dark:text-blue-400 break-all"
                      >
                        {destinationUrl}
                      </a>
                    </dd>
                  </div>
                )}
                {brand && (
                  <div>
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">Brand</dt>
                    <dd>{brand}</dd>
                  </div>
                )}
                {category && (
                  <div>
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">Category</dt>
                    <dd>{category}</dd>
                  </div>
                )}
                {description && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">Description</dt>
                    <dd className="whitespace-pre-line">{description}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground uppercase tracking-wider">Confidence</dt>
                  <dd className="font-mono text-xs">{item.confidence.toFixed(2)}</dd>
                </div>
                {aiReasoning && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">AI Reasoning</dt>
                    <dd className="whitespace-pre-line text-muted-foreground">{aiReasoning}</dd>
                  </div>
                )}
                {item.posts?.url && (
                  <div>
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">Source Post</dt>
                    <dd>
                      <a
                        href={item.posts.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline text-blue-600 dark:text-blue-400"
                      >
                        {item.posts.title ?? item.posts.url}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
