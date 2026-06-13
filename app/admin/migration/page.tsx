// app/admin/migration/page.tsx — tier_v2 migration funnel tracker.
//
// At-a-glance: completion %, who's done, who's at risk, who hasn't been
// invited yet. Bulk-invite remaining ranchers in one click.

'use client';

import { useEffect, useState } from 'react';

interface MigrationRancher {
  id: string;
  name: string;
  email: string;
  state: string;
  pricingModel: string;
  migrationStatus: string;
  migrationDeadline: string;
  daysLeft: number | null;
  inviteSentAt: string;
  callBookedAt: string;
  subscriptionStatus: string;
  connectStatus: string;
  connectAccountId: string;
  activeStatus: string;
}

interface MigrationData {
  summary: {
    total: number;
    completed: number;
    completionPct: number;
    notInvited: number;
    invited: number;
    callScheduled: number;
    upgrading: number;
    pausedOverdue: number;
    atRisk: number;
  };
  ranchers: MigrationRancher[];
}

function statusBadge(status: string, pricingModel: string) {
  if (pricingModel === 'tier_v2') return { label: '✓ tier_v2', color: 'bg-sage/15 text-sage-dark border-sage' };
  switch (status) {
    case 'completed':
      return { label: '✓ Completed', color: 'bg-sage/15 text-sage-dark border-sage' };
    case 'upgrading':
      return { label: '⏳ Upgrading', color: 'bg-dust/25 text-saddle border-charcoal' };
    case 'call_scheduled':
      return { label: '📅 Call Booked', color: 'bg-saddle/15 text-saddle border-saddle' };
    case 'invited':
      return { label: '📧 Invited', color: 'bg-amber/15 text-amber-dark border-amber-dark' };
    case 'paused_overdue':
      return { label: '⏸ Paused — Overdue', color: 'bg-weathered/15 text-weathered border-weathered' };
    case 'not_invited':
    default:
      return { label: '— Not Invited', color: 'bg-bone-deep text-saddle border-dust' };
  }
}

