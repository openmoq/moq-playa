import type { Page } from 'playwright';
import type {} from '../../examples/_tests/player-acceptance/main.js';
import type { ExpectedPlayback, PlaybackSample } from './assessment.mjs';
import type { ProgramSwitchVariant } from './program-switch.fixture.mjs';
type Snapshot = ReturnType<Window['playerAcceptance']['snapshot']>;
export type ProgramSwitchMode = 'program' | 'view';
export interface ProgramSwitchPlan {
  mode: ProgramSwitchMode;
  namespace: string;
  expected: ExpectedPlayback;
  variant: ProgramSwitchVariant;
}
interface Assessment { passed: boolean; failures: string[] }
interface SelectionPoint {
  timeMs: number;
  media: Window['playerAcceptance']['mediaSelection'];
  selection: Window['playerAcceptance']['selection'];
  sample: PlaybackSample | undefined;
}
export type ProgramPlaybackPoint = Window['playerAcceptance']['playback'];
export type ProgramPlaybackAction = ReturnType<Window['playerAcceptance']['pausePlayback']>;
export type ProgramSessionObservation = Pick<Snapshot, 'samples' | 'events' | 'nativeEvents' | 'nativeError' | 'transportState'>;
export interface ProgramPauseResumeObservation {
  before: ProgramPlaybackPoint;
  pause: ProgramPlaybackAction;
  paused: ProgramPlaybackPoint;
  resume: ProgramPlaybackAction;
  ready: ProgramPlaybackPoint;
  after: ProgramPlaybackPoint;
  observed: ProgramSessionObservation;
}
export interface ProgramPauseResumeEvidence {
  before?: ProgramPlaybackPoint;
  pause?: ProgramPlaybackAction;
  paused?: ProgramPlaybackPoint;
  resume?: ProgramPlaybackAction;
  ready?: ProgramPlaybackPoint;
  after?: ProgramPlaybackPoint;
  readinessAfterMs?: number;
  observed?: Snapshot;
  output?: { samples: PlaybackSample[]; fromMs: number; untilMs: number; assessment: Assessment; wrongAudio: Assessment; oldVideo: Assessment };
  wire?: Assessment;
  assessment?: Assessment;
}
export interface ProgramSwitchEvidence {
  mode?: ProgramSwitchMode;
  before?: SelectionPoint;
  afterSetter?: SelectionPoint;
  afterReadiness?: SelectionPoint;
  after?: SelectionPoint;
  requestedAtMs?: number;
  settledAfterMs?: number;
  timeline?: Awaited<ReturnType<Window['playerAcceptance']['selectProgramMapped']>>;
  baseline?: { samples: PlaybackSample[]; assessment: Assessment; wrongAudio: Assessment };
  target?: { samples: PlaybackSample[]; fromMs: number; untilMs: number; assessment: Assessment; wrongAudio: Assessment; oldVideo: Assessment };
  session?: Assessment;
  wire?: Assessment;
  adoptionAssessment?: Assessment;
  pauseResume?: ProgramPauseResumeEvidence;
  assessment?: Assessment;
}
export function assessProgramSwitchOutput(samples: readonly PlaybackSample[], expected: ExpectedPlayback, sourceOriginUs: string): Assessment;
export function assessProgramSwitchSession(observed: Pick<Snapshot, 'samples' | 'events' | 'nativeEvents' | 'nativeError' | 'transportState'>): Assessment;
export function assessProgramPauseResume(observed: ProgramPauseResumeObservation, expected: ExpectedPlayback, sourceOriginUs: string): Assessment;
export function assessProgramSwitchSubscriptions(wire: Snapshot['programWire'], namespace: string, mode: ProgramSwitchMode,
  tracks: ProgramSwitchVariant['tracks']): Assessment;
export function checkProgramSwitch(page: Page, evidence: ProgramSwitchEvidence,
  bounded: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>, plan: ProgramSwitchPlan): Promise<Snapshot>;
