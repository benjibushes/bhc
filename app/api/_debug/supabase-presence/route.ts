import { NextResponse } from 'next/server';

// TEMPORARY diagnostic for rancher password-login env wiring (#98).
// Returns BOOLEANS + matched NAMES only — never any value, never a secret.
// Nonce-gated (404 unless ?k=<nonce>) so it isn't a public surface. REMOVE
// this route immediately after reading.
const NONCE = 'sbchk_k294xqart7z';

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('k') !== NONCE) {
    return new NextResponse('Not found', { status: 404 });
  }

  const env = process.env;
  return NextResponse.json({
    // what lib/supabaseAuth.ts actually reads (accepts bare OR NEXT_PUBLIC_)
    url_present: !!(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL),
    anon_present: !!(env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    service_role_present: !!env.SUPABASE_SERVICE_ROLE_KEY,
    url_name: env.SUPABASE_URL ? 'SUPABASE_URL' : env.NEXT_PUBLIC_SUPABASE_URL ? 'NEXT_PUBLIC_SUPABASE_URL' : null,
    anon_name: env.SUPABASE_ANON_KEY ? 'SUPABASE_ANON_KEY' : env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : null,
    // common service-role naming mistakes — true here ⇒ the var IS set but under
    // a name the code doesn't read (rename to SUPABASE_SERVICE_ROLE_KEY).
    alt_names_seen: {
      SUPABASE_SERVICE_ROLE: !!env.SUPABASE_SERVICE_ROLE,
      SUPABASE_SERVICE_KEY: !!env.SUPABASE_SERVICE_KEY,
      SERVICE_ROLE_KEY: !!env.SERVICE_ROLE_KEY,
      SUPABASE_SECRET_KEY: !!env.SUPABASE_SECRET_KEY,
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: !!env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_KEY: !!env.SUPABASE_KEY,
    },
  });
}
