import Link from 'next/link';
import { ExternalLink, Pencil } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type OfferRow = {
  id: string;
  title: string;
  status: string;
  destination_url: string | null;
  extraction_confidence: number | null;
  created_at: string;
};

type Props = {
  offers: OfferRow[];
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'check_failed':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'expired':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'check_failed':
      return 'Check Failed';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function OffersTable({ offers }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs uppercase tracking-wider">Title</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Status</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">URL</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Confidence</TableHead>
          <TableHead className="text-xs uppercase tracking-wider">Created</TableHead>
          <TableHead className="text-xs uppercase tracking-wider sr-only">Edit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {offers.map((offer) => (
          <TableRow key={offer.id}>
            <TableCell className="max-w-[240px] truncate">{offer.title}</TableCell>
            <TableCell>
              <Badge className={cn('border-0', statusBadgeClass(offer.status))}>
                {statusLabel(offer.status)}
              </Badge>
            </TableCell>
            <TableCell>
              {offer.destination_url ? (
                <a
                  href={offer.destination_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={offer.destination_url}
                  className="inline-flex items-center gap-1 text-sm hover:underline"
                >
                  <span>
                    {offer.destination_url.length > 40
                      ? offer.destination_url.slice(0, 40) + '...'
                      : offer.destination_url}
                  </span>
                  <ExternalLink size={12} />
                </a>
              ) : (
                <span className="text-xs italic text-amber-600">missing — needs admin</span>
              )}
            </TableCell>
            <TableCell>
              {offer.extraction_confidence != null ? (
                <span
                  className={cn(
                    'font-mono text-xs',
                    offer.extraction_confidence < 0.7 ? 'text-amber-600' : ''
                  )}
                >
                  {offer.extraction_confidence.toFixed(2)}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </TableCell>
            <TableCell className="text-sm">
              {new Date(offer.created_at).toLocaleDateString()}
            </TableCell>
            <TableCell>
              <Link
                href={`/dashboard/offers/${offer.id}/edit`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                aria-label={`Edit ${offer.title}`}
              >
                <Pencil size={12} />
                <span>Edit</span>
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
