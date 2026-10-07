import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const fileName = resolve(import.meta.dirname, '../packages/player/src/player-pipeline.ts');
const program = ts.createProgram([fileName], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  baseUrl: resolve(import.meta.dirname, '..'),
  paths: { '@openmoq/*': ['packages/*/src/index.ts'] },
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(fileName)!;

function definedCalls(): ts.Type[] {
  const returns: ts.Type[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'defined') {
      returns.push(checker.getTypeAtLocation(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return returns;
}

describe('render feedback types', () => {
  it('typechecks the forwarding implementation with exact optional properties', () => {
    const errors = program.getSemanticDiagnostics(source).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(errors).toEqual([]);
  });

  it('declares an exact bigint timestamp at the pipeline callback boundary', () => {
    const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'PipelineCallbacks');
    expect(declaration).toBeDefined();
    const callback = checker.getTypeAtLocation(declaration!).getProperty('onFrameRendered')!;
    const callbackType = checker.getTypeOfSymbolAtLocation(callback, declaration!);
    const signature = callbackType.getCallSignatures()[0]!;
    const timestampType = checker.getTypeOfSymbolAtLocation(signature.parameters[0]!, declaration!);
    expect(checker.typeToString(timestampType)).toBe('bigint');
  });

  it('does not erase constructor option checking through defined()', () => {
    const returns = definedCalls();
    expect(returns).toHaveLength(2);
    expect(returns.map((type) => Boolean(type.flags & ts.TypeFlags.Any))).toEqual([false, false]);
  });

  it('preserves required options and makes only possibly undefined options optional', () => {
    const [syncOptions, dispatcherOptions] = definedCalls();
    const cases = [
      [syncOptions!, 'clock', false],
      [syncOptions!, 'driftThresholdUs', false],
      [syncOptions!, 'targetLatencyMs', true],
      [dispatcherOptions!, 'onFrameRendered', false],
      [dispatcherOptions!, 'renderer', true],
    ] as const;
    for (const [type, name, optional] of cases) {
      const property = type.getProperty(name);
      expect(property, name).toBeDefined();
      expect(Boolean(property!.flags & ts.SymbolFlags.Optional), name).toBe(optional);
      const propertyType = checker.getTypeOfSymbolAtLocation(property!, source);
      expect(Boolean(propertyType.flags & ts.TypeFlags.Any), name).toBe(false);
    }
  });
});
