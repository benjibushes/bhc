// lib/deliverabilityStats.ts
// Pure aggregation for the /admin/health deliverability panel. No I/O — the
// route fetches records and passes them in, so this stays unit-testable.

export interface DeliverabilitySummary {
  inboundLast24h: number;
  inboundTotal: number;
  bounced: number;
  complained: number;
  suppressedTotal: number;
  healthy: boolean; // true when at least one inbound reply has landed in 24h
}

export function summarizeDeliverability(input: {
  conversations: Array<{ fields: Record<string, any> }>;
  suppressed: Array<{ fields: Record<string, any> }>;
  nowMs: number;
}): DeliverabilitySummary {
  const { conversations, suppressed, nowMs } = input;
  const dayAgo = nowMs - 24 * 3600_000;

  const inbound = conversations.filter(
    (c) => String(c.fields.Direction || '').toLowerCase() === 'inbound',
  );
  const inboundLast24h = inbound.filter((c) => {
    const t = Date.parse(c.fields.Timestamp || '');
    return !isNaN(t) && t >= dayAgo;
  }).length;

  const bounced = suppressed.filter((s) => s.fields.Bounced === true).length;
  const complained = suppressed.filter((s) => s.fields.Complained === true).length;

  return {
    inboundLast24h,
    inboundTotal: inbound.length,
    bounced,
    complained,
    suppressedTotal: suppressed.length,
    healthy: inboundLast24h > 0,
  };
}
