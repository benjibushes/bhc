'use client';

import { useEffect, useState } from 'react';
import Container from '../../components/Container';
import AdminAuthGuard from '../../components/AdminAuthGuard';

interface RancherRow {
  id: string;
  ranch_name: string;
  operator_name: string;
  state: string;
  page_live: boolean;
  pricing_model: string;
  collect_ready: boolean;
  collect_blockers: string[];
  page_complete: boolean;
  page_gaps: string[];
  page_polish: string[];
}

export default function PageReadinessScorecard() {
  const [rows, setRows] = useState<RancherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/ranchers');
        if (!res.ok) throw new Error('Failed to load ranchers');
        const data = await res.json();
        const live: RancherRow[] = (Array.isArray(data) ? data : []).filter((r: any) => r.page_live);
        // Worst-first: most gaps at top so you fix the half-baked pages first.
        live.sort(
          (a, b) =>
            (b.page_gaps?.length || 0) - (a.page_gaps?.length || 0) ||
            (a.ranch_name || '').localeCompare(b.ranch_name || ''),
        );
        setRows(live);
      } catch (e: any) {
        setError(e?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const total = rows.length;
  const pagesDone = rows.filter((r) => r.page_complete).length;
  const collectDone = rows.filter((r) => r.collect_ready).length;

  return (
    <AdminAuthGuard>
      <main className="min-h-screen bg-bone text-charcoal py-10">
        <Container>
          <div className="max-w-5xl mx-auto space-y-6">
            <header className="space-y-1">
              <h1 className="font-serif text-3xl">Marketplace page readiness</h1>
              <p className="text-sm text-dust">
                Every live listing + exactly what each page is missing. Drive the gaps to zero.
              </p>
            </header>

            {loading && <p className="text-dust">Loading…</p>}
            {error && <p className="text-rust">{error}</p>}

            {!loading && !error && (
              <>
                <div className="flex flex-wrap gap-3 text-sm">
                  <div className="border border-dust bg-bone px-4 py-3">
                    <span className="font-semibold text-lg">{pagesDone}/{total}</span> pages complete
                  </div>
                  <div className="border border-dust bg-bone px-4 py-3">
                    <span className="font-semibold text-lg">{collectDone}/{total}</span> collect-ready
                  </div>
                </div>

                <div className="overflow-x-auto border border-dust">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-bone-warm text-left text-xs uppercase tracking-widest text-dust">
                        <th className="p-3">Ranch</th>
                        <th className="p-3">State</th>
                        <th className="p-3">Page</th>
                        <th className="p-3">Collect</th>
                        <th className="p-3">Missing (fix these)</th>
                        <th className="p-3">Polish</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="border-t border-dust align-top">
                          <td className="p-3">
                            <a
                              href={`/admin/ranchers/${r.id}`}
                              className="underline underline-offset-2 hover:text-saddle"
                            >
                              {r.ranch_name || r.operator_name || r.id}
                            </a>
                          </td>
                          <td className="p-3 text-dust">{r.state || '—'}</td>
                          <td className="p-3">
                            {r.page_complete ? (
                              <span style={{ color: '#2E7D32' }}>✅</span>
                            ) : (
                              <span style={{ color: '#B45309' }}>🔴</span>
                            )}
                          </td>
                          <td className="p-3">
                            {r.collect_ready ? (
                              <span style={{ color: '#2E7D32' }}>✅</span>
                            ) : (
                              <span style={{ color: '#A7A29A' }} title={(r.collect_blockers || []).join(' · ')}>—</span>
                            )}
                          </td>
                          <td className="p-3 text-charcoal">
                            {r.page_gaps?.length ? r.page_gaps.join(', ') : <span className="text-dust">none</span>}
                          </td>
                          <td className="p-3 text-dust">
                            {r.page_polish?.length ? r.page_polish.join(', ') : 'none'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-xs text-dust">
                  Click a ranch to edit. &ldquo;Missing&rdquo; = pieces that make the page look half-baked
                  (logo, hero photo, price, about, tagline, certs). &ldquo;Polish&rdquo; = nice-to-haves
                  (FAQ, testimonials, video).
                </p>
              </>
            )}
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
