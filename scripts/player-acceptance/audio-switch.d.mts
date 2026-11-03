import type { Page } from 'playwright';
import type {} from '../../examples/_tests/player-acceptance/main.js';
import type { ExpectedPlayback, PlaybackSample } from './assessment.mjs';

type Snapshot = ReturnType<Window['playerAcceptance']['snapshot']>;
interface SelectionPoint {
  timeMs: number;
  selection: Window['playerAcceptance']['selection'];
  sample: PlaybackSample | undefined;
}
interface Assessment { passed: boolean; failures: string[] }
interface AudioWindow {
  fromMs: number;
  untilMs: number;
  samples: number;
  first: PlaybackSample | undefined;
  last: PlaybackSample | undefined;
}
export type AudioSwitchMode = 'same-set' | 'unmapped-refusal' | 'reference-map' | 'live-resync';
export interface AudioSwitchPlan { mode: AudioSwitchMode; sourceTimeUs?: string; referenceTimeUs?: string; expected?: ExpectedPlayback }
export interface AudioSwitchEvidence {
  mode?: AudioSwitchMode;
  initial?: SelectionPoint;
  before?: SelectionPoint;
  afterSetter?: SelectionPoint;
  afterReadiness?: SelectionPoint;
  after?: SelectionPoint;
  requestedIndex?: number;
  requestedId?: string;
  requestedAtMs?: number;
  settledAfterMs?: number;
  settleTimedOut?: boolean;
  settleError?: string;
  english?: Assessment;
  englishSpanishControl?: Assessment;
  spanish?: Assessment;
  spanishEnglishControl?: Assessment;
  englishAfter?: Assessment;
  refusalError?: string;
  failureEventCount?: number;
  timeline?: Awaited<ReturnType<Window['playerAcceptance']['selectAudioTrackMapped']>>;
  targetWindow?: AudioWindow;
  continuity?: Assessment & { samples: number };
  sessionContinuity?: Assessment & { samples: number };
  forwardAssessment?: Assessment;
  reverse?: AudioSwitchEvidence;
  assessment?: Assessment;
}
export function checkAudioLanguageSwitch(page: Page, evidence: AudioSwitchEvidence,
  bounded: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>, plan?: AudioSwitchPlan): Promise<Snapshot>;
export function assessAudioSwitchOutput(samples: readonly PlaybackSample[], expected: ExpectedPlayback): Assessment & {
  samples: number; durationMs: number;
};
