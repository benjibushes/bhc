import { scoreFunnel } from '/Users/benji.bushes/BHC/untitled folder/bhc/app/components/funnel/funnelScore.ts';

const cases = [
  [{ tier: 'Half', timing: 'Within 30 days', storage: 'have_freezer', completed: true }, 100, 'full serious buyer'],
  [{ tier: 'Quarter', timing: 'Within 60 days', storage: 'need_freezer', completed: true }, 90, '1-3 months quarter still passes'],
  [{ tier: 'Whole', timing: 'Within 90 days', storage: 'rancher_holds', completed: true }, 85, '90-day whole passes'],
  [{ tier: 'Not Sure', timing: 'Just exploring', storage: 'have_freezer', completed: true }, 55, 'low-intent under 75'],
  [{ tier: 'Half', timing: 'Within 30 days', storage: 'have_freezer', completed: false }, 75, 'not completed loses ack but still 75'],
  [{ tier: 'Not Sure', timing: 'Just exploring', storage: '', completed: false }, 5, 'pure tire-kicker'],
];

let pass = 0;
for (const [a, exp, d] of cases) {
  const s = scoreFunnel(a);
  const ok = s === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${s} (exp ${exp}) ${d}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} passed`);
if (pass !== cases.length) process.exit(1);
