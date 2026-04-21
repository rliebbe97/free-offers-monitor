import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReviewRow } from './review-row';
import type { Json } from '@repo/db';

type ReviewItem = {
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
  items: ReviewItem[];
};

export function ReviewTable({ items }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs uppercase tracking-wider">Title</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Confidence</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Created</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Source</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <ReviewRow key={item.id} item={item} />
        ))}
      </TableBody>
    </Table>
  );
}
