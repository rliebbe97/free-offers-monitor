'use server';

import { createServerClient } from '@/lib/supabase/server';

const DEV_EMAIL = 'rliebbe97@gmail.com';

// Dev-only one-click sign-in. Hard-fails if NODE_ENV is production.
// The button that calls this is also gated on NODE_ENV at render time —
// this is the second line of defense.
export async function devSignIn(): Promise<{ error?: string }> {
  if (process.env.NODE_ENV === 'production') {
    return { error: 'Dev sign-in is disabled in production.' };
  }

  const password = process.env.DEV_LOGIN_PASSWORD;
  if (!password) {
    return {
      error: `Set DEV_LOGIN_PASSWORD in apps/dashboard/.env.local to the Supabase password for ${DEV_EMAIL}.`,
    };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: DEV_EMAIL,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  return {};
}
