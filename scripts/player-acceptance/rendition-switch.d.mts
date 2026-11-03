import type { PlaybackSample } from './assessment.mjs';
import type { observeNativeMse } from '../../examples/_tests/player-acceptance/native-mse.js';

export function assessSwitchContinuity(observed: {
  samples: readonly PlaybackSample[];
  nativeError: unknown;
  nativeEvents: readonly unknown[];
  events: readonly { type: string; timeMs: number }[];
}): { passed: boolean; failures: string[]; samples: number };

export function assessNativeRetypes(observed: {
  samples: readonly PlaybackSample[];
  nativeMse: ReturnType<ReturnType<typeof observeNativeMse>['snapshot']> | null;
}, retypes: boolean, baselineOffsets: readonly number[]): {
  passed: boolean; failures: string[]; mimes: string[]; expectedMimes: string[]; baselineOffsets: readonly number[];
};
