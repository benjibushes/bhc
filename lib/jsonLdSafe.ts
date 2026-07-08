// lib/jsonLdSafe.ts
//
// JSON-LD <script> injection guard (audit 2026-07-07). JSON.stringify does
// NOT escape the '<' character, so rancher-entered text (product Description,
// ranch name, FAQ answers) containing a closing script tag would break out of
// the JSON-LD block and execute — stored XSS on the exact pages ads land on.
// Escaping '<' as the < JSON escape is the standard fix: byte-identical
// JSON semantics, impossible to close the script tag. Use this for EVERY
// dangerouslySetInnerHTML JSON-LD emission.

export function jsonLdSafe(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}
