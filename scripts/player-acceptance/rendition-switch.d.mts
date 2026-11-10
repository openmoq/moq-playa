import type { PlaybackSample } from './assessment.mjs';
import type { observeNativeMse } from '../../examples/_tests/player-acceptance/native-mse.js';

type SizeSample = Pick<PlaybackSample, 'wallMs' | 'videoWidth' | 'videoHeight' | 'nativeFrameWidth' | 'nativeFrameHeight'>;
/** A requested switch: the sample read when it was requested, and the sample that settled it. */
export interface SwitchTransition { requestedAtMs: number; before?: SizeSample; settled?: SizeSample }
export interface TransitionalSample {
  wallMs: number; transition: number; presentedFrames: number; nativeFrameAtMs: number | undefined;
  element: { width: number; height: number }; frame: { width: number | undefined; height: number | undefined };
}

export function assessSwitchContinuity(observed: {
  samples: readonly PlaybackSample[];
  nativeError: unknown;
  nativeEvents: readonly unknown[];
  events: readonly { type: string; timeMs: number }[];
}, transitions?: readonly SwitchTransition[]): { passed: boolean; failures: string[]; samples: number; transitional: TransitionalSample[] };

export function assessNativeRetypes(observed: {
  samples: readonly PlaybackSample[];
  nativeMse: ReturnType<ReturnType<typeof observeNativeMse>['snapshot']> | null;
}, retypes: boolean, baselineOffsets: readonly number[]): {
  passed: boolean; failures: string[]; mimes: string[]; expectedMimes: string[]; baselineOffsets: readonly number[];
};
