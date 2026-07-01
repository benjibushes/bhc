// Open-redirect defense for the ?next= param that rides the member login
// flow. `next` arrives via the query string or POST body (i.e. fully
// buyer-controlled — anyone can craft a login/intro-email URL with their own
// ?next=). Without this validator, a malicious URL could set our
// bhc-member-auth cookie then bounce the browser to an attacker-controlled
// domain (phishing / credential capture / cookie exfil via meta tags).
//
// Used at every hop of the flow:
//   - /api/auth/member/verify GET (magic-link 302 target)
//   - /api/auth/member/login POST (before embedding next in the emailed link)
//   - /member/verify page (client-side post-auth router.push)
//
// Rules:
//   - Must start with `/` (single slash — relative path)
//   - Must NOT start with `//` (protocol-relative URL = open redirect)
//   - Must NOT contain `://` (defends against `/\\evil.com` style bypasses
//     that some parsers normalize to absolute URLs)
//   - Length cap 200 chars (sanity bound — our legitimate paths are well under)
//
// Anything failing these checks falls back to `/member` (the default landing
// page for an authed buyer). Pure + isomorphic: safe to import from client
// components and route handlers alike.
export function safeNextPath(next: string | null): string {
  if (!next) return '/member';
  if (next.length > 200) return '/member';
  if (!next.startsWith('/')) return '/member';
  if (next.startsWith('//')) return '/member';
  if (next.includes('://')) return '/member';
  return next;
}
