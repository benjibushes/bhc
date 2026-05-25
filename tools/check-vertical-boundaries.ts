#!/usr/bin/env tsx
// Vertical boundary checker.
//
// Fails CI (when VERTICAL_BOUNDARY_ENFORCE=error) if a Buyer-vertical file
// imports a Rancher-vertical internal module, or vice versa. Both verticals
// may import from the shared lib/ surface (see ALLOWED_SHARED_PREFIXES).
//
// Run locally:
//   VERTICAL_BOUNDARY_ENFORCE=warn npx tsx tools/check-vertical-boundaries.ts
// Run in CI as a build step OR add as a pre-commit hook in package.json.

import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const VERTICALS: Record<'buyer' | 'rancher' | 'admin', string[]> = {
  buyer: [
    'app/(buyer)/',
    'app/access/',
    'app/map/',
    'app/member/',
    'app/start/',
    'app/wins/',
    'app/api/consumers/',
    'app/api/warmup/',
    'app/api/member/',
    'app/api/orders/',
    'app/api/checkout/',
    'app/api/threads/',
  ],
  rancher: [
    'app/(rancher)/',
    'app/rancher/',
    'app/ranchers/',
    'app/api/rancher/',
    'app/api/ranchers/',
    'app/api/auth/rancher/',
  ],
  admin: [
    'app/(admin)/',
    'app/admin/',
    'app/api/admin/',
    'app/api/webhooks/telegram/',
    'app/api/cron/',
  ],
};

// Shared modules every vertical may import. Anything else under `@/lib`
// is automatically allowed (lib/ is the shared layer by definition).
// This list is for explicitness; it's a no-op at runtime since the
// boundary check below only fires on cross-vertical `@/app/...` style
// imports — which shouldn't exist at all.
const ALLOWED_SHARED_PREFIXES = [
  '@/lib/',
  '@/components/',
  '@/styles/',
  '@/public/',
];

function vertical(path: string): 'buyer' | 'rancher' | 'admin' | 'shared' {
  for (const [v, prefixes] of Object.entries(VERTICALS)) {
    if (prefixes.some((p) => path.startsWith(p))) return v as 'buyer' | 'rancher' | 'admin';
  }
  return 'shared';
}

const enforcement = process.env.VERTICAL_BOUNDARY_ENFORCE || 'warn';
let violations = 0;

const tracked: string = execSync('git ls-files app/').toString();
const files = tracked
  .trim()
  .split('\n')
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

for (const file of files) {
  const v = vertical(file);
  if (v === 'shared') continue;
  const content = readFileSync(file, 'utf-8');
  const importLines = content.match(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm) || [];
  for (const line of importLines) {
    const m = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const importPath = m[1];
    if (!importPath.startsWith('@/')) continue;
    if (ALLOWED_SHARED_PREFIXES.some((p) => importPath.startsWith(p))) continue;
    // Resolve @/ to repo root (already done by tsconfig paths). Strip the @/.
    const resolved = importPath.replace(/^@\//, '');
    const targetVertical = vertical(resolved);
    if (targetVertical === 'shared') continue;
    if (targetVertical !== v) {
      console.warn(`[boundary] ${file} (${v}) imports ${importPath} (${targetVertical})`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} vertical boundary violation(s). Refactor through @/lib/contracts/* or move the file.`);
  if (enforcement === 'error') {
    process.exit(1);
  }
} else {
  console.log('Boundary check: 0 violations.');
}
