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
  nativeDrawTimestampUs?: number;
  nativeDrawTimeMs?: number;
  nativeFrameWidth?: number;
  nativeFrameHeight?: number;
  nativeFrameAtMs?: number;
  audioContextTimeS?: number;
  nativeTimestampOffsets?: readonly number[];
  videoPresentation?: { frameTimestampUs: string | null; timestampDomain: 'unknown'; renderedAtUs: number } | null;
}

export interface ExpectedPlayback {
  outputKind?: 'video' | 'canvas';
  timestampDomain?: 'wall-clock' | 'media';
  publisherEpochMs?: number;
  videoWidth: number;
  videoHeight: number;
  audioHz: number;
  videoFps: number;
  videoSizes?: readonly { width: number; height: number }[];
}

export function assessPlayback(samples: readonly PlaybackSample[], expected?: ExpectedPlayback): {
  passed: boolean;
  failures: string[];
  samples: number;
  durationMs: number;
};

export interface PlaybackQualityCounts {
  readonly totalVideoFrames: number;
  readonly droppedVideoFrames: number;
  readonly displayedVideoFrames: number;
  readonly creationTimeMs: number;
}
export interface PlaybackQualityMeasurement {
  readonly before: PlaybackQualityCounts | null;
  readonly reported: PlaybackQualityCounts | null;
  readonly after: PlaybackQualityCounts | null;
}
export function assessPlaybackQuality(measurement: PlaybackQualityMeasurement, hasMseVideo: boolean): {
  passed: boolean;
  failures: string[];
};
