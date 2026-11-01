// Precise declarations for the JS verdict helper of the live negatives gate.
export const INTENDED: Readonly<Record<'plain' | 'two-players' | 'silent' | 'freeze', string>>;
export const CONTROLS: Readonly<Record<string, { readonly case: string; readonly intended: string; readonly afterStep: string }>>;
export class IntendedAssertion extends Error { readonly intended: string; constructor(name: string, message: string); }
export function intended(name: string, condition: unknown, message: string): asserts condition;
export interface NegativeCase { readonly name: string; readonly passed: boolean; readonly error: string | null; readonly intendedFailure: string | null; readonly steps: readonly { readonly step: string }[] }
export interface NegativesEvidence {
  readonly control: string | null; readonly expectedCases: readonly string[]; readonly cases: Readonly<Record<string, NegativeCase>>;
  readonly fatal: string | null; readonly errorCount: number; readonly backendUnchanged: boolean | null; readonly inputsUnchanged: boolean | null; readonly cleanupProven: boolean | null; readonly completed: boolean | null;
}
export function negativesVerdict(e: NegativesEvidence): { readonly pass: boolean; readonly reasons: readonly string[] };
