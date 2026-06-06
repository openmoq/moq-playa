/**
 * Session boundary guard.
 *
 * The sans-I/O session core (everything under `src/session/`) must stay free of
 * draft-18 *wire-format* details: no importing the draft-18 serialization
 * modules, no raw draft-18 wire constants (the 0x2F00 SETUP type, vi64). Those
 * belong to the codec/topology layers; the session reaches them only through the
 * version-neutral `ProtocolProfile` seam.
 *
 * This mirrors libmoq's `check_profile_boundary.sh`: a cheap structural test
 * that fails fast if draft-specific wire knowledge starts leaking back into the
 * semantic core. It scans only `src/session/` (not the whole repo).
 *
 * Import detection uses the TypeScript compiler API (real AST nodes), so
 * import-like text inside comments, string literals, or template literals never
 * produces a false positive. The raw-wire-constant scan strips comments and
 * string/template literals before matching, for the same reason.
 *
 * What is deliberately NOT forbidden: version checks like
 * `this._draftVersion === 18`. Those are legitimate during migration — the goal
 * is to keep wire details out, not to ban all version awareness.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';

const SESSION_DIR = dirname(fileURLToPath(import.meta.url));

const sessionFiles = readdirSync(SESSION_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort();

/**
 * Import specifiers the session core must not pull in: the draft-18
 * wire-serialization modules, the vi64 primitive, the I/O package, and the
 * topology layer. Matched as substrings of the real module specifier.
 */
const FORBIDDEN_IMPORT_SUBSTRINGS = [
  '../data/decoder-18.js',
  'data-codec-18',
  'encoder-18',
  'codes-18',
  'stream-type-18',
  'draft18-codec',
  'track-properties-18',
  'message-params-18',
  'primitives/vi64',
  '@moqt/webtransport',
  'topology/',
];

/**
 * Documented, intentional exceptions: specifiers that match a forbidden
 * substring but expose *individual* semantic (non-wire-framing) bindings that
 * the session core may import. The allowance is **name-specific**, not
 * module-wide: only the listed bindings, via a plain named import, are
 * permitted. A namespace import (`* as X`), a default import, a mixed clause, a
 * bare/dynamic import, or any other named binding from the same module is still
 * forbidden — otherwise a future file could pull `ControlMessageType18` (raw D18
 * message codes) and slip past.
 *
 * `control/codes-18.js` is a code-point enum table; `SetupOption18` is a set of
 * well-known setup-option codes (PATH, AUTHORITY, …) the SetupGate negotiates
 * by name. That is semantic, not serialization. Keep this map tiny + justified.
 */
const NAME_SPECIFIC_ALLOW: Readonly<Record<string, ReadonlyArray<string>>> = {
  '../control/codes-18.js': ['SetupOption18'],
};

/** Raw draft-18 wire details that must never appear in session source code. */
const FORBIDDEN_WIRE_TOKENS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '0x2F00 (draft-18 SETUP type)', pattern: /0x2f00/i },
  { label: 'vi64 (draft-18 varint primitive)', pattern: /\bvi64\b/i },
];

type ImportKind = 'named' | 'namespace' | 'default' | 'mixed' | 'bare';

/** How the module reference was reached. The name exception applies to `import` only. */
type ModuleRefVia = 'import' | 'export' | 'dynamic';

interface ParsedImport {
  /** The module specifier (the `'...'` part). */
  readonly spec: string;
  /** Whether this was a static import, a re-export-from, or a dynamic import. */
  readonly via: ModuleRefVia;
  /** Shape of the import clause. */
  readonly kind: ImportKind;
  /** Imported binding names (the original/exported names), for `named`/`mixed`. */
  readonly names: ReadonlyArray<string>;
}

