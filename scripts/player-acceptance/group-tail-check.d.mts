import type { Page } from 'playwright';
import type {} from '../../examples/_tests/player-acceptance/main.js';
import type { PlaybackSample } from './assessment.mjs';
import type { GroupTailSnapshot, TailSubmission, TailNativeOperation, TailStage, TailCheckpoint } from './group-tail.mjs';
interface Assessment { passed: boolean; failures: string[] }
export interface TailPair { tail?: TailSubmission | null; next?: TailSubmission; tailNative?: TailNativeOperation; nextNative?: TailNativeOperation }
export interface TailRetention extends Assessment { stimulus: Assessment; diagnostics: Assessment; causalLoss: boolean; inputDiscards: TailStage[];
  contradictoryTarget: boolean; negativeOutputQualified: boolean; pair: TailPair }
export interface GroupTailEvidence { baseline?: Assessment; baselineDiagnostics?: Assessment; baselineSamples?: PlaybackSample[]; terminalAtMs?: number;
  probe?: GroupTailSnapshot; postSamples?: PlaybackSample[]; after?: Assessment; retention?: TailRetention;
  assessment?: Assessment; scope?: string }
export function tailPair(probe: GroupTailSnapshot): TailPair;
export function assessTailStimulus(probe: GroupTailSnapshot): Assessment;
export function assessTailDiagnostics(probe: GroupTailSnapshot, checkpoint?: TailCheckpoint): Assessment;
export function assessTailRetention(probe: GroupTailSnapshot, baseline: Assessment, after: Assessment,
  combinedRanges: number[][]): TailRetention;
export function checkGroupTail(page: Page, evidence: GroupTailEvidence, mode: 'ordinary' | 'held'): Promise<ReturnType<Window['playerAcceptance']['snapshot']>>;
