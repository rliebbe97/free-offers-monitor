'use client';

import { useRouter, usePathname } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Props = {
  status: string;
  sort: string;
};

export function OffersFilters({ status, sort }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  function handleStatusChange(newStatus: string) {
    const params = new URLSearchParams();
    params.set('status', newStatus);
    params.set('sort', sort);
    params.set('page', '1');
    router.push(pathname + '?' + params.toString());
  }

  function handleSortChange(newSort: string) {
    const params = new URLSearchParams();
    params.set('status', status);
    params.set('sort', newSort);
    params.set('page', '1');
    router.push(pathname + '?' + params.toString());
  }

  return (
    <div className="flex flex-row gap-4 items-center">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Status</span>
        <Select value={status} onValueChange={handleStatusChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="check_failed">Check Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Sort</span>
        <Select value={sort} onValueChange={handleSortChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="confidence">Highest confidence</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
