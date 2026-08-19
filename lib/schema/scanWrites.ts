// ─────────────────────────────────────────────────────────────────────────
// STATIC SCANNER — "what can this codebase write to Airtable?"
//
// Walks the TypeScript AST of every source file and pulls out, for each
// createRecord / updateRecord / registered-wrapper call:
//   - which TABLE it targets (resolving TABLES.X, local aliases, and table
//     constants imported from another module)
//   - every FIELD NAME in the payload
//   - every string LITERAL that field can be set to
// tools/schema-guard.ts then checks all of that against the committed
// snapshot of the real base.
//
// TOOL-ONLY MODULE. It imports `typescript` (a devDependency) and must never
// be imported from app/ — nothing in the request path may depend on it.
//
// Deliberately conservative on two axes:
//   1. Anything it cannot resolve is REPORTED as unresolved, never guessed.
//      `--coverage` prints the blind spots so nobody mistakes silence for
//      safety.
//   2. Identifier resolution is LEXICALLY SCOPED. The first cut indexed every
//      `const fields = {...}` in a file into one last-wins map, which
//      attributed a Consumers payload to a Ranchers call in another function
//      and invented five findings. A guard that invents findings gets muted.
// ─────────────────────────────────────────────────────────────────────────

import ts from 'typescript';

export interface WriteHelperSpec {
  /** The table this helper always writes to. */
  readonly table: string;
  /** Zero-based index of the fields-object argument. */
  readonly payloadArg: number;
}

export interface ScanContext {
  /** TABLES const from lib/airtable.ts: { REFERRALS: 'Referrals', ... }. */
  readonly tables: Readonly<Record<string, string>>;
  /** Named wrappers that write to a fixed table. */
  readonly writeHelpers: Readonly<Record<string, WriteHelperSpec>>;
  /**
   * Pure functions that BUILD a payload for a fixed table and are handed
   * straight to createRecord/updateRecord. Registering one lets the scanner
   * check the object literal the function returns, which is otherwise opaque
   * at the call site. name -> table.
   */
  readonly payloadBuilders?: Readonly<Record<string, string>>;
  /**
   * Exported string constants from every module, keyed `modulePath#exportName`
   * (module path repo-relative, no extension). More than one value = the name
   * is ambiguous and stays unresolved.
   */
  readonly externalConstants?: Readonly<Record<string, readonly string[]>>;
}

export interface ScannedField {
  readonly name: string;
  readonly line: number;
  /** Every string literal this property can hold. Empty = dynamic. */
  readonly values: string[];
}

export interface WriteSite {
  readonly file: string;
  /** 1-based line of the call. */
  readonly line: number;
  readonly callee: string;
  /** Resolved table name, or null when the argument is dynamic. */
  readonly table: string | null;
  readonly fields: ScannedField[];
  /** table AND payload both resolved. */
  readonly resolved: boolean;
  /** Payload partly opaque (an unresolvable spread) — findings are a subset. */
  readonly partial: boolean;
  /** Human-readable why, when !resolved. */
  readonly unresolvedReason?: string;
}

const DIRECT_WRITERS: Record<string, { tableArg: number; payloadArg: number }> = {
  createRecord: { tableArg: 0, payloadArg: 1 },
  updateRecord: { tableArg: 0, payloadArg: 2 },
};

function calleeName(node: ts.CallExpression): string | null {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) { n = n.expression; continue; }
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) { n = n.expression; continue; }
    if (ts.isNonNullExpression(n)) { n = n.expression; continue; }
    return n;
  }
}

/** Statement list of a lexical scope, if this node introduces one. */
function scopeStatements(node: ts.Node): readonly ts.Statement[] | null {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return null;
}

