// AI tool registry for BuyHalfCow's AI agent.
//
// Read-only tools the AI can call to investigate the business state. Each
// tool has a JSON schema (for the LLM) and an implementation (for actually
// running it). Schemas use Anthropic's tool-use format.
//
// To add a write tool: define schema, implement, add to TOOLS — but make
// sure the caller fires a Telegram confirmation button before executing.

import { getAllRecords, getRecordById, escapeAirtableValue, TABLES } from './airtable';

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
};

type ToolImpl = (input: any) => Promise<any>;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Tool implementations ─────────────────────────────────────────────────

async function getPendingConsumers(input: { limit?: number }) {
  const consumers = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Pending"') as any[];
  const limit = Math.min(input.limit || 10, 50);
  return {
    total: consumers.length,
    sample: consumers.slice(0, limit).map((c) => ({
      id: c.id,
      name: c['Full Name'],
      email: c['Email'],
      state: c['State'],
      segment: c['Segment'],
      intent: `${c['Intent Score'] || 0} (${c['Intent Classification'] || 'N/A'})`,
      orderType: c['Order Type'] || null,
      budget: c['Budget'] || null,
    })),
  };
}

async function getPendingReferrals(input: { limit?: number }) {
  const refs = await getAllRecords(TABLES.REFERRALS, '{Status} = "Pending Approval"') as any[];
  const limit = Math.min(input.limit || 10, 50);
  return {
    total: refs.length,
    sample: refs.slice(0, limit).map((r) => ({
      id: r.id,
      buyer: r['Buyer Name'],
      state: r['Buyer State'],
      orderType: r['Order Type'],
      intent: r['Intent Classification'],
      suggestedRancher: r['Suggested Rancher Name'],
    })),
  };
}

async function getStalledReferrals(input: { minDays?: number; limit?: number }) {
  const minDays = input.minDays || 5;
  const limit = Math.min(input.limit || 10, 50);
  const refs = await getAllRecords(TABLES.REFERRALS) as any[];
  const stalled = refs.filter((r) => {
    if (!['Intro Sent', 'Rancher Contacted'].includes(r['Status'])) return false;
    const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
    if (!lastActivity) return false;
    return (Date.now() - new Date(lastActivity).getTime()) >= minDays * DAY_MS;
  });
  return {
    total: stalled.length,
    minDays,
    sample: stalled.slice(0, limit).map((r) => {
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      const days = Math.floor((Date.now() - new Date(lastActivity).getTime()) / DAY_MS);
      return {
        id: r.id,
        buyer: r['Buyer Name'],
        state: r['Buyer State'],
        rancher: r['Suggested Rancher Name'],
        status: r['Status'],
        daysStalled: days,
      };
    }),
  };
}

async function getRevenueSummary() {
  const refs = await getAllRecords(TABLES.REFERRALS) as any[];
  const wins = refs.filter((r) => r['Status'] === 'Closed Won');
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const monthlyWins = wins.filter((r) => new Date(r['Closed At'] || 0).getTime() >= monthStart);
  const monthlyCommission = monthlyWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
  const lifetimeCommission = wins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
  const unpaidCommission = wins.filter((r) => !r['Commission Paid']).reduce((s, r) => s + (r['Commission Due'] || 0), 0);
  return {
    monthlyWins: monthlyWins.length,
    monthlyCommission,
    lifetimeWins: wins.length,
    lifetimeCommission,
    unpaidCommission,
  };
}

async function getRancherCapacity(input: { onlyNearCapacity?: boolean }) {
  const ranchers = await getAllRecords(TABLES.RANCHERS) as any[];
  const active = ranchers.filter((r) => r['Active Status'] === 'Active');
  const list = active.map((r) => {
    const cur = r['Current Active Referrals'] || 0;
    const max = r['Max Active Referalls'] || 5;
    return {
      id: r.id,
      name: r['Operator Name'] || r['Ranch Name'],
      state: r['State'],
      currentRefs: cur,
      maxRefs: max,
      utilization: max > 0 ? Math.round((cur / max) * 100) : 0,
    };
  });
  if (input.onlyNearCapacity) {
    return list.filter((r) => r.utilization >= 80);
  }
  return list;
}

async function lookupConsumer(input: { query: string }) {
  if (!input.query) return { error: 'query required' };
  const q = input.query.trim();
  const safe = escapeAirtableValue(q);
  // Try email exact match first, then name fuzzy via LOWER + FIND
  const formula = `OR({Email} = "${safe}", FIND(LOWER("${safe.toLowerCase()}"), LOWER({Full Name})) > 0)`;
  const matches = await getAllRecords(TABLES.CONSUMERS, formula) as any[];
  return {
    matches: matches.slice(0, 5).map((c) => ({
      id: c.id,
      name: c['Full Name'],
      email: c['Email'],
      phone: c['Phone'],
      state: c['State'],
      segment: c['Segment'],
      status: c['Status'],
      intent: `${c['Intent Score'] || 0} (${c['Intent Classification'] || 'N/A'})`,
      orderType: c['Order Type'],
      budget: c['Budget'],
      referralStatus: c['Referral Status'],
      notes: c['Notes'],
    })),
    count: matches.length,
  };
}

