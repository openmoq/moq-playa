import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function imports(source: string): string[] {
  const result: string[] = [];
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      result.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

describe('interop package scope', () => {
  it('finds static, type, re-export, and dynamic imports', () => {
    expect(imports(`
      import { A } from '@moqt/transport';
      export { B } from '@moqt/webtransport';
      type T = import('@moqt/transport').T;
      const quic = import('@moqt/quic');
    `)).toEqual(['@moqt/transport', '@moqt/webtransport', '@moqt/transport', '@moqt/quic']);
  });

  it('loads only the new-scope checkout libraries in the client and its tests', () => {
    const found: string[] = [];
    for (const directory of ['src', 'test']) {
      const dir = resolve(root, 'tools/moq-interop-client', directory);
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
        for (const specifier of imports(readFileSync(resolve(dir, file), 'utf8'))) {
          if (/^@(moqt|playa)\//.test(specifier)) found.push(`${directory}/${file}: ${specifier}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('does not install registry copies of the libraries supplied by the checkout', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'tools/moq-interop-client/package.json'), 'utf8'));
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(dependencies).filter((name) => /^@(moqt|playa|openmoq)\//.test(name))).toEqual([]);
  });
});
