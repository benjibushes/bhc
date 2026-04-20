// US state normalization. The matching engine, bulk router, and waitlist blast
// all compare buyer state codes ("MT") against rancher state strings. If a
// rancher typed "Montana" (full name) instead of the 2-letter code, the
// comparison silently failed and waitlisted customers never got matched.
//
// Use normalizeState() and normalizeStates() everywhere a state string crosses
// a comparison boundary (saving to DB, querying, matching).

export type StateCode =
  | 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'FL' | 'GA'
  | 'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS' | 'KY' | 'LA' | 'ME' | 'MD'
  | 'MA' | 'MI' | 'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH' | 'NJ'
  | 'NM' | 'NY' | 'NC' | 'ND' | 'OH' | 'OK' | 'OR' | 'PA' | 'RI' | 'SC'
  | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' | 'WA' | 'WV' | 'WI' | 'WY' | 'DC';

export const US_STATES: { code: StateCode; name: string }[] = [
  { code: 'AL', name: 'Alabama' },        { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },        { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },     { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },    { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },        { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },         { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },       { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },           { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },       { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },          { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },      { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },       { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },       { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },     { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },           { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },         { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },   { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },   { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },          { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },        { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },     { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },      { code: 'WY', name: 'Wyoming' },
  { code: 'DC', name: 'District of Columbia' },
];

// Reverse lookup: full name (uppercase) → 2-letter code.
const NAME_TO_CODE: Record<string, StateCode> = US_STATES.reduce((acc, s) => {
  acc[s.name.toUpperCase()] = s.code;
  return acc;
}, {} as Record<string, StateCode>);

// Set of valid 2-letter codes for quick lookups.
const VALID_CODES = new Set<string>(US_STATES.map((s) => s.code));

/**
 * Normalize any state input to a 2-letter uppercase code.
 * Returns '' if the input doesn't map to a recognized US state.
 *
 *   normalizeState('MT')        -> 'MT'
 *   normalizeState('mt')        -> 'MT'
 *   normalizeState('Montana')   -> 'MT'
 *   normalizeState('montana')   -> 'MT'
 *   normalizeState('  MT  ')    -> 'MT'
 *   normalizeState('Bogusland') -> ''
 *   normalizeState('')          -> ''
 *   normalizeState(undefined)   -> ''
 */
export function normalizeState(input: unknown): string {
  if (!input) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (VALID_CODES.has(upper)) return upper;
  if (NAME_TO_CODE[upper]) return NAME_TO_CODE[upper];
  return '';
}

/**
 * Normalize a comma-separated string OR array of state inputs to a deduped
 * array of valid 2-letter codes. Drops anything that doesn't normalize.
 *
 *   normalizeStates('MT, Wyoming, ID')        -> ['MT', 'WY', 'ID']
 *   normalizeStates(['Texas', 'tx', 'BOGUS']) -> ['TX']
 *   normalizeStates('')                       -> []
 */
export function normalizeStates(input: unknown): string[] {
  if (!input) return [];
  const items: string[] = Array.isArray(input)
    ? input.map(String)
    : String(input).split(',').map((s) => s.trim());
  const out = new Set<string>();
  for (const item of items) {
    const code = normalizeState(item);
    if (code) out.add(code);
  }
  return Array.from(out);
}

/**
 * Joins normalized state codes back into the canonical comma-separated string
 * we store in Airtable's "States Served" multilineText field.
 *
 *   stringifyStates(['MT', 'WY']) -> 'MT, WY'
 */
export function stringifyStates(codes: string[]): string {
  return codes.join(', ');
}

/**
 * Friendly name for a code. Returns the code itself if not recognized.
 *   stateName('MT') -> 'Montana'
 *   stateName('XX') -> 'XX'
 */
export function stateName(code: string): string {
  const normalized = normalizeState(code);
  if (!normalized) return code;
  const found = US_STATES.find((s) => s.code === normalized);
  return found ? found.name : code;
}
