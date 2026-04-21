'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ClipboardList, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { href: '/dashboard/offers', label: 'Offers', icon: LayoutDashboard },
  { href: '/dashboard/review', label: 'Review Queue', icon: ClipboardList },
  { href: '/dashboard/ai-logs', label: 'AI Logs', icon: Bot },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex w-60 border-r flex-col py-6 px-2 overflow-y-auto">
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'border-l-2 border-primary bg-accent text-foreground font-semibold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <Separator className="mt-auto" />
    </aside>
  );
}
