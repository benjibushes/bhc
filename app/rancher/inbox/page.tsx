'use client';

import { useEffect, useState } from 'react';

interface ThreadSummary {
  id: string;
  subject: string;
  lastMessageAt: string | null;
  lastMessage: string;
  lastSenderType: string;
  messageCount: number;
  unreadFromBuyer: boolean;
  buyerId: string | null;
  buyerName: string;
  status: string;
}

interface Message {
  id: string;
  'Sender Type': string;
  'Sender Id': string;
  Body: string;
  'Created At': string;
  'Sent Via': string;
}

export default function RancherInboxPage() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/rancher/inbox', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        setThreads(j.threads || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const open = async (id: string) => {
    setOpenId(id);
    setError('');
    try {
      const j = await fetch(`/api/threads/${id}/message`, { credentials: 'include' }).then((r) => r.json());
      setMessages(j.messages || []);
    } catch (e: any) {
      setError(e?.message || 'Load failed');
    }
  };

  const send = async () => {
    if (!openId || !draft.trim()) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch(`/api/threads/${openId}/message`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: draft }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j?.error || 'Send failed');
      } else {
        setDraft('');
        const refresh = await fetch(`/api/threads/${openId}/message`, { credentials: 'include' }).then((r) => r.json());
        setMessages(refresh.messages || []);
        // Refresh inbox list so the preview updates.
        const list = await fetch('/api/rancher/inbox', { credentials: 'include' }).then((r) => r.json());
        setThreads(list.threads || []);
      }
    } catch (e: any) {
      setError(e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="p-8 bg-bone min-h-screen text-charcoal">Loading inbox…</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-6 bg-bone min-h-screen text-charcoal">
      <aside className="md:col-span-1 border border-dust bg-white">
        <h2 className="p-3 border-b border-divider font-serif text-lg">Inbox</h2>
        {threads.length === 0 ? (
          <p className="p-4 text-saddle text-sm">
            No buyer messages yet. When a buyer asks a question through their referral page, it lands here.
          </p>
        ) : (
          threads.map((t) => (
            <button
              key={t.id}
              onClick={() => open(t.id)}
              className={`block w-full text-left p-3 border-b border-divider hover:bg-bone transition-colors ${openId === t.id ? 'bg-bone' : ''}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-sm">{t.buyerName || 'Buyer'}</span>
                {t.unreadFromBuyer && (
                  <span className="text-xs bg-charcoal text-bone px-2 py-0.5 uppercase tracking-wider">new</span>
                )}
              </div>
              <div className="text-xs text-saddle mb-1">
                {t.lastSenderType} · {t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleString() : ''}
              </div>
              <div className="text-sm text-saddle truncate">{t.lastMessage}</div>
            </button>
          ))
        )}
      </aside>

      <section className="md:col-span-2 border border-dust bg-white p-4">
        {openId ? (
          <>
            <div className="max-h-96 overflow-y-auto mb-4 border border-divider p-3 bg-bone">
              {messages.length === 0 ? (
                <p className="text-saddle text-sm">No messages yet.</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className="mb-3 border-b border-divider pb-2 last:border-b-0">
                    <div className="text-xs text-saddle uppercase tracking-wide">
                      {m['Sender Type']} · {new Date(m['Created At']).toLocaleString()}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm">{m.Body}</div>
                  </div>
                ))
              )}
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Reply to buyer…"
              className="w-full border border-dust p-2 min-h-24 bg-white text-charcoal"
              maxLength={5000}
            />
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={send}
                disabled={sending || !draft.trim()}
                className="px-6 py-2 bg-charcoal text-bone uppercase tracking-wider text-sm disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send Reply'}
              </button>
              <span className="text-saddle text-xs">{draft.length}/5000</span>
            </div>
            {error && <p className="text-red-700 mt-3 text-sm">{error}</p>}
          </>
        ) : (
          <p className="text-saddle">Pick a conversation on the left to open it.</p>
        )}
      </section>
    </div>
  );
}