/**
 * Nearest lexically-visible `const NAME = <init>`, walking outwards from the
 * use site. Returns the initializer, or null.
 *
 * `const` ONLY. A `let` initializer is not what gets written — `let stage = '';
 * if (x) stage = 'day3_sent';` would otherwise be read as an empty-select
 * write that the code can never actually perform. An unresolvable `let` shows
 * up in --coverage, which is the honest outcome.
 */
function resolveDeclaration(name: string, from: ts.Node): ts.Expression | null {
  let cursor: ts.Node | undefined = from;
  while (cursor) {
    const statements = scopeStatements(cursor);
    if (statements) {
      for (const stmt of statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
        }
      }
    }
    cursor = cursor.parent;
  }
  return null;
}

/** Repo-relative module path (no extension) for an import specifier. */
export function resolveModulePath(specifier: string, fromFile: string): string | null {
  const strip = (p: string) => p.replace(/\.(tsx?|jsx?)$/, '');
  if (specifier.startsWith('@/')) return strip(specifier.slice(2));
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    const parts = (dir ? `${dir}/${specifier}` : specifier).split('/');
    const out: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') { out.pop(); continue; }
      out.push(part);
    }
    return strip(out.join('/'));
  }
  return null; // bare package import — never a table constant of ours
}

interface FileImports {
  /** local name → `modulePath#exportedName` */
  readonly bindings: ReadonlyMap<string, string>;
}

function collectImports(sf: ts.SourceFile, file: string): FileImports {
  const bindings = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = resolveModulePath(stmt.moduleSpecifier.text, file);
    if (!mod) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const exported = (el.propertyName ?? el.name).text;
      bindings.set(el.name.text, `${mod}#${exported}`);
    }
  }
  return { bindings };
}

interface Resolver {
  readonly ctx: ScanContext;
  readonly imports: FileImports;
  readonly sf: ts.SourceFile;
}

/** Values an imported constant can hold; null when unknown or ambiguous. */
function importedValues(name: string, r: Resolver): readonly string[] | null {
  const key = r.imports.bindings.get(name);
  if (!key) return null;
  const values = r.ctx.externalConstants?.[key];
  if (!values || values.length !== 1) return null;
  return values;
}

/** Every string literal an expression can evaluate to. Empty = give up. */
function literalValues(node: ts.Expression, from: ts.Node, r: Resolver, depth = 0): string[] {
  if (depth > 6) return [];
  const n = unwrap(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isConditionalExpression(n)) {
    return [...literalValues(n.whenTrue, from, r, depth + 1), ...literalValues(n.whenFalse, from, r, depth + 1)];
  }
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind;
    if (k === ts.SyntaxKind.BarBarToken) {
      // `x || null` is the canonical "clear the select" idiom: '' can never
      // survive a ||, so counting it would report a phantom EMPTY SELECT.
      const left = literalValues(n.left, from, r, depth + 1).filter((v) => v !== '');
      return [...left, ...literalValues(n.right, from, r, depth + 1)];
    }
    if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [...literalValues(n.left, from, r, depth + 1), ...literalValues(n.right, from, r, depth + 1)];
    }
    return [];
  }
  if (ts.isArrayLiteralExpression(n)) {
    return n.elements.flatMap((el) => (ts.isSpreadElement(el) ? [] : literalValues(el as ts.Expression, from, r, depth + 1)));
  }
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'TABLES' && ts.isIdentifier(n.name)) {
    const v = r.ctx.tables[n.name.text];
    return v ? [v] : [];
  }
  if (ts.isIdentifier(n)) {
    const decl = resolveDeclaration(n.text, from);
    if (decl) return literalValues(decl, decl, r, depth + 1);
    const imported = importedValues(n.text, r);
    return imported ? [...imported] : [];
  }
  // MAP[key] / MAP.key over a const object literal. A dynamic key
  // over-approximates to every value the map holds — which is exactly right
  // for a guard: any of them can reach Airtable. This is the path that minted
  // 'Half Cow' / 'Quarter Cow' into Consumers.Order Type.
  if (ts.isElementAccessExpression(n) || ts.isPropertyAccessExpression(n)) {
    const objNode = ts.isIdentifier(n.expression) ? resolveDeclaration(n.expression.text, from) : null;
    if (objNode && ts.isObjectLiteralExpression(unwrap(objNode))) {
      const obj = unwrap(objNode) as ts.ObjectLiteralExpression;
      const wanted = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : (() => {
            const k = literalValues(n.argumentExpression, from, r, depth + 1);
            return k.length === 1 ? k[0] : null;
          })();
      const out: string[] = [];
      for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        if (wanted !== null && key !== wanted) continue;
        out.push(...literalValues(p.initializer, objNode, r, depth + 1));
      }
      return out;
    }
  }
  return [];
}

