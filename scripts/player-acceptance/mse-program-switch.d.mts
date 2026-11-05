import type { Page } from 'playwright';
import type {} from '../../examples/_tests/player-acceptance/main.js';
import type { ExpectedPlayback } from './assessment.mjs';
import type { ProgramSwitchVariant } from './program-switch.fixture.mjs';
import type { MseProgramObserverSnapshot } from './mse-program-switch-observer.mjs';
export { prepareProgramSwitchVariant as prepareMseProgramSwitchVariant } from './program-switch.fixture.mjs';
export interface MseProgramSwitchPlan {
  mode: 'program' | 'view';
  outcome: 'adopt' | 'queue-refusal';
  namespace: string;
  relayUrl: string;
  expected: ExpectedPlayback;
  variant: ProgramSwitchVariant;
}
export const mseProgramSwitchCases: readonly {
  name: string; mode: MseProgramSwitchPlan['mode']; outcome: MseProgramSwitchPlan['outcome'];
}[];
export type MseProgramSnapshot = ReturnType<Window['playerAcceptance']['snapshot']> & { mseProgram: MseProgramObserverSnapshot };
export interface MseSelectionPoint {
  timeMs: number;
  media: Window['playerAcceptance']['mediaSelection'];
  selection: Window['playerAcceptance']['selection'];
  sample: Window['playerAcceptance']['latestSample'];
}
interface Assessment { passed: boolean; failures: string[] }
export interface MseProgramSwitchObservation {
  initial: MseSelectionPoint;
  before: MseSelectionPoint;
  after: MseSelectionPoint;
  requestedAtMs: number;
  targetFromMs: number;
  timeline: Awaited<ReturnType<Window['playerAcceptance']['selectProgramMapped']>>;
  refusal: string | null;
  baseline: MseProgramSnapshot;
  observed: MseProgramSnapshot;
}
export interface MseProgramSwitchEvidence extends Partial<MseProgramSwitchObservation> {
  nativeExecuted?: boolean;
  mode?: MseProgramSwitchPlan['mode'];
  outcome?: MseProgramSwitchPlan['outcome'];
  assessment?: Assessment;
  readinessAfterMs?: number;
}
/** Bounded synthetic controls validate this oracle, not Chrome or native atomicity. */
export function assessMseProgramSwitch(observed: MseProgramSwitchObservation, plan: MseProgramSwitchPlan): Assessment;
/** Public reference-map selection, real video/rVFC/PCM and one exact wire owner. */
export function checkMseProgramSwitch(page: Page, evidence: MseProgramSwitchEvidence,
  bounded: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>, plan: MseProgramSwitchPlan): Promise<MseProgramSnapshot>;
