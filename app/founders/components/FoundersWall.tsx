import { getAllRecords, TABLES } from '@/lib/airtable';
import { FOUNDING_100_CAP, TITLE_FOUNDER_CAP } from '@/lib/secrets';

// Founders Wall — server component. Renders the 5 tier sections per spec:
//   1. Title Founder (10 spots) — featured at the top, name/logo treatment.
//   2. Founding 100 (100 spots) — numbered grid 1–100 with progress bar.
//   3. Steward — alphabetical list.
//   4. Outlaw — alphabetical list (only rows with Wall Opt-In = true).
//   5. Herd — NOT publicly displayed by default; opt-in only.
//
// Source of truth is the Consumers table. We only render rows that are paid
// (have a Founder Tier set + Founder Welcome Sent At populated, which acts
// as our "row is live" gate after the webhook finishes its retry-safe path).
//
// Test rows (FOUNDERS_TEST_MODE / `tier=test-1` purchases) are best-effort
// filtered out by checking the tier amount against expected price floors so
// that smoke-tests during launch don't pollute the wall.

type ConsumerRow = {
  id: string;
  'Full Name'?: string;
  Email?: string;
  'Founder Tier'?: string;
  'Founder Number'?: number;
  'Tier Amount Paid'?: number;
  'Wall Opt-In'?: boolean;
  'Founder Welcome Sent At'?: string;
  'Backer Type'?: string;
  // Brand backers may have a logo on a future iteration; left as a passthrough.
  'Brand Logo URL'?: string;
};

function displayName(row: ConsumerRow): string {
  const full = (row['Full Name'] || '').toString().trim();
  if (full) return full;
  const email = (row['Email'] || '').toString().trim();
  if (email) return email.split('@')[0];
  return 'Anonymous Founder';
}

function isLiveBacker(row: ConsumerRow): boolean {
  // Only show rows the webhook fully completed. `Founder Welcome Sent At` is
  // set LAST in the webhook flow, so its presence guarantees the row is
  // through every step.
  if (!row['Founder Welcome Sent At']) return false;
  if (!row['Founder Tier']) return false;
  return true;
}

function isTestRow(row: ConsumerRow): boolean {
  // $1 verification charges for FOUNDERS_TEST_MODE. Cheap heuristic: paid <$10
  // and tier is Founding 100.
  const amt = row['Tier Amount Paid'] || 0;
  return row['Founder Tier'] === 'Founding 100' && amt < 10;
}