async function lookupRancher(input: { query: string }) {
  if (!input.query) return { error: 'query required' };
  const q = input.query.trim();
  const safe = escapeAirtableValue(q);
  const formula = `OR({Email} = "${safe}", {Slug} = "${safe}", FIND(LOWER("${safe.toLowerCase()}"), LOWER({Operator Name})) > 0, FIND(LOWER("${safe.toLowerCase()}"), LOWER({Ranch Name})) > 0)`;
  const matches = await getAllRecords(TABLES.RANCHERS, formula) as any[];
  return {
    matches: matches.slice(0, 5).map((r) => ({
      id: r.id,
      operator: r['Operator Name'],
      ranchName: r['Ranch Name'],
      email: r['Email'],
      phone: r['Phone'],
      state: r['State'],
      activeStatus: r['Active Status'],
      onboardingStatus: r['Onboarding Status'],
      slug: r['Slug'],
      currentRefs: r['Current Active Referrals'] || 0,
      maxRefs: r['Max Active Referalls'] || 5,
    })),
    count: matches.length,
  };
}

async function getUnmatchedBuyers(input: { state?: string; limit?: number }) {
  const limit = Math.min(input.limit || 20, 50);
  let formula = `AND({Status} = "Approved", {Referral Status} = "Unmatched", {Segment} = "Beef Buyer")`;
  if (input.state) {
    formula = `AND({Status} = "Approved", {Referral Status} = "Unmatched", {Segment} = "Beef Buyer", {State} = "${escapeAirtableValue(input.state.toUpperCase())}")`;
  }
  const buyers = await getAllRecords(TABLES.CONSUMERS, formula) as any[];
  // Sort by intent score desc
  buyers.sort((a, b) => (b['Intent Score'] || 0) - (a['Intent Score'] || 0));
  return {
    total: buyers.length,
    state: input.state || 'all',
    sample: buyers.slice(0, limit).map((c) => ({
      id: c.id,
      name: c['Full Name'],
      state: c['State'],
      intent: c['Intent Score'] || 0,
      orderType: c['Order Type'],
      budget: c['Budget'],
    })),
  };
}

// ─── Schemas (Anthropic tool-use format) ──────────────────────────────────

export const TOOLS: ToolSchema[] = [
  {
    name: 'get_pending_consumers',
    description: 'List consumers awaiting manual approval (Status=Pending). Returns count + sample.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records to return in sample (default 10, max 50)' },
      },
    },
  },
  {
    name: 'get_pending_referrals',
    description: 'List referrals awaiting approval (Status=Pending Approval). Returns count + sample.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records to return in sample (default 10, max 50)' },
      },
    },
  },
  {
    name: 'get_stalled_referrals',
    description: 'List referrals stuck in Intro Sent or Rancher Contacted with no activity in N days. Use to find deals that need a nudge.',
    input_schema: {
      type: 'object',
      properties: {
        minDays: { type: 'number', description: 'Minimum days since last activity (default 5)' },
        limit: { type: 'number', description: 'Max records to return (default 10, max 50)' },
      },
    },
  },
  {
    name: 'get_revenue_summary',
    description: 'Get monthly + lifetime revenue, commission, deal counts, and unpaid commission totals.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_rancher_capacity',
    description: 'List active ranchers with their current referral load and max capacity. Use to find who has room or who is overloaded.',
    input_schema: {
      type: 'object',
      properties: {
        onlyNearCapacity: { type: 'boolean', description: 'If true, only return ranchers at 80%+ capacity' },
      },
    },
  },
  {
    name: 'lookup_consumer',
    description: 'Search consumers by name or email. Returns up to 5 matches with full profile data including notes, intent, order type.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment or full email address' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_rancher',
    description: 'Search ranchers by name, slug, or email. Returns up to 5 matches with capacity and status.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, slug, or full email' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_unmatched_buyers',
    description: 'List approved Beef Buyers without an active referral, sorted by intent score. Optionally filter by state. Use to find buyers that need to be matched to a rancher.',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Two-letter state code (e.g. CO). Omit for all states.' },
        limit: { type: 'number', description: 'Max records to return (default 20, max 50)' },
      },
    },
  },
];

const TOOL_IMPLS: Record<string, ToolImpl> = {
  get_pending_consumers: getPendingConsumers,
  get_pending_referrals: getPendingReferrals,
  get_stalled_referrals: getStalledReferrals,
  get_revenue_summary: getRevenueSummary,
  get_rancher_capacity: getRancherCapacity,
  lookup_consumer: lookupConsumer,
  lookup_rancher: lookupRancher,
  get_unmatched_buyers: getUnmatchedBuyers,
};

export async function runTool(name: string, input: any): Promise<any> {
  const impl = TOOL_IMPLS[name];
  if (!impl) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await impl(input || {});
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}
