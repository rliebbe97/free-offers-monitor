import Link from 'next/link';
import { ChevronUp, ChevronDown } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
type AiCallRow = {
  id: string;
  tier: number;
  model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  created_at: string;
  error: string | null;
};

type Props = {
  calls: AiCallRow[];
  currentSort: string;
  currentDir: string;
};

type SortableColumn = {
  key: string;
  label: string;
};

const SORTABLE_COLUMNS: SortableColumn[] = [
  { key: 'created_at', label: 'Time' },
  { key: 'model', label: 'Model' },
  { key: 'tier', label: 'Tier' },
  { key: 'input_tokens', label: 'Input Tokens' },
  { key: 'output_tokens', label: 'Output Tokens' },
  { key: 'cost_usd', label: 'Cost (USD)' },
  { key: 'latency_ms', label: 'Latency (ms)' },
];

function SortableHead({
  column,
  label,
  currentSort,
  currentDir,
}: {
  column: string;
  label: string;
  currentSort: string;
  currentDir: string;
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === 'desc' ? 'asc' : 'desc';

  return (
    <TableHead className="text-xs uppercase tracking-wider">
      <Link
        href={`?sort=${column}&dir=${nextDir}`}
        className="inline-flex items-center gap-1 hover:text-foreground text-muted-foreground transition-colors"
      >
        {label}
        {isActive ? (
          currentDir === 'asc' ? (
            <ChevronUp size={12} className="text-foreground" />
          ) : (
            <ChevronDown size={12} className="text-foreground" />
          )
        ) : null}
      </Link>
    </TableHead>
  );
}

export function AiLogsTable({ calls, currentSort, currentDir }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {SORTABLE_COLUMNS.map((col) => (
            <SortableHead
              key={col.key}
              column={col.key}
              label={col.label}
              currentSort={currentSort}
              currentDir={currentDir}
            />
          ))}
          <TableHead className="text-xs uppercase tracking-wider">Prompt Version</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => (
          <TableRow key={call.id}>
            <TableCell className="text-sm">
              {new Date(call.created_at).toLocaleString()}
            </TableCell>
            <TableCell className="text-sm">{call.model}</TableCell>
            <TableCell className="text-sm">{call.tier}</TableCell>
            <TableCell className="font-mono text-xs">
              {call.input_tokens.toLocaleString()}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {call.output_tokens.toLocaleString()}
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs">
                ${call.cost_usd.toFixed(6)}
              </span>
            </TableCell>
            <TableCell>
              <span className={cn('font-mono text-xs', call.error ? 'text-destructive' : '')}>
                {call.latency_ms}ms
              </span>
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs text-muted-foreground">
                {call.prompt_version.slice(0, 7)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
