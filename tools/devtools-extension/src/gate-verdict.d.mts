// Precise declarations for the JS verdict helper, so the TypeScript test
// gate checks real shapes rather than `any`.
export interface GateEvidence {
  readonly fatal: string | null;
  readonly before: readonly number[] | null;
  readonly after: readonly number[] | null;
  readonly rendererError: string | null;
  readonly painted: boolean;
  readonly errorCount: number;
}
export type GateMode = 'positive' | 'negative-row-cache';
export interface GateVerdict { readonly pass: boolean; readonly reasons: readonly string[] }
export const ROW_CACHE_SIGNATURE: RegExp;
export function gateVerdict(mode: GateMode, evidence: GateEvidence): GateVerdict;