/** Classify an `import` clause into a kind + imported binding names. */
function classifyImportClause(spec: string, clause: ts.ImportClause | undefined): ParsedImport {
  if (!clause) return { spec, via: 'import', kind: 'bare', names: [] }; // `import '...'`
  const hasDefault = clause.name !== undefined;
  const nb = clause.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) {
    return { spec, via: 'import', kind: hasDefault ? 'mixed' : 'namespace', names: [] };
  }
  if (nb && ts.isNamedImports(nb)) {
    const names = nb.elements.map((e) => (e.propertyName ?? e.name).text);
    return { spec, via: 'import', kind: hasDefault ? 'mixed' : 'named', names };
  }
  return { spec, via: 'import', kind: 'default', names: [] }; // `import Foo from '...'`
}

/**
 * Classify an `export … from '...'` re-export. Tagged `via: 'export'` so the
 * name-specific allowance never applies — re-exporting even the allowed D18 code
 * binding out of session core is a leak.
 */
function classifyExportClause(spec: string, clause: ts.NamedExportBindings | undefined): ParsedImport {
  if (!clause) return { spec, via: 'export', kind: 'namespace', names: [] }; // `export * from '...'`
  if (ts.isNamespaceExport(clause)) return { spec, via: 'export', kind: 'namespace', names: [] }; // `export * as ns`
  const names = clause.elements.map((e) => (e.propertyName ?? e.name).text);
  return { spec, via: 'export', kind: 'named', names };
}

