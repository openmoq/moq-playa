export interface PcmActiveSpan { first: number; last: number; span: number }
export interface AudioOrderCase {
  kind: string;
  failure?: string;
  failures?: readonly string[];
  assertions?: readonly { passed: boolean }[];
  rate?: number;
  playbackRate?: number;
  ended?: boolean;
  currentTime?: number;
  duration?: number;
  samples?: number;
  pcmBytes?: number;
  quanta?: readonly { frame: number; length: number }[];
  endedAtFrame?: number;
  lastEndFrame?: number;
  drainSamples?: number;
  active?: PcmActiveSpan;
  elementEvents?: readonly { type: string }[];
  nativeOrder?: readonly number[];
  tokens?: readonly { index: number; terminals: readonly { state: string; reason: string | null }[] }[];
}
export const PCM_TOLERANCE_SAMPLES: 16;
export const PCM_THRESHOLD: 0.005;
export function activePcmSpan(bytes: Uint8Array): PcmActiveSpan;
export function assessAudioOrder(cases: readonly AudioOrderCase[]): {
  passed: boolean;
  failures: string[];
  threshold: number;
  toleranceSamples: number;
  spans: { kind: string; first?: number; last?: number; span?: number; lossFromHealthy: number }[];
  scope: string;
};
