'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { use as usePromise } from 'react';
import Link from 'next/link';
import AdminAuthGuard from '../../../components/AdminAuthGuard';
import { isReferralLocked } from '@/lib/referralLock';

interface JourneyEvent { at: string; type: string; actor: string; summary: string; source: string; }
interface Journey {
  referral: {
    id: string; status: string; buyerId: string; buyerName: string; buyerPhone: string; buyerEmail: string;
    buyerState: string; orderType: string; saleAmount: number; commissionDue: number; commissionPaid?: boolean;
    depositPaidAt: string; finalPaidAt: string; intentScore: number | null;
  };
  rancher: { id: string; name: string; state: string; email: string; phone: string } | null;
  responded: boolean;
  lastInbound: { at: string; from: string; summary: string } | null;
  nextAction: string;
  events: JourneyEvent[];
}
interface RancherOpt { id: string; label: string; state: string; active: boolean; }

const ACTOR_DOT: Record<string, string> = {
  buyer: 'bg-rust', rancher: 'bg-sage-dark', admin: 'bg-charcoal',
  cron: 'bg-dust', system: 'bg-dust', stripe: 'bg-amber-dark', ai: 'bg-saddle',
};
const fmt = (at: string) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = (n: number) => (n ? `$${Number(n).toLocaleString()}` : '—');

