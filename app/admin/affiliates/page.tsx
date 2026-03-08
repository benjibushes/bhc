'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';

interface Affiliate {
  id: string;
  name: string;
  email: string;
  code: string;
  status: string;
  created_at: string;
}

export default function AdminAffiliatesPage() {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', code: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/affiliates')
      .then((res) => res.json())
      .then((data) => {
        setAffiliates(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/admin/affiliates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create');
      setAffiliates((prev) => [...prev, data.affiliate]);
      setForm({ name: '', email: '', code: '' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create affiliate');
    } finally {
      setCreating(false);
    }
  };

  const handleSendInvite = async (id: string) => {
    setSending(id);
    try {
      const res = await fetch(`/api/admin/affiliates/${id}/send-invite`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      alert('Invite sent!');
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to send invite');
    } finally {
      setSending(null);
    }
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <p className="text-lg text-[#6B4F3F] text-center">Loading...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="space-y-8">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  Affiliates
                </h1>
                <p className="text-sm text-[#6B4F3F] mt-2">
                  Invite-only brand promoters. Create affiliates and send them their links.
                </p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
              >
                &larr; Back
              </Link>
            </div>

            <Divider />

            <div className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h3 className="font-[family-name:var(--font-serif)] text-xl">Create Affiliate</h3>
              <form onSubmit={handleCreate} className="grid gap-4 md:grid-cols-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Jane Doe"
                    required
                    className="w-full px-4 py-2 border border-[#A7A29A] bg-[#F4F1EC]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="jane@example.com"
                    required
                    className="w-full px-4 py-2 border border-[#A7A29A] bg-[#F4F1EC]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Code (unique slug)</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                    placeholder="jane-d"
                    required
                    className="w-full px-4 py-2 border border-[#A7A29A] bg-[#F4F1EC]"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={creating}
                    className="px-6 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium hover:bg-[#2A2A2A] disabled:opacity-50"
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </form>
              {error && (
                <p className="text-sm text-[#8C2F2F]">{error}</p>
              )}
            </div>

            <div className="p-6 border border-[#A7A29A] bg-white">
              <h3 className="font-[family-name:var(--font-serif)] text-xl mb-4">Affiliate List</h3>
              {affiliates.length === 0 ? (
                <p className="text-[#6B4F3F]">No affiliates yet. Create one above.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#A7A29A]">
                        <th className="text-left py-2">Name</th>
                        <th className="text-left py-2">Email</th>
                        <th className="text-left py-2">Code</th>
                        <th className="text-left py-2">Status</th>
                        <th className="text-left py-2">Created</th>
                        <th className="text-left py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {affiliates.map((a) => (
                        <tr key={a.id} className="border-b border-[#A7A29A]/50">
                          <td className="py-3">{a.name}</td>
                          <td className="py-3">{a.email}</td>
                          <td className="py-3">
                            <code className="bg-[#F4F1EC] px-2 py-0.5">{a.code}</code>
                          </td>
                          <td className="py-3">{a.status}</td>
                          <td className="py-3 text-[#6B4F3F]">
                            {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                          </td>
                          <td className="py-3">
                            <button
                              type="button"
                              onClick={() => handleSendInvite(a.id)}
                              disabled={sending === a.id}
                              className="text-[#6B4F3F] hover:text-[#0E0E0E] text-sm disabled:opacity-50"
                            >
                              {sending === a.id ? 'Sending...' : 'Send invite'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
