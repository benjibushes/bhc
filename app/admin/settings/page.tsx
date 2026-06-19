'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminAuthGuard from '@/app/components/AdminAuthGuard';
import Container from '@/app/components/Container';
import Divider from '@/app/components/Divider';
import { toast } from '@/lib/toast';
import type { AdminConfig } from '@/lib/adminConfigTypes';
import { ADMIN_CONFIG_DEFAULTS } from '@/lib/adminConfigTypes';

// ── Field metadata ─────────────────────────────────────────────────────────
interface FieldMeta {
  key: keyof AdminConfig;
  label: string;
  description: string;
  type?: 'number' | 'toggle';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}

const FIELDS: FieldMeta[] = [
  {
    key: 'stallThresholdDays',
    label: 'Stall Threshold',
    description:
      'Days after intro is sent before a referral with no rancher activity is flagged as stalled on the Desk and Today views.',
    unit: 'days',
    min: 1,
    max: 30,
    step: 1,
  },
  {
    key: 'highIntentCutoff',
    label: 'High-Intent Cutoff',
    description:
      'Minimum Intent Score (0–100) for a buyer to appear in the "High Intent Waiting" list on the Desk. Raise to tighten the funnel; lower to catch more buyers.',
    unit: 'score',
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: 'migrationDeadlineDays',
    label: 'Migration Deadline',
    description:
      'Days until the v2 migration deadline. Drives the urgency banner shown to legacy ranchers who have not yet completed onboarding.',
    unit: 'days',
    min: 0,
    max: 365,
    step: 1,
  },
  {
    key: 'capacityWarningPct',
    label: 'Capacity Warning Threshold',
    description:
      'When a rancher fills this percentage of their max active referrals, they appear in the capacity-warning list.',
    unit: '%',
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'funnelOfferOperatorCall',
    label: 'Offer "book a call with Ben" in the funnel',
    description:
      'When on, the buyer funnel\'s final step offers an inline call booking with you instead of "your rancher reaches out". Flip this on the day you start taking sales calls — takes effect live, no deploy.',
    type: 'toggle',
  },
];

// ── Page ──────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [draft, setDraft] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Track which fields were modified vs server state
  const isDirty =
    draft !== null &&
    config !== null &&
    FIELDS.some((f) => draft[f.key] !== config[f.key]);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/config');
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const j = await res.json();
      const cfg: AdminConfig = { ...ADMIN_CONFIG_DEFAULTS, ...j.config };
      setConfig(cfg);
      setDraft(cfg);
    } catch (err: any) {
      const msg = err?.message || 'Failed to load config';
      setLoadError(msg);
      // Still show defaults so the form is usable
      const fallback = { ...ADMIN_CONFIG_DEFAULTS };
      setConfig(fallback);
      setDraft(fallback);
      toast.error('Could not load saved config — showing defaults', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (key: keyof AdminConfig, raw: string) => {
    const num = Number(raw);
    if (!draft) return;
    setDraft((prev) => (prev ? { ...prev, [key]: isNaN(num) ? prev[key] : num } : prev));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      const saved: AdminConfig = { ...ADMIN_CONFIG_DEFAULTS, ...j.config };
      setConfig(saved);
      setDraft(saved);
      toast.success('Config saved');
    } catch (err: any) {
      toast.error('Save failed', err?.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!config) return;
    setDraft({ ...config });
  };

  const handleRestoreDefaults = () => {
    setDraft({ ...ADMIN_CONFIG_DEFAULTS });
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-center text-saddle">Loading config…</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-bone text-charcoal">
        <Container>
          <div className="space-y-8 max-w-2xl">

            {/* Header */}
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  Operator Config
                </h1>
                <p className="text-sm text-saddle mt-2">
                  Platform-wide knobs. Changes take effect on the next request.
                </p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                &larr; Back to Dashboard
              </Link>
            </div>

            <Divider />

            {/* Load error banner */}
            {loadError && (
              <div className="px-4 py-3 border border-weathered bg-weathered/10 text-weathered text-sm">
                <strong>Warning:</strong> Could not read saved config from Airtable ({loadError}).
                Showing defaults. You can still edit and save — this will create the config table
                rows.
              </div>
            )}

            {/* Config form */}
            {draft && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSave();
                }}
                className="space-y-6"
              >
                {FIELDS.map((field) => {
                  const current = draft[field.key];
                  const defaultVal = ADMIN_CONFIG_DEFAULTS[field.key];
                  const isChanged = config ? current !== config[field.key] : false;
                  const isDifferentFromDefault = current !== defaultVal;

                  return (
                    <div key={field.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <label
                          htmlFor={field.key}
                          className="text-sm font-medium text-charcoal"
                        >
                          {field.label}
                          {isChanged && (
                            <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-amber/20 text-amber-dark border border-amber/50 rounded">
                              unsaved
                            </span>
                          )}
                        </label>
                        {isDifferentFromDefault && (
                          <button
                            type="button"
                            onClick={() =>
                              setDraft((prev) =>
                                prev ? { ...prev, [field.key]: defaultVal } : prev,
                              )
                            }
                            className="text-xs text-saddle underline hover:text-charcoal"
                          >
                            Reset to default ({String(defaultVal)})
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-saddle leading-relaxed">{field.description}</p>
                      {field.type === 'toggle' ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={current === true}
                          onClick={() =>
                            setDraft((prev) => (prev ? { ...prev, [field.key]: !prev[field.key] } : prev))
                          }
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            current ? 'bg-charcoal' : 'bg-dust'
                          }`}
                        >
                          <span
                            className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                              current ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      ) : (
                        <div className="flex items-center gap-3">
                          <input
                            id={field.key}
                            type="number"
                            value={current as number}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            onChange={(e) => handleChange(field.key, e.target.value)}
                            className="w-32 px-3 py-2 border border-dust bg-white text-charcoal focus:border-charcoal focus:outline-none text-sm"
                          />
                          <span className="text-sm text-saddle">{field.unit}</span>
                          <span className="text-xs text-dust">(default: {String(defaultVal)})</span>
                        </div>
                      )}
                    </div>
                  );
                })}

                <Divider />

                {/* Action bar */}
                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    disabled={saving || !isDirty}
                    className="px-6 py-2.5 bg-charcoal text-bone text-sm font-medium hover:bg-charcoal/80 disabled:opacity-40 transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                  {isDirty && (
                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={saving}
                      className="px-5 py-2.5 border border-dust text-sm text-charcoal hover:bg-dust/20 disabled:opacity-40 transition-colors"
                    >
                      Discard Changes
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleRestoreDefaults}
                    disabled={saving}
                    className="px-5 py-2.5 border border-saddle text-saddle text-sm hover:bg-saddle/10 disabled:opacity-40 transition-colors"
                  >
                    Restore All Defaults
                  </button>
                </div>
              </form>
            )}

            {/* Info footer */}
            <div className="pt-4 border-t border-dust/50">
              <p className="text-xs text-saddle">
                Config is stored in the Airtable &ldquo;Admin Config&rdquo; table (key / value rows).
                If the table does not exist, defaults are used and saved values will create the rows.
                Changes apply to the next server request — no deployment needed.
              </p>
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