export default function DealCockpitPage({ params }: { params: Promise<{ referralId: string }> }) {
  const { referralId } = usePromise(params);
  const router = useRouter();
  const [data, setData] = useState<Journey | null>(null);
  const [ranchers, setRanchers] = useState<RancherOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [role, setRole] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/deal/${referralId}/journey`);
      if (!res.ok) setErr((await res.json().catch(() => ({})))?.error || `Failed (${res.status})`);
      else { setData(await res.json()); setErr(''); }
    } catch { setErr('Could not load this deal.'); }
  }, [referralId]);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/admin/ranchers');
        if (r.ok) {
          const list = await r.json();
          setRanchers((Array.isArray(list) ? list : []).map((x: any) => ({
            id: x.id, label: x.operator_name || x.ranch_name || x.id, state: x.state || '',
            active: String(x.active_status || '').toLowerCase() === 'active',
          })).sort((a: RancherOpt, b: RancherOpt) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label)));
        }
      } catch { /* picker optional */ }
    })();
  }, []);
  useEffect(() => {
    (async () => {
      try { const r = await fetch('/api/admin/auth'); if (r.ok) setRole((await r.json())?.role || ''); } catch { /* default: no admin actions */ }
    })();
  }, []);

  // Generic action runner: confirm → call → refetch → toast.
  // on412: when the server rejects with 412 (needs an operator override / unlock),
  // prompt for a reason and retry. Covers both re-run-match (qualification gate)
  // and reroute (deal-lock) without the client second-guessing the server's rules.
  const run = async (
    label: string,
    fn: () => Promise<Response>,
    confirmMsg?: string,
    on412?: { prompt: string; retry: (reason: string) => Promise<Response> },
  ) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(label); setMsg('');
    try {
      const res = await fn();
      const j = await res.json().catch(() => ({}));
      if (res.ok) { setMsg(j.message || `${label} ✓`); await load(); }
      else if (res.status === 412 && on412) {
        const reason = window.prompt(on412.prompt);
        if (reason && reason.trim().length >= 6) {
          const r2 = await on412.retry(reason.trim());
          const j2 = await r2.json().catch(() => ({}));
          setMsg(r2.ok ? (j2.message || `${label} ✓`) : (j2.error || `${label} failed`));
          if (r2.ok) await load();
        } else setMsg('Override needs a reason (6+ chars).');
      } else setMsg(j.error || `${label} failed (${res.status})`);
    } catch { setMsg(`${label} failed`); }
    setBusy('');
    setAssignOpen(false);
  };

  const POST = (path: string, body?: any) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const PATCH = (path: string, body: any) => fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const postMatch = (override?: string) => POST('/api/matching/suggest', {
    buyerId: data!.referral.buyerId, buyerState: data!.referral.buyerState,
    buyerName: data!.referral.buyerName, buyerEmail: data!.referral.buyerEmail,
    ...(override ? { operatorOverride: true, operatorOverrideReason: override } : {}),
  });

  const rerunMatch = async () => {
    if (!window.confirm('Re-run the matching engine for this buyer? Fires intro emails on a match.')) return;
    setBusy('Re-run match'); setMsg('');
    try {
      const res = await postMatch();
      const j = await res.json().catch(() => ({}));
      if (res.ok) { router.push(`/admin/desk/${j.referralId || referralId}`); return; }
      if (res.status === 412) {
        const reason = window.prompt('Buyer not auto-qualified. Operator override reason (6+ chars)?');
        if (reason && reason.trim().length >= 6) {
          const r2 = await postMatch(reason.trim());
          const j2 = await r2.json().catch(() => ({}));
          if (r2.ok) { router.push(`/admin/desk/${j2.referralId || referralId}`); return; }
          setMsg(j2.error || 'Re-run match failed');
        } else setMsg('Override needs a reason (6+ chars).');
      } else setMsg(j.error || `Re-run match failed (${res.status})`);
    } catch { setMsg('Re-run match failed'); }
    setBusy('');
  };

  if (!data) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen bg-bone text-charcoal">
          <div className="max-w-2xl mx-auto px-4 py-6">
            <Link href="/admin/desk" className="text-sm text-saddle hover:text-charcoal">← Sales desk</Link>
            {loading && <p className="text-center text-saddle py-16">Loading deal…</p>}
            {err && !loading && <p className="text-center text-rust py-16">{err}</p>}
          </div>
        </main>
      </AdminAuthGuard>
    );
  }

  const r = data.referral;
  const rancherId = data.rancher?.id || '';
  const isLocked = isReferralLocked(r.status);
  const isClosed = r.status === 'Closed Won' || r.status === 'Closed Lost';
  const isAdmin = role === 'admin';
  const B = ({ label, onClick, tone = 'plain' }: { label: string; onClick: () => void; tone?: 'plain' | 'primary' | 'danger' }) => (
    <button
      onClick={onClick}
      disabled={!!busy}
      className={`text-sm px-3 py-2 border transition-colors disabled:opacity-40 ${
        tone === 'primary' ? 'border-charcoal bg-charcoal text-bone hover:bg-divider'
        : tone === 'danger' ? 'border-rust text-rust hover:bg-rust hover:text-white'
        : 'border-dust hover:bg-bone'}`}
    >{busy === label ? '…' : label}</button>
  );

  const doAssign = () => {
    if (!assignTo) { setMsg('Pick a rancher first.'); return; }
    const target = ranchers.find((x) => x.id === assignTo);
    if (r.status === 'Pending Approval' && !rancherId) {
      run('Assign', () => PATCH(`/api/referrals/${r.id}/approve`, { rancherId: assignTo }),
        `Approve + send intro to ${target?.label}? This emails the rancher and buyer.`);
    } else {
      const body: any = { newRancherId: assignTo, reason: assignReason || undefined };
      if (isLocked) {
        if (!assignReason || assignReason.trim().length < 6) { setMsg('Locked deal — reroute reason (6+ chars) required.'); return; }
        body.unlockOverride = true; body.unlockReason = assignReason.trim();
      }
      run('Reroute', () => POST(`/api/admin/referrals/${r.id}/reassign`, body),
        `Reroute to ${target?.label}? This emails the new rancher${isLocked ? ' and overrides the lock' : ''}.`,
        { prompt: 'Deal is locked — unlock reason (6+ chars)?', retry: (reason) => POST(`/api/admin/referrals/${r.id}/reassign`, { ...body, unlockOverride: true, unlockReason: reason }) });
    }
  };

  return (
    <AdminAuthGuard>
      <main className="min-h-screen bg-bone text-charcoal pb-24">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <Link href="/admin/desk" className="text-sm text-saddle hover:text-charcoal">← Sales desk</Link>

          {/* Header */}
          <div className="mt-3 p-5 border-2 border-charcoal bg-white">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-2xl">{r.buyerName || 'Buyer'}</h1>
                <p className="text-sm text-saddle">
                  {r.buyerState || '—'} · {r.orderType || 'order'}{r.intentScore != null && ` · intent ${r.intentScore}`}
                </p>
                <p className="text-xs text-dust mt-1">{r.buyerEmail}{r.buyerPhone ? ` · ${r.buyerPhone}` : ''}</p>
              </div>
              <span className="shrink-0 text-xs px-2 py-1 border border-dust bg-bone">{r.status}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <div><span className="text-saddle">Rancher: </span>
                {data.rancher ? <span className="font-medium">{data.rancher.name} <span className="text-dust">({data.rancher.state})</span></span>
                  : <span className="text-rust font-medium">Unmatched</span>}</div>
              {isAdmin && !!r.saleAmount && <div><span className="text-saddle">Sale: </span><span className="font-medium">{money(r.saleAmount)}</span></div>}
              {isAdmin && !!r.commissionDue && <div><span className="text-saddle">Commission: </span><span className="font-medium">{money(r.commissionDue)}{r.commissionPaid ? ' (paid)' : ''}</span></div>}
            </div>
            <div className="mt-4 p-3 bg-bone border-l-4 border-charcoal text-sm">
              <span className="font-medium">Next: </span>{data.nextAction}
              <span className={`ml-2 text-xs ${data.responded ? 'text-sage-dark' : 'text-saddle'}`}>{data.responded ? '· buyer has replied' : '· no reply yet'}</span>
            </div>
          </div>

          {/* Action rail */}
          <div className="mt-4 p-4 border border-dust bg-white">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-[family-name:var(--font-serif)] text-lg">Actions</h2>
              {msg && <span className="text-xs text-saddle">{msg}</span>}
            </div>

            <div className="text-xs text-saddle mb-1">Deal</div>
            {isAdmin ? (
              <div className="flex flex-wrap gap-2">
                <B label={rancherId ? 'Reroute' : 'Assign rancher'} tone={rancherId ? 'plain' : 'primary'} onClick={() => setAssignOpen((v) => !v)} />
                {r.status === 'Pending Approval' && rancherId && <B label="Approve & intro" tone="primary" onClick={() => run('Approve', () => PATCH(`/api/referrals/${r.id}/approve`, {}), 'Approve + send the intro emails?')} />}
                {!isClosed && rancherId && <B label="Mark won" tone="primary" onClick={() => {
                  const amt = window.prompt('Sale amount ($)?'); const n = Number(amt);
                  if (!amt) return; if (!Number.isFinite(n) || n <= 0) { setMsg('Enter a positive amount.'); return; }
                  run('Mark won', () => PATCH(`/api/referrals/${r.id}`, { status: 'Closed Won', saleAmount: n }), `Close WON at $${n.toLocaleString()}? Fires the buyer welcome + sale alert.`);
                }} />}
                {!isClosed && <B label="Mark lost" tone="danger" onClick={() => {
                  const reason = window.prompt('Reason (optional): no_response / price / timing / other') || undefined;
                  run('Mark lost', () => PATCH(`/api/referrals/${r.id}`, { status: 'Closed Lost', closeReason: reason }), 'Close this deal as LOST?');
                }} />}
                {rancherId && !isClosed && <B label="Resend intro" onClick={() => run('Resend intro', () => POST(`/api/admin/referrals/${r.id}/resend-intro`), 'Resend the intro emails to rancher + buyer?')} />}
                {r.status === 'Closed Lost' && <B label="Reopen" tone="primary" onClick={() => run('Reopen', () => POST(`/api/admin/referrals/${r.id}/revive`, {}), 'Reopen this lead (back to Pending Approval)?')} />}
                {r.status === 'Closed Won' && <B label="Adjust commission" onClick={() => {
                  const amt = window.prompt('New commission due ($)?'); const n = Number(amt);
                  if (!amt) return; if (!Number.isFinite(n) || n < 0) { setMsg('Enter a valid amount.'); return; }
                  const reason = window.prompt('Reason for adjustment?') || undefined;
                  run('Adjust', () => POST(`/api/admin/referrals/${r.id}/adjust-commission`, { commissionDue: n, reason }), `Change commission to $${n.toLocaleString()}? Re-bills the rancher + posts a Telegram alert.`);
                }} />}
                {r.status === 'Closed Won' && !r.commissionPaid && <B label="Mark commission paid" onClick={() => run('Mark paid', () => PATCH(`/api/referrals/${r.id}`, { commissionPaid: true }), 'Mark this commission as PAID?')} />}
              </div>
            ) : (
              <p className="text-xs text-dust">Read-only — sign in as admin to act on deals.</p>
            )}

            <div className="text-xs text-saddle mt-3 mb-1">Buyer</div>
            <div className="flex flex-wrap gap-2">
              {r.buyerEmail && <a href={`mailto:${r.buyerEmail}`} className="text-sm px-3 py-2 border border-dust hover:bg-bone">Email</a>}
              {r.buyerPhone && <a href={`sms:${r.buyerPhone}`} className="text-sm px-3 py-2 border border-dust hover:bg-bone">Text</a>}
              {r.buyerPhone && <a href={`tel:${r.buyerPhone}`} className="text-sm px-3 py-2 border border-dust hover:bg-bone">Call</a>}
              {isAdmin && !rancherId && r.buyerId && <B label="Re-run match" tone="primary" onClick={rerunMatch} />}
              {isAdmin && r.buyerId && <B label="Resend warmup" onClick={() => run('Resend warmup', () => POST(`/api/admin/consumers/${r.buyerId}/resend-warmup`, {}), 'Send the warmup YES-button email to this buyer?')} />}
            </div>

            {data.rancher && (
              <>
                <div className="text-xs text-saddle mt-3 mb-1">Rancher · {data.rancher.name}</div>
                <div className="flex flex-wrap gap-2">
                  {data.rancher.email && <a href={`mailto:${data.rancher.email}`} className="text-sm px-3 py-2 border border-dust hover:bg-bone">Email rancher</a>}
                  {isAdmin && <B label="Go live" onClick={() => run('Go live', () => POST(`/api/admin/ranchers/${rancherId}/go-live`, {}), 'Go-live this rancher? May blast warmups to up to 50 waiting buyers.')} />}
                  {isAdmin && <B label="Pause" onClick={() => run('Pause', () => POST(`/api/admin/ranchers/${rancherId}/pause`, {}), 'Pause this rancher (stop new leads)?')} />}
                  {isAdmin && <B label="Resume" onClick={() => run('Resume', () => POST(`/api/admin/ranchers/${rancherId}/resume`, {}), 'Resume this rancher (re-enable lead routing)?')} />}
                  <B label="Resync Connect" onClick={() => run('Resync', () => POST(`/api/admin/ranchers/${rancherId}/resync-connect`, {}), 'Resync Stripe Connect status from Stripe?')} />
                </div>
              </>
            )}

            {/* Assign / reroute panel */}
            {assignOpen && (
              <div className="mt-4 p-3 border border-charcoal bg-bone">
                <div className="text-sm font-medium mb-2">{rancherId ? 'Reroute to a different rancher' : 'Assign a rancher'}</div>
                <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="w-full px-3 py-2 border border-dust bg-white text-sm mb-2">
                  <option value="">Pick a rancher…</option>
                  {ranchers.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.state}){x.active ? '' : ' — inactive'}</option>)}
                </select>
                <input value={assignReason} onChange={(e) => setAssignReason(e.target.value)}
                  placeholder={isLocked ? 'Reason (required — deal is locked)' : 'Reason (optional)'}
                  className="w-full px-3 py-2 border border-dust bg-white text-sm mb-2" />
                <div className="flex gap-2">
                  <B label={rancherId ? 'Reroute' : 'Assign'} tone="primary" onClick={doAssign} />
                  <button onClick={() => setAssignOpen(false)} className="text-sm px-3 py-2 border border-dust hover:bg-bone">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Journey timeline */}
          <h2 className="font-[family-name:var(--font-serif)] text-lg mt-6 mb-3">Customer journey</h2>
          {data.events.length === 0 ? (
            <div className="p-6 border border-dust bg-white text-center text-saddle text-sm">No recorded events yet.</div>
          ) : (
            <div className="border border-dust bg-white">
              {data.events.map((e, i) => (
                <div key={i} className={`flex gap-3 p-3 ${i > 0 ? 'border-t border-dust' : ''}`}>
                  <div className="flex flex-col items-center pt-1">
                    <span className={`w-2.5 h-2.5 rounded-full ${ACTOR_DOT[e.actor] || 'bg-dust'}`} />
                    {i < data.events.length - 1 && <span className="w-px flex-1 bg-dust mt-1" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{e.summary}</div>
                    <div className="text-xs text-dust mt-0.5">{fmt(e.at)} · {e.actor}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </AdminAuthGuard>
  );
}