export default async function FoundersWall() {
  let rows: ConsumerRow[] = [];
  try {
    const all = (await getAllRecords(
      TABLES.CONSUMERS,
      // Only pull rows with a Founder Tier set — keeps the result small and
      // avoids scanning the whole 1k+ buyer list.
      `NOT({Founder Tier} = '')`
    )) as any[];
    rows = all.map((r: any) => ({ id: r.id, ...r }));
  } catch (e) {
    console.error('FoundersWall: failed to load consumers', e);
  }

  const live = rows.filter(isLiveBacker).filter((r) => !isTestRow(r));
  const titleFounders = live
    .filter((r) => r['Founder Tier'] === 'Title Founder')
    .sort(
      (a, b) =>
        (a['Founder Number'] || 999) - (b['Founder Number'] || 999) ||
        displayName(a).localeCompare(displayName(b))
    );
  const founding100 = live
    .filter((r) => r['Founder Tier'] === 'Founding 100')
    .sort((a, b) => (a['Founder Number'] || 999) - (b['Founder Number'] || 999));
  const stewards = live
    .filter((r) => r['Founder Tier'] === 'Steward')
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const outlaws = live
    .filter((r) => r['Founder Tier'] === 'Outlaw' && r['Wall Opt-In'])
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const optedInHerd = live
    .filter((r) => r['Founder Tier'] === 'Herd' && r['Wall Opt-In'])
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  const founding100Filled = founding100.length;
  const founding100Pct = Math.min(
    100,
    Math.round((founding100Filled / FOUNDING_100_CAP) * 100)
  );

  return (
    <section className="space-y-16">
      <div className="text-center space-y-3">
        <p className="text-sm uppercase tracking-widest text-saddle">
          The Founders Wall
        </p>
        <h2 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
          The names that started this
        </h2>
        <p className="text-saddle max-w-2xl mx-auto leading-relaxed">
          Every name on this wall paid in before the company was easy to bet
          on. They are the proof. They are the reason this works.
        </p>
      </div>

      {/* Title Founder */}
      <div className="space-y-6">
        <div className="flex items-baseline justify-between border-b border-dust pb-3">
          <h3 className="font-[family-name:var(--font-playfair)] text-2xl">
            Title Founder
          </h3>
          <p className="text-sm text-saddle">
            {titleFounders.length} of {TITLE_FOUNDER_CAP} claimed
          </p>
        </div>
        {titleFounders.length === 0 ? (
          <p className="text-dust italic">
            10 spots open. Will be the first 10 names listed here.
          </p>
        ) : (
          <ul className="grid md:grid-cols-2 gap-4">
            {titleFounders.map((r) => (
              <li
                key={r.id}
                className="border border-charcoal bg-white p-6 flex items-baseline gap-4"
              >
                <span className="font-[family-name:var(--font-playfair)] text-3xl text-saddle">
                  {r['Founder Number'] ?? '—'}
                </span>
                <span className="text-lg">{displayName(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Founding 100 — numbered grid + progress */}
      <div className="space-y-6">
        <div className="flex items-baseline justify-between border-b border-dust pb-3">
          <h3 className="font-[family-name:var(--font-playfair)] text-2xl">
            Founding 100
          </h3>
          <p className="text-sm text-saddle">
            {founding100Filled} of {FOUNDING_100_CAP} claimed
          </p>
        </div>
        <div className="w-full h-2 bg-bone-deep">
          <div
            className="h-2 bg-charcoal transition-all"
            style={{ width: `${founding100Pct}%` }}
            aria-label={`Founding 100 progress: ${founding100Filled} of ${FOUNDING_100_CAP}`}
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-10 gap-2 text-xs">
          {Array.from({ length: FOUNDING_100_CAP }).map((_, i) => {
            const n = i + 1;
            const claimed = founding100.find((r) => r['Founder Number'] === n);
            return (
              <div
                key={n}
                className={`aspect-square flex flex-col items-center justify-center border ${
                  claimed
                    ? 'border-charcoal bg-white'
                    : 'border-dashed border-dust bg-bone'
                }`}
                title={claimed ? displayName(claimed) : `Spot #${n} — open`}
              >
                <span className="text-[10px] text-dust">#{n}</span>
                {claimed && (
                  <span className="text-[10px] mt-1 px-1 truncate max-w-full">
                    {displayName(claimed).split(' ')[0]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Steward */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between border-b border-dust pb-3">
          <h3 className="font-[family-name:var(--font-playfair)] text-2xl">
            Steward
          </h3>
          <p className="text-sm text-saddle">{stewards.length} backers</p>
        </div>
        {stewards.length === 0 ? (
          <p className="text-dust italic">No Stewards yet.</p>
        ) : (
          <ul className="grid sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {stewards.map((r) => (
              <li key={r.id} className="bg-white border border-dust px-4 py-3">
                {displayName(r)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Outlaw */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between border-b border-dust pb-3">
          <h3 className="font-[family-name:var(--font-playfair)] text-2xl">
            Outlaw
          </h3>
          <p className="text-sm text-saddle">{outlaws.length} on the wall</p>
        </div>
        {outlaws.length === 0 ? (
          <p className="text-dust italic">
            No public Outlaws yet. Wall placement is opt-in at checkout.
          </p>
        ) : (
          <ul className="grid sm:grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {outlaws.map((r) => (
              <li key={r.id} className="bg-white border border-dust px-3 py-2">
                {displayName(r)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Herd (opt-in only — section hides entirely if nobody opted in) */}
      {optedInHerd.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between border-b border-dust pb-3">
            <h3 className="font-[family-name:var(--font-playfair)] text-2xl">
              Herd
            </h3>
            <p className="text-sm text-saddle">
              {optedInHerd.length} opted in
            </p>
          </div>
          <p className="text-xs text-dust">
            Herd-tier names show only if the backer opted in at checkout.
          </p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {optedInHerd.map((r) => (
              <li
                key={r.id}
                className="bg-bone border border-dust px-3 py-1"
              >
                {displayName(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
