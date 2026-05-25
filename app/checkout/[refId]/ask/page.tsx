'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';

interface Message {
  id: string;
  'Sender Type': string;
  'Sender Id': string;
  Body: string;
  'Created At': string;
  'Sent Via': string;
}

export default function AskPage() {
  const params = useParams<{ refId: string }>();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [rancherName, setRancherName] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/threads/by-referral/${params.refId}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
        } else {
          setThreadId(j.threadId);
          setMessages(j.messages || []);
          setRancherName(j.rancherName || 'your rancher');
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || 'Load failed');
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [params.refId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    if (!threadId || !draft.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/threads/${threadId}/message`, {
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
        const refresh = await fetch(`/api/threads/${threadId}/message`, { credentials: 'include' }).then((r) => r.json());
        setMessages(refresh.messages || []);
      }
    } catch (e: any) {
      setError(e?.message || 'Send failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!loaded) {
    return <div className="p-8 bg-bone min-h-screen text-charcoal">Loading…</div>;
  }
  if (error && !threadId) {
    return (
      <div className="p-8 bg-bone min-h-screen text-charcoal">
        <h1 className="text-2xl font-serif mb-4">Ask your rancher</h1>
        <p className="text-saddle">{error}</p>
        <p className="text-saddle text-sm mt-4">
          If this looks wrong, <a href="/member" className="underline">go to your dashboard</a> and pick the referral you want to discuss.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 bg-bone min-h-screen text-charcoal">
      <header className="mb-4">
        <h1 className="text-2xl font-serif">Ask {rancherName}</h1>
        <p className="text-saddle text-sm mt-1">
          Questions before you commit? Send a message — your rancher gets it by email + dashboard. Reply lands here.
        </p>
      </header>

      <div className="border border-dust bg-white p-4 max-h-96 overflow-y-auto mb-4">
        {messages.length === 0 ? (
          <p className="text-saddle text-sm">No messages yet. Start the conversation below.</p>
        ) : (
          messages.map((m) => {
            const isBuyer = m['Sender Type'] === 'buyer';
            return (
              <div
                key={m.id}
                className={`mb-3 border-b border-divider pb-2 ${isBuyer ? '' : ''}`}
              >
                <div className="text-xs text-saddle uppercase tracking-wide">
                  {m['Sender Type']} · {new Date(m['Created At']).toLocaleString()}
                </div>
                <div className="mt-1 whitespace-pre-wrap">{m.Body}</div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={`e.g. Can you do a half cow processed by Aug 15?`}
        className="w-full border border-dust p-3 min-h-32 bg-white text-charcoal"
        maxLength={5000}
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={send}
          disabled={submitting || !draft.trim()}
          className="px-6 py-3 bg-charcoal text-bone uppercase tracking-wider text-sm disabled:opacity-50"
        >
          {submitting ? 'Sending…' : 'Send Message'}
        </button>
        <span className="text-saddle text-xs">{draft.length}/5000</span>
      </div>
      {error && <p className="text-red-700 mt-3 text-sm">{error}</p>}
    </div>
  );
}
