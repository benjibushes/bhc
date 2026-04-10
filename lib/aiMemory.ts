// Lightweight cross-conversation memory for the BHC AI agent.
//
// Storage: a single magic-named row in the Campaigns table (no schema
// changes — Campaigns already exists). The Message field holds memory
// as plain text, one fact per line. Capped at MAX_MEMORIES lines to
// keep injection cost low.
//
// Read on every /ask + /scout. Write via the `remember_fact` AI tool.

import { getAllRecords, createRecord, updateRecord, escapeAirtableValue, TABLES } from './airtable';

const MEMORY_RECORD_NAME = '__ai_memory__';
const MAX_MEMORIES = 40;

let cachedRecord: { id: string; lines: string[] } | null = null;

async function loadMemoryRecord(): Promise<{ id: string; lines: string[] } | null> {
  if (cachedRecord) return cachedRecord;
  try {
    const records = await getAllRecords(
      TABLES.CAMPAIGNS,
      `{Campaign Name} = "${escapeAirtableValue(MEMORY_RECORD_NAME)}"`
    ) as any[];
    if (records.length === 0) return null;
    const r = records[0];
    const message = r['Message'] || '';
    const lines = message.split('\n').map((l: string) => l.trim()).filter(Boolean);
    cachedRecord = { id: r.id, lines };
    return cachedRecord;
  } catch (e) {
    console.error('AI memory load error:', e);
    return null;
  }
}

export async function recallAllMemories(): Promise<string[]> {
  const rec = await loadMemoryRecord();
  return rec?.lines || [];
}

// Returns a system-prompt-friendly block summarizing what the AI knows
// about Ben's preferences and prior conversations.
export async function buildMemoryContextBlock(): Promise<string> {
  const lines = await recallAllMemories();
  if (lines.length === 0) return '';
  return `\n\n<memory>\nFacts you've learned about Ben and BuyHalfCow from prior conversations (most recent last):\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n</memory>`;
}

export async function rememberFact(fact: string): Promise<{ ok: boolean; total: number; error?: string }> {
  if (!fact || fact.trim().length === 0) {
    return { ok: false, total: 0, error: 'Empty fact' };
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const newLine = `[${stamp}] ${fact.trim()}`;

  try {
    const existing = await loadMemoryRecord();
    if (existing) {
      // Avoid exact duplicates (same content, ignoring date prefix)
      const factText = fact.trim().toLowerCase();
      const isDuplicate = existing.lines.some(l => {
        const stripped = l.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').toLowerCase();
        return stripped === factText;
      });
      if (isDuplicate) {
        return { ok: true, total: existing.lines.length };
      }
      const updated = [...existing.lines, newLine].slice(-MAX_MEMORIES);
      await updateRecord(TABLES.CAMPAIGNS, existing.id, { 'Message': updated.join('\n') });
      cachedRecord = { id: existing.id, lines: updated };
      return { ok: true, total: updated.length };
    } else {
      // Create the memory row
      const created: any = await createRecord(TABLES.CAMPAIGNS, {
        'Campaign Name': MEMORY_RECORD_NAME,
        'Subject': 'AI Memory Store',
        'Message': newLine,
        'Audience': 'internal',
        'Status': 'Draft',
      });
      cachedRecord = { id: created.id, lines: [newLine] };
      return { ok: true, total: 1 };
    }
  } catch (e: any) {
    console.error('AI memory write error:', e);
    return { ok: false, total: 0, error: e.message };
  }
}

export async function forgetMemory(query: string): Promise<{ ok: boolean; removed: number; total: number }> {
  if (!query || query.trim().length === 0) return { ok: false, removed: 0, total: 0 };
  const existing = await loadMemoryRecord();
  if (!existing) return { ok: false, removed: 0, total: 0 };
  const q = query.trim().toLowerCase();
  const remaining = existing.lines.filter(l => !l.toLowerCase().includes(q));
  const removed = existing.lines.length - remaining.length;
  if (removed === 0) return { ok: true, removed: 0, total: existing.lines.length };
  await updateRecord(TABLES.CAMPAIGNS, existing.id, { 'Message': remaining.join('\n') });
  cachedRecord = { id: existing.id, lines: remaining };
  return { ok: true, removed, total: remaining.length };
}

// Bypass cache — useful when you want fresh state after an external write.
export function invalidateMemoryCache() {
  cachedRecord = null;
}
