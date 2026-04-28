'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { devSignIn } from '@/lib/actions/dev-auth';

export function DevSignInButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await devSignIn();
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push('/dashboard/offers');
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Dev only</span>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        disabled={isPending}
        className="h-11 w-full"
      >
        {isPending ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Signing in…
          </>
        ) : (
          'Skip sign-in (rliebbe97@gmail.com)'
        )}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