function propertyName(
  prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  from: ts.Node,
  r: Resolver,
): string | null {
  const name = prop.name;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const vals = literalValues(name.expression, from, r);
    return vals.length === 1 ? vals[0] : null;
  }
  return null;
}

interface Collected { fields: ScannedField[]; partial: boolean }

function collectFields(
  node: ts.Expression | undefined,
  from: ts.Node,
  r: Resolver,
  depth = 0,
): Collected | null {
  if (!node || depth > 6) return null;
  const n = unwrap(node);

  if (ts.isIdentifier(n)) {
    const decl = resolveDeclaration(n.text, from);
    return decl ? collectFields(decl, decl, r, depth + 1) : null;
  }
  if (ts.isConditionalExpression(n)) {
    const a = collectFields(n.whenTrue, from, r, depth + 1);
    const b = collectFields(n.whenFalse, from, r, depth + 1);
    if (!a && !b) return null;
    return {
      fields: [...(a?.fields ?? []), ...(b?.fields ?? [])],
      partial: (a?.partial ?? true) || (b?.partial ?? true),
    };
  }
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    // `flag && { ... }` — the left side is a condition, not a payload, so its
    // absence is not "partial".
    const a = collectFields(n.left, from, r, depth + 1);
    const b = collectFields(n.right, from, r, depth + 1);
    if (!a && !b) return null;
    return { fields: [...(a?.fields ?? []), ...(b?.fields ?? [])], partial: (a?.partial ?? false) || (b?.partial ?? false) };
  }
  if (!ts.isObjectLiteralExpression(n)) return null;

  const fields: ScannedField[] = [];
  let partial = false;

  for (const prop of n.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const inner = collectFields(prop.expression, from, r, depth + 1);
      if (inner) { fields.push(...inner.fields); partial = partial || inner.partial; }
      else partial = true;
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      const name = propertyName(prop, from, r);
      if (!name) { partial = true; continue; }
      fields.push({
        name,
        line: r.sf.getLineAndCharacterOfPosition(prop.getStart(r.sf)).line + 1,
        values: literalValues(prop.initializer, from, r),
      });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = propertyName(prop, from, r);
      if (!name) { partial = true; continue; }
      fields.push({ name, line: r.sf.getLineAndCharacterOfPosition(prop.getStart(r.sf)).line + 1, values: [] });
      continue;
    }
    partial = true; // getter/setter/method — not an Airtable payload shape
  }

  return { fields, partial };
}

/**
 * Parse a file and return every Airtable write it performs.
 * Pure: takes source text, returns findings. No fs, no network.
 */
