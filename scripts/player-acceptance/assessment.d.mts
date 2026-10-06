export interface PlaybackSample {
  outputKind: 'video' | 'canvas';
  wallMs: number;
  wallEpochMs?: number;
  mediaTimeS: number;
  presentedMediaTimeS: number;
  presentedFrames: number;
  pictureDigest: string;
  pictureChange: number;
  markerRgb: number[];
  videoWidth: number;
  videoHeight: number;
  audioRms: number;
  audioPeakHz: number;
  paused: boolean;
  seeking: boolean;
  visibility: string;
  bufferedRanges: { start: number; end: number }[] | null;
  frameTimestampUs?: number;
}

export interface ExpectedPlayback {
  outputKind?: 'video' | 'canvas';
  timestampDomain?: 'wall-clock' | 'media';
  publisherEpochMs?: number;
  videoWidth: number;
  videoHeight: number;
  audioHz: number;
  videoFps: number;
}

export function assessPlayback(samples: readonly PlaybackSample[], expected?: ExpectedPlayback): {
  passed: boolean;
  failures: string[];
  samples: number;
  durationMs: number;
};