export default function MigrationTrackerPage() {
  const [data, setData] = useState<MigrationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ sent: number; failed: number } | null>(null);

  // ── Reactivation campaign panel state ───────────────────────────────
  const [reactBusy, setReactBusy] = useState(false);
  const [reactPreview, setReactPreview] = useState<{
    tierACounted: number;
    tierBCounted: number;
    names: string[];
  } | null>(null);
  const [reactSent, setReactSent] = useState<{ sent: number; skipped: number } | null>(null);
  const [reactError, setReactError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/migration', { cache: 'no-store' });
      if (!r.ok) {
        setError(`Failed to load: HTTP ${r.status}`);
        return;
      }
      setData(await r.json());
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function fireSingle(id: string) {
    if (!confirm('Send v2 upgrade invite to this rancher?')) return;
    const r = await fetch(`/api/admin/ranchers/${id}/send-v2-upgrade`, { method: 'POST' });
    if (!r.ok) {
      alert(`Failed: ${await r.text()}`);
      return;
    }
    load();
  }

  // HYBRID path — flip rancher to Legacy Connect (Stripe Connect + 10%
  // commission, no monthly subscription). For ranchers who don't want
  // Pasture/Ranch/Operator subscription but DO want on-platform deposits.
  // Operator pastes the returned onboardingUrl into a text/email to the
  // rancher. They complete Stripe Express → webhook flips Connect Status
  // to 'active' → deposit checkout becomes live for them.
  async function markLegacyConnect(id: string, name: string) {
    const ok = confirm(
      `Flag ${name} as LEGACY CONNECT?\n\n` +
        `• Pricing Model → tier_v2 (Stripe Connect deposits, on-platform)\n` +
        `• Tier → Legacy Connect (10% commission at deposit, no monthly fee)\n` +
        `• Stripe Connect Account created if missing\n` +
        `• You get a fresh onboarding URL to text/email them\n\n` +
        `Reversible via Airtable. Proceed?`,
    );
    if (!ok) return;
    let r: Response;
    try {
      r = await fetch(`/api/admin/ranchers/${id}/mark-legacy-connect`, { method: 'POST' });
    } catch (e: any) {
      alert(`Network error: ${e?.message || 'unknown'}`);
      return;
    }
    let j: any = {};
    try {
      j = await r.json();
    } catch {}
    if (!r.ok) {
      alert(`Failed (${r.status}): ${j?.error || (await r.text().catch(() => 'unknown'))}`);
      return;
    }
    // Copy onboarding URL to clipboard for fast paste-to-rancher.
    try {
      if (j.onboardingUrl && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(j.onboardingUrl);
      }
    } catch {
      /* clipboard write may fail under non-https contexts; URL still shown in alert */
    }
    alert(
      `✓ ${j.ranchName || name} → Legacy Connect.\n\n` +
        `Onboarding URL (copied to clipboard):\n${j.onboardingUrl}\n\n` +
        `Account: ${j.connectAccountId}${j.accountCreated ? ' (NEW)' : ' (existing)'}\n` +
        `Commission: 10% at deposit, no subscription.\n\n` +
        `Paste the URL into a text/email so the rancher can finish Stripe Express. Once they finish, the deposit flow is live for them.`,
    );
    load();
  }

  // Force a LIVE Stripe read of the rancher's Connect account + persist the
  // true status. Use when Connect Status is stuck at 'onboarding' despite the
  // rancher having finished Stripe KYC — the account.updated webhook can miss
  // the canonical row (e.g. it fired before a dup-merge, as with Renick Valley
  // 2026-06-10). Flips to 'active' the moment Stripe confirms charges enabled,
  // which makes the deposit checkout go live.
  async function resyncConnect(id: string, name: string) {
    let r: Response;
    try {
      r = await fetch(`/api/admin/ranchers/${id}/resync-connect`, { method: 'POST' });
    } catch (e: any) {
      alert(`Network error: ${e?.message || 'unknown'}`);
      return;
    }
    let j: any = {};
    try {
      j = await r.json();
    } catch {}
    if (!r.ok) {
      alert(`Resync failed (${r.status}): ${j?.error || 'unknown'}`);
      return;
    }
    alert(
      j.depositReady
        ? `✅ ${j.ranchName || name} is ACTIVE — deposits flow now.\n\n` +
            `Connect status: ${j.status}\n` +
            `Migration: ${j.migrationCompleted ? 'marked completed' : 'unchanged'}\n` +
            `${j.changed ? '(status was just updated)' : '(already active)'}`
        : `${j.ranchName || name} live Stripe status: ${j.status}\n\n` +
            `requirements: ${j.requirementsStatus || 'n/a'}\n` +
            `card_payments: ${j.cardPaymentsActive ? 'active' : 'inactive'}\n\n` +
            `Rancher must finish Stripe Connect onboarding before deposits unlock.`,
    );
    load();
  }

  async function fireBulk() {
    if (!data) return;
    const notInvited = data.ranchers.filter((r) => r.migrationStatus === 'not_invited');
    if (notInvited.length === 0) {
      alert('No not-invited ranchers to send to.');
      return;
    }
    if (!confirm(`Bulk-send v2 upgrade invite to ${notInvited.length} ranchers?\n\n${notInvited.map((r) => `• ${r.name}`).join('\n')}`)) return;
    setBulkSending(true);
    setBulkResult(null);
    try {
      const r = await fetch('/api/admin/migration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const j = await r.json();
      setBulkResult({ sent: j.sent || 0, failed: j.failed || 0 });
      load();
    } catch (e: any) {
      setError(e?.message || 'Bulk send failed');
    } finally {
      setBulkSending(false);
    }
  }

  // ── Reactivation campaign: Preview (dry-run) ────────────────────────
  // POST ?dryRun=1 → shows who WOULD be contacted. Sends nothing.
  async function reactPreviewNow() {
    setReactBusy(true);
    setReactError('');
    setReactSent(null);
    try {
      const r = await fetch('/api/admin/rancher-reactivation/send-now?dryRun=1', {
        method: 'POST',
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setReactError(j?.error || `HTTP ${r.status}`);
        return;
      }
      setReactPreview({ tierACounted: j.tierACounted || 0, tierBCounted: j.tierBCounted || 0, names: j.names || [] });
    } catch (e: any) {
      setReactError(e?.message || 'Preview failed');
    } finally {
      setReactBusy(false);
    }
  }

  // ── Reactivation campaign: Send Now (real) ──────────────────────────
  // Confirm dialog → POST (no dryRun) → sends to ALL eligible first-touch
  // ranchers. Not gated on the campaign flag — this click IS the go.
  async function reactSendNow() {
    const n = reactPreview ? reactPreview.names.length : null;
    const confirmMsg = n !== null
      ? `Send the reactivation email to ${n} ranchers now? This cannot be undone.`
      : 'Send the reactivation email to all eligible ranchers now? This cannot be undone.';
    if (!confirm(confirmMsg)) return;
    setReactBusy(true);
    setReactError('');
    try {
      const r = await fetch('/api/admin/rancher-reactivation/send-now', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setReactError(j?.error || `HTTP ${r.status}`);
        return;
      }
      setReactSent({ sent: j.sent || 0, skipped: j.skipped || 0 });
      // Refresh the preview to reflect the now-stamped (no-longer-eligible) set.
      setReactPreview({ tierACounted: 0, tierBCounted: 0, names: [] });
    } catch (e: any) {
      setReactError(e?.message || 'Send failed');
    } finally {
      setReactBusy(false);
    }
  }

  if (loading) return <main className="p-8 text-saddle">Loading migration funnel…</main>;
  if (error || !data) return <main className="p-8 text-weathered">Error: {error || 'No data'}</main>;

  return (
    <main className="min-h-screen bg-bone py-8 px-4 md:px-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex justify-between items-center flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-saddle mb-1">Admin</p>
            <h1 className="font-serif text-3xl text-charcoal">tier_v2 Migration Tracker</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="px-4 py-2 text-sm border border-dust hover:bg-white">↻ Refresh</button>
            <button
              onClick={fireBulk}
              disabled={bulkSending || data.summary.notInvited === 0}
              className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle disabled:opacity-50"
            >
              {bulkSending ? 'Sending…' : `🚀 Bulk Invite ${data.summary.notInvited} Not-Invited`}
            </button>
          </div>
        </header>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">Completion</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.completionPct}%</p>
            <p className="text-xs text-saddle mt-1">{data.summary.completed} / {data.summary.total}</p>
            <div className="h-2 bg-dust mt-2">
              <div className="h-full bg-charcoal" style={{ width: `${data.summary.completionPct}%` }} />
            </div>
          </div>
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">In Flight</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.invited + data.summary.callScheduled + data.summary.upgrading}</p>
            <p className="text-xs text-saddle mt-1">invited / scheduled / upgrading</p>
          </div>
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">At Risk (≤3d)</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.atRisk}</p>
            <p className="text-xs text-saddle mt-1">close to deadline</p>
          </div>
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">Paused Overdue</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.pausedOverdue}</p>
            <p className="text-xs text-saddle mt-1">past deadline, paused</p>
          </div>
        </div>

        {bulkResult && (
          <div className="bg-bone border border-charcoal p-4 text-sm">
            ✓ Bulk send complete. Sent: {bulkResult.sent} · Failed: {bulkResult.failed}
          </div>
        )}

        {/* ── Reactivation campaign panel ──────────────────────────────── */}
        <div className="bg-white border border-dust p-5 space-y-4">
          <div className="flex justify-between items-start flex-wrap gap-3">
            <div>
              <h2 className="font-serif text-xl text-charcoal">📣 Reactivation Campaign</h2>
              <p className="text-xs text-saddle mt-1 max-w-2xl">
                One-click first-touch blast to dormant legacy ranchers (Tier A warm,
                then Tier B cold). Preview first to see exactly who would be contacted,
                then Send Now. Excludes Wave-1, hold-outs, agreement-signed, unsubscribed,
                and already-booked ranchers automatically. Bypasses the campaign flag —
                this button is the authorization.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={reactPreviewNow}
                disabled={reactBusy}
                className="px-4 py-2 text-sm border border-dust hover:bg-bone disabled:opacity-50"
              >
                {reactBusy ? 'Working…' : '👁 Preview'}
              </button>
              <button
                onClick={reactSendNow}
                disabled={reactBusy}
                className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle disabled:opacity-50"
              >
                {reactBusy ? 'Working…' : '📣 Send Now'}
              </button>
            </div>
          </div>

          {reactError && (
            <div className="bg-weathered/10 border border-weathered text-weathered text-sm p-3">
              Error: {reactError}
            </div>
          )}

          {reactPreview && reactPreview.names.length > 0 && (
            <div className="bg-bone border border-dust p-4 text-sm space-y-2">
              <p className="text-charcoal font-medium">
                Would send to {reactPreview.names.length} ranchers: Tier A {reactPreview.tierACounted}, Tier B {reactPreview.tierBCounted}
              </p>
              <ul className="text-saddle text-xs grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
                {reactPreview.names.map((n, i) => (
                  <li key={`${n}-${i}`}>• {n}</li>
                ))}
              </ul>
            </div>
          )}

          {reactPreview && reactPreview.names.length === 0 && !reactSent && (
            <div className="bg-bone border border-dust p-3 text-sm text-saddle">
              No eligible ranchers for a first touch right now.
            </div>
          )}

          {reactSent && (
            <div className="bg-bone border border-charcoal p-3 text-sm text-charcoal">
              ✓ Sent {reactSent.sent}, skipped {reactSent.skipped}.
            </div>
          )}
        </div>

        {/* Per-rancher table */}
        <div className="bg-white border border-dust overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bone border-b border-dust text-left text-xs uppercase tracking-wide text-saddle">
              <tr>
                <th className="px-3 py-2">Rancher</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Days Left</th>
                <th className="px-3 py-2">Sub</th>
                <th className="px-3 py-2">Connect</th>
                <th className="px-3 py-2">Invite Sent</th>
                <th className="px-3 py-2">Call Booked</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.ranchers.map((r) => {
                const badge = statusBadge(r.migrationStatus, r.pricingModel);
                const atRisk = r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 3 && r.pricingModel !== 'tier_v2';
                return (
                  <tr key={r.id} className={`border-b border-dust ${atRisk ? 'bg-amber/10' : ''}`}>
                    <td className="px-3 py-2 font-medium text-charcoal">{r.name}</td>
                    <td className="px-3 py-2 text-saddle">{r.state}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-xs px-2 py-1 border ${badge.color}`}>{badge.label}</span>
                    </td>
                    <td className="px-3 py-2 text-saddle">
                      {r.pricingModel === 'tier_v2' ? '—' : r.daysLeft === null ? '—' : r.daysLeft <= 0 ? <span className="text-weathered font-medium">OVERDUE</span> : `${r.daysLeft}d`}
                    </td>
                    <td className="px-3 py-2 text-saddle">{r.subscriptionStatus || '—'}</td>
                    <td className="px-3 py-2">
                      {r.connectStatus === 'active' ? (
                        <span className="text-xs px-2 py-0.5 border bg-sage/15 text-sage-dark border-sage">● active</span>
                      ) : r.connectStatus === 'onboarding' || r.connectStatus === 'restricted' ? (
                        <span className="text-xs px-2 py-0.5 border bg-amber/15 text-amber-dark border-amber-dark">○ {r.connectStatus}</span>
                      ) : (
                        <span className="text-saddle">{r.connectStatus || '—'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-saddle text-xs">{r.inviteSentAt ? new Date(r.inviteSentAt).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2 text-saddle text-xs">{r.callBookedAt ? new Date(r.callBookedAt).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2">
                      {r.pricingModel !== 'tier_v2' && (
                        <>
                          <button onClick={() => fireSingle(r.id)} className="text-xs underline text-charcoal hover:text-saddle">
                            {r.migrationStatus === 'not_invited' ? 'Send invite' : 'Re-send'}
                          </button>
                          <button
                            onClick={() => markLegacyConnect(r.id, r.name)}
                            className="text-xs underline text-charcoal hover:text-saddle ml-2"
                            title="Flag as Legacy Connect (Stripe Connect deposits, 10% commission, no monthly subscription)"
                          >
                            🪢 Legacy Connect
                          </button>
                        </>
                      )}
                      {/* Show Resync whenever a Connect account exists (even
                          with a blank status — fix 2026-06-13) OR there's a
                          recoverable status, as long as it isn't already
                          active. Hidden only when truly not-connected: no
                          account id AND no/empty/not_connected status. */}
                      {r.connectStatus !== 'active' &&
                        (r.connectAccountId ||
                          (r.connectStatus && r.connectStatus !== 'not_connected')) && (
                          <button
                            onClick={() => resyncConnect(r.id, r.name)}
                            className="text-xs underline text-saddle hover:text-saddle ml-2"
                            title="Force a live Stripe read + persist true Connect status. Unsticks 'onboarding' after the rancher has finished Stripe KYC."
                          >
                            🔄 Resync
                          </button>
                        )}
                      <a href={`/admin/ranchers/${r.id}`} className="text-xs underline text-charcoal hover:text-saddle ml-2">View</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-saddle">
          Highlighted yellow rows = ≤3 days to deadline. After deadline passes, the
          migration-deadline cron auto-flips Active Status to Paused and routing stops
          to that rancher until they complete the upgrade.
        </p>
      </div>
    </main>
  );
}