export function scanSource(file: string, source: string, ctx: ScanContext): WriteSite[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const r: Resolver = { ctx, imports: collectImports(sf, file), sf };
  const sites: WriteSite[] = [];

  const resolveTable = (arg: ts.Expression | undefined, from: ts.Node): string | null => {
    if (!arg) return null;
    const values = literalValues(arg, from, r);
    return values.length === 1 ? values[0] : null;
  };

  // "payload is not a resolvable object literal (built by refundReferralClearFields)"
  // — names the builder so a blind spot is actionable, not just admitted.
  const describePayload = (arg: ts.Expression | undefined, from: ts.Node): string => {
    if (!arg) return '';
    let n: ts.Expression | null = unwrap(arg);
    if (ts.isIdentifier(n)) n = resolveDeclaration(n.text, from);
    if (n && ts.isCallExpression(n)) {
      const callee = calleeName(n);
      if (callee) return ` (built by ${callee}())`;
    }
    return '';
  };

  // Registered payload builders: check the object literal they RETURN.
  const builders = ctx.payloadBuilders ?? {};
  if (Object.keys(builders).length) {
    const walkBuilders = (node: ts.Node): void => {
      let name: string | null = null;
      let body: ts.Node | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; body = node.body; }
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
               (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        name = node.name.text; body = node.initializer.body;
      }
      const table = name ? builders[name] : undefined;
      if (name && table && body) {
        const returns: ts.Expression[] = [];
        if (ts.isExpression(body as ts.Node)) returns.push(body as ts.Expression);
        else {
          const findReturns = (n2: ts.Node): void => {
            if (ts.isFunctionDeclaration(n2) || ts.isFunctionExpression(n2) || ts.isArrowFunction(n2)) {
              if (n2 !== body && n2.parent !== node) return; // don't descend into nested closures
            }
            if (ts.isReturnStatement(n2) && n2.expression) returns.push(n2.expression);
            ts.forEachChild(n2, findReturns);
          };
          ts.forEachChild(body, findReturns);
        }
        for (const ret of returns) {
          const collected = collectFields(ret, ret, r);
          if (!collected) continue;
          sites.push({
            file,
            line: sf.getLineAndCharacterOfPosition(ret.getStart(sf)).line + 1,
            callee: name,
            table,
            fields: collected.fields,
            resolved: true,
            partial: collected.partial,
          });
        }
      }
      ts.forEachChild(node, walkBuilders);
    };
    walkBuilders(sf);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const direct = name ? DIRECT_WRITERS[name] : undefined;
      const helper = name ? ctx.writeHelpers[name] : undefined;
      if (name && (direct || helper)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const table = direct ? resolveTable(node.arguments[direct.tableArg], node) : helper!.table;
        const payloadIdx = direct ? direct.payloadArg : helper!.payloadArg;
        const collected = collectFields(node.arguments[payloadIdx], node, r);
        const reasons: string[] = [];
        if (!table) reasons.push('table argument is dynamic');
        if (!collected) reasons.push(`payload is not a resolvable object literal${describePayload(node.arguments[payloadIdx], node)}`);
        sites.push({
          file,
          line,
          callee: name,
          table,
          fields: collected?.fields ?? [],
          resolved: Boolean(table && collected),
          partial: collected?.partial ?? false,
          unresolvedReason: reasons.length ? reasons.join('; ') : undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return sites;
}

/**
 * Read the TABLES const out of lib/airtable.ts so the scanner never carries a
 * second copy of the table names (the copy would drift, and drift is the bug
 * this whole guard exists to stop).
 */
export function parseTablesConst(source: string): Record<string, string> {
  const sf = ts.createSourceFile('airtable.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Record<string, string> = {};
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'TABLES' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        const init = unwrap(p.initializer);
        if (key && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) out[key] = init.text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Exported top-level string constants of one module, for cross-module table
 * aliases (`export const PAYMENTS_TABLE = TABLES.PAYMENTS`).
 */
export function parseExportedStringConstants(
  file: string,
  source: string,
  tables: Readonly<Record<string, string>>,
): Record<string, string> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Record<string, string> = {};
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrap(d.initializer);
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        out[d.name.text] = init.text;
      } else if (
        ts.isPropertyAccessExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'TABLES' &&
        ts.isIdentifier(init.name) &&
        tables[init.name.text]
      ) {
        out[d.name.text] = tables[init.name.text];
      }
    }
  }
  return out;
}
