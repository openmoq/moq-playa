export interface PlaybackSample {
  wallMs: number;
  mediaTimeS: number;
  presentedMediaTimeS: number;
  presentedFrames: number;
  pictureDigest: string;
  pictureChange: number;
  markerMatches: boolean;
  audioRms: number;
  audioPeakHz: number;
  paused: boolean;
  seeking: boolean;
  visibility: string;
  bufferedRanges: { start: number; end: number }[];
}

export function assessPlayback(samples: readonly PlaybackSample[]): {
  passed: boolean;
  failures: string[];
  samples: number;
  durationMs: number;
};
