import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

function snippet(heading: string): string {
  const start = readme.indexOf(heading);
  if (start < 0) throw new Error(`Missing README heading: ${heading}`);
  const match = /```ts\n([\s\S]*?)\n```/.exec(readme.slice(start + heading.length));
  if (!match) throw new Error(`Missing TypeScript example: ${heading}`);
  return match[1]!;
}

const examples = [
  {
    name: 'drop-in player',
    heading: '### `@openmoq/playa`',
    prelude: '',
  },
  {
    name: 'custom player composition',
    heading: '### `@openmoq/player`',
    prelude: 'declare const canvas: HTMLCanvasElement; declare const video: HTMLVideoElement;',
  },
  {
    name: 'Playa lifecycle and events',
    heading: '## `@openmoq/playa` API',
    prelude: `
      import { Player, type PlayerOptions } from '@openmoq/playa';
      declare const container: HTMLElement;
      declare const options: PlayerOptions;
      declare const index: number;
    `,
  },
  {
    name: 'player hooks and events',
    heading: '## `@openmoq/player` MoqtPlayer API',
    prelude: `
      import type { MoqtPlayer } from '@openmoq/player';
      declare const player: MoqtPlayer;
      declare function shouldSkip(trackName: string): boolean;
      declare function networkIsBad(): boolean;
    `,
  },
];

const sources = new Map(examples.map((example, index) => [
  resolve(root, `readme-example-${index}.ts`),
  `${example.prelude}\n${snippet(example.heading)}`,
]));
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  noEmit: true,
  baseUrl: root,
  paths: { '@openmoq/*': ['packages/*/src/index.ts'] },
};
const host = ts.createCompilerHost(options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => {
  const source = sources.get(filename);
  return source === undefined
    ? getSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile)
    : ts.createSourceFile(filename, source, languageVersion, true);
};
const program = ts.createProgram([...sources.keys()], options, host);

describe('README examples', () => {
  examples.forEach((example, index) => {
    it(`typechecks ${example.name} against the public API`, () => {
      const source = program.getSourceFile(resolve(root, `readme-example-${index}.ts`))!;
      const diagnostics = [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ];
      expect(diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    });
  });
});
