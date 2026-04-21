'use server';

import { createServerClient } from '@/lib/supabase/server';

export async function validateEmailAllowlist(): Promise<{ error?: string }> {
  const supabase = await createServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { error: 'Authentication failed.' };
  }

  const allowedEmails =
    process.env.ALLOWED_EMAILS?.split(',').map((e) => e.trim()) ?? [];

  if (!allowedEmails.includes(user.email ?? '')) {
    await supabase.auth.signOut();
    return { error: 'Your account is not authorized.' };
  }

  return {};
}