/** Parse every static import, re-export-from, and dynamic import via the TS AST. */
function parseImports(src: string): ParsedImport[] {
  const sf = ts.createSourceFile('boundary-snippet.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const results: ParsedImport[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      results.push(classifyImportClause(node.moduleSpecifier.text, node.importClause));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      results.push(classifyExportClause(node.moduleSpecifier.text, node.exportClause));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      // Dynamic import yields a namespace object → no name-specific allowance.
      results.push({
        spec: (node.arguments[0] as ts.StringLiteralLike).text,
        via: 'dynamic',
        kind: 'namespace',
        names: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return results;
}

/** True if this import violates the session boundary. */
function isForbiddenImport(imp: ParsedImport): boolean {
  if (!FORBIDDEN_IMPORT_SUBSTRINGS.some((bad) => imp.spec.includes(bad))) return false;
  const allowedNames = NAME_SPECIFIC_ALLOW[imp.spec];
  if (!allowedNames) return true; // forbidden module, no exception at all
  // Name-specific exception: ONLY a plain named `import` whose every binding is
  // allowed. Re-exports (`export … from`), namespace / default / mixed / bare /
  // dynamic imports are forbidden — including re-exporting the allowed binding.
  if (imp.via !== 'import' || imp.kind !== 'named') return true;
  return !imp.names.every((n) => allowedNames.includes(n));
}

/** Convenience for self-checks: forbidden specifiers from a source snippet. */
function forbiddenImportsIn(src: string): string[] {
  return parseImports(src).filter(isForbiddenImport).map((imp) => imp.spec);
}

/** Remove line/block comments while preserving string literals (and their content). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i += 1;
        }
        if (i < n) {
          out += src[i];
          i += 1;
        }
      }
      if (i < n) {
        out += src[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Remove string/template literals (run after {@link stripComments}). */
function stripStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe('session core boundary', () => {
  it('finds session files to scan', () => {
    expect(sessionFiles.length).toBeGreaterThan(0);
  });

  describe('no draft-18 wire-module imports', () => {
    for (const file of sessionFiles) {
      it(`${file} imports no forbidden wire/IO modules`, () => {
        const src = readFileSync(join(SESSION_DIR, file), 'utf8');
        const violations = parseImports(src).filter(isForbiddenImport);
        const detail = violations.map((v) => `${v.kind} ${JSON.stringify(v.names)} from '${v.spec}'`);
        expect(detail, `forbidden imports in ${file}: ${detail.join('; ')}`).toEqual([]);
      });
    }
  });

  describe('guard self-check (the matcher actually catches leaks)', () => {
    it('flags the historical `../data/decoder-18.js` GroupOrder import', () => {
      expect(forbiddenImportsIn(`import type { GroupOrder } from '../data/decoder-18.js';`)).toEqual([
        '../data/decoder-18.js',
      ]);
    });

    it('allows ONLY the SetupOption18 named import from control/codes-18.js', () => {
      expect(forbiddenImportsIn(`import { SetupOption18 } from '../control/codes-18.js';`)).toEqual([]);
      expect(
        forbiddenImportsIn(`import type { SetupOption18 } from '../control/codes-18.js';`),
      ).toEqual([]);
      // aliased import of the allowed name is still the same imported binding.
      expect(
        forbiddenImportsIn(`import { SetupOption18 as SO } from '../control/codes-18.js';`),
      ).toEqual([]);
    });

    it('forbids any other binding or import shape from control/codes-18.js', () => {
      const spec = '../control/codes-18.js';
      expect(forbiddenImportsIn(`import { ControlMessageType18 } from '${spec}';`)).toEqual([spec]);
      expect(
        forbiddenImportsIn(`import { SetupOption18, ControlMessageType18 } from '${spec}';`),
      ).toEqual([spec]);
      expect(forbiddenImportsIn(`import * as Codes18 from '${spec}';`)).toEqual([spec]);
      expect(forbiddenImportsIn(`import Codes18 from '${spec}';`)).toEqual([spec]);
      expect(forbiddenImportsIn(`import Codes18, { SetupOption18 } from '${spec}';`)).toEqual([spec]);
      expect(forbiddenImportsIn(`const c = await import('${spec}');`)).toEqual([spec]);
      expect(forbiddenImportsIn(`import '${spec}';`)).toEqual([spec]);
      // re-exporting even the allowed binding out of session core is a leak.
      expect(forbiddenImportsIn(`export { SetupOption18 } from '${spec}';`)).toEqual([spec]);
      expect(forbiddenImportsIn(`export * from '${spec}';`)).toEqual([spec]);
    });

    it('keeps every other wire module hard-forbidden (no name exception)', () => {
      for (const spec of [
        '../data/data-codec-18.js',
        '../data/encoder-18.js',
        '../data/stream-type-18.js',
        '../control/draft18-codec.js',
        '../control/track-properties-18.js',
        '../control/message-params-18.js',
        '../primitives/vi64.js',
        '@moqt/webtransport',
        '../topology/uni-pair.js',
      ]) {
        expect(forbiddenImportsIn(`import { Whatever } from '${spec}';`)).toEqual([spec]);
      }
    });

    it('ignores import-like text inside comments, string and template literals', () => {
      const spec = '../control/codes-18.js';
      // line comment
      expect(forbiddenImportsIn(`// import { ControlMessageType18 } from '${spec}'`)).toEqual([]);
      // block comment
      expect(forbiddenImportsIn(`/* import { ControlMessageType18 } from '${spec}' */`)).toEqual([]);
      // string literal (uses double quotes so the inner single-quoted spec survives)
      expect(
        forbiddenImportsIn(`const s = "import { ControlMessageType18 } from '${spec}'";`),
      ).toEqual([]);
      // template literal
      expect(
        forbiddenImportsIn('const t = `import { ControlMessageType18 } from "' + spec + '"`;'),
      ).toEqual([]);
    });

    it('does NOT flag semantic version checks', () => {
      const ok = [
        `if (this._draftVersion === 18) doThing();`,
        `const v = this._draftVersion === 14 ? 'a' : 'b';`,
      ].join('\n');
      expect(forbiddenImportsIn(ok)).toEqual([]);
      const code = stripStrings(stripComments(ok));
      expect(FORBIDDEN_WIRE_TOKENS.some((t) => t.pattern.test(code))).toBe(false);
    });
  });

  describe('no raw draft-18 wire constants in code', () => {
    for (const file of sessionFiles) {
      it(`${file} has no raw draft-18 wire tokens`, () => {
        const raw = readFileSync(join(SESSION_DIR, file), 'utf8');
        const code = stripStrings(stripComments(raw));
        const hits = FORBIDDEN_WIRE_TOKENS.filter((t) => t.pattern.test(code)).map((t) => t.label);
        expect(hits, `raw wire tokens in ${file}: ${hits.join(', ')}`).toEqual([]);
      });
    }
  });
});
