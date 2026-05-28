// Lightweight Spamassassin-style word check for /admin/broadcast.
// P0 audit fix (C-3): broadcast had ZERO spam-word check. Operator could
// blast "FREE!!! ACT NOW" subject to 1500 inboxes → Resend sender domain
// blacklisted → BHC transactional email infra dies.
//
// Returns a score (0-100) + violation list. score >= 50 = block.

const SPAM_TRIGGERS: Array<{ pattern: RegExp; weight: number; name: string }> = [
  // Money / urgency punctuation
  { pattern: /\$\$\$|\$\$|!!+/g, weight: 10, name: 'punctuation-spam' },
  { pattern: /\bFREE\b/gi, weight: 15, name: 'free' },
  { pattern: /\bGUARANTEE(D)?\b/gi, weight: 10, name: 'guaranteed' },
  { pattern: /\bWIN\b|\bWINNER\b/gi, weight: 8, name: 'win' },
  { pattern: /\bACT NOW\b/gi, weight: 15, name: 'act-now' },
  { pattern: /\bEARN\b/gi, weight: 10, name: 'earn' },
  { pattern: /\bCASH\b/gi, weight: 8, name: 'cash' },
  { pattern: /\bURGENT\b/gi, weight: 12, name: 'urgent' },
  { pattern: /\bCLICK HERE\b/gi, weight: 8, name: 'click-here' },
  { pattern: /\b100% (FREE|GUARANTEE)/gi, weight: 20, name: '100-percent' },
  { pattern: /\b(VIAGRA|XANAX|LOAN|MORTGAGE)\b/gi, weight: 30, name: 'pharmaceutical-loan' },
];

const MAX_CAPS_RATIO = 0.25;
const CAPS_PENALTY = 15;

export interface SpamCheckResult {
  score: number;        // 0-100 (higher = more spammy)
  violations: string[]; // human-readable list
  blocked: boolean;     // true if score >= 50
}

export function spamCheck(text: string | undefined | null): SpamCheckResult {
  if (!text) return { score: 0, violations: [], blocked: false };

  const violations: string[] = [];
  let score = 0;

  // Word / punctuation triggers
  for (const t of SPAM_TRIGGERS) {
    const matches = text.match(t.pattern);
    if (matches) {
      score += t.weight * matches.length;
      violations.push(`${t.name} (${matches.length}× — weight ${t.weight})`);
    }
  }

  // Caps ratio — only meaningful when there's enough alphabetic content.
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 10) {
    const capsCount = letters.replace(/[^A-Z]/g, '').length;
    const ratio = capsCount / letters.length;
    if (ratio > MAX_CAPS_RATIO) {
      score += CAPS_PENALTY;
      violations.push(`excess caps (${(ratio * 100).toFixed(0)}%)`);
    }
  }

  const finalScore = Math.min(100, score);
  return { score: finalScore, violations, blocked: finalScore >= 50 };
}
