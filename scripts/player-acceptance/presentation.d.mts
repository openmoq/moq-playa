export interface PresentationSample {
  outputKind: 'canvas' | 'video';
  nativeDrawTimestampUs?: number;
  nativeDrawTimeMs?: number;
  videoPresentation?: {
    frameTimestampUs: string | null;
    timestampDomain: string;
    renderedAtUs: number;
  } | null;
}

export function assessVideoPresentation(samples: readonly PresentationSample[]): string[];
