import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';
import { DevSignInButton } from '@/components/auth/dev-signin-button';

export const metadata: Metadata = {
  title: 'Sign in — Free Offers Monitor',
};

export default function LoginPage() {
  const isDev = process.env.NODE_ENV !== 'production';

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Access is restricted to approved accounts.
          </p>
        </div>
        <LoginForm />
        {isDev && <DevSignInButton />}
      </div>
    </div>
  );
}
