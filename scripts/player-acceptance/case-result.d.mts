export interface CaseAssessment { readonly passed: boolean; readonly failures: readonly string[] }
export type CaseResult<T extends CaseAssessment = CaseAssessment> =
  | { readonly status: 'trace'; readonly completed: true; readonly assessment: T }
  | { readonly status: 'pass' | 'fail'; readonly completed: true; readonly passed: boolean; readonly assessment: T };
export function classifyCaseResult<T extends CaseAssessment>(assessment: T, informational?: boolean,
  expectedFailure?: string | null): CaseResult<T>;
export function formatCaseResult(name: string, result: CaseResult): string;
export type RunResult = { readonly status: 'trace'; readonly completed: true }
  | { readonly status: 'pass'; readonly completed: true; readonly passed: true }
  | { readonly status: 'fail'; readonly completed: false; readonly passed: false };
export function classifyRunResult(cases: readonly { readonly status?: string; readonly completed?: boolean }[],
  errors: readonly unknown[]): RunResult;
