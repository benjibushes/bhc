// Auth Phase 0 — Clerk-hosted admin sign-in.
//
// Replaces the legacy password form. Browser admin access now requires:
//   1. A Clerk session (magic-link or password + TOTP 2FA)
//   2. Email present in ADMIN_EMAILS env allowlist
//
// Server-to-server callers (Telegram bot, cron, ops) still authenticate
// with the x-admin-password HTTP header — see lib/adminAuth.ts.

import { SignIn } from '@clerk/nextjs';

export default function AdminLoginPage() {
  return (
    <main className="min-h-screen bg-[#F4F1EC] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-[#0E0E0E]">
            BuyHalfCow · Admin
          </h1>
          <p className="text-sm text-[#6B4F3F] mt-2">
            Sign in with your authorized admin email.
          </p>
        </div>
        <SignIn
          path="/admin/login"
          routing="path"
          signUpUrl="/admin/login"
          forceRedirectUrl="/admin"
          fallbackRedirectUrl="/admin"
          appearance={{
            variables: {
              colorPrimary: '#2A4A20', // sage-dark
              colorBackground: '#F4F1EC', // bone
              colorText: '#0E0E0E',
              colorTextSecondary: '#6B4F3F',
              colorInputBackground: '#ffffff',
              colorInputText: '#0E0E0E',
              borderRadius: '4px',
              fontFamily: 'var(--font-inter), system-ui, sans-serif',
            },
            elements: {
              card: 'shadow-sm border border-[#A7A29A]',
              formButtonPrimary:
                'bg-[#2A4A20] hover:bg-[#1f3818] text-[#F4F1EC]',
              footerActionLink: 'text-[#2A4A20]',
            },
          }}
        />
        <div className="mt-6 text-center">
          <a
            href="/"
            className="text-xs text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors"
          >
            ← Back to home
          </a>
        </div>
      </div>
    </main>
  );
}
