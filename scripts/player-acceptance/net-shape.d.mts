import type { Page } from 'playwright';
import type { LinkOptions, ShaperStats } from '../net-shaper/shaper.mjs';

export interface NetShapeOption { preset: string; params: { down: LinkOptions; up: LinkOptions }; durationMs: number; seed: number }
export interface AbrTrace { timeOrigin: number; events: { timeMs: number; type: string; data: any }[] }
export interface AbrSummary {
  timeBase: string;
  switches: { atS: number; from: string; to: string; reason: string }[];
  failedSwitches: { atS: number; lastAtS: number; repeats: number; from: string; to: string; reason: string; error: string }[];
  stalls: { atS: number; detectedAfterMs: number; cause?: string }[];
  recoveries: { atS: number; durationMs: number }[];
  stalledMs: number;
  captureAge: { samples: number; maxMs: number; last: { atS: number; ageMs: number } } | null;
  shaper?: { deliveredBps: number | null; deliveredPackets: number; lossPackets: number; tailPackets: number;
    maxQueueBytes: number; latenessP99Ms: number | null; latenessMaxMs: number;
    /** Per second since the first downlink packet. */
    downlinkMbps: (number | null)[]; queueMaxBytes: (number | null)[] };
}
export function netShapeOption(argv: readonly string[], env: Record<string, string | undefined>): Promise<NetShapeOption | null>;
export function shapedUrl(relayUrl: string, port: number): string;
export function summarizeAbrTrace(trace: AbrTrace, shaper: Pick<ShaperStats, 'startedAtEpochMs' | 'down'> | null): AbrSummary;
export function observeShapedAbr(page: Page, evidence: Record<string, unknown>, durationMs: number): Promise<unknown>;
export const AUDIBLE_RMS: number;
export const MIN_AUDIBLE_FRACTION: number;
export interface AudioContinuity { samples: number; audibleFraction: number; longestSilenceMs: number | null; passed: boolean }
export function assessAudioContinuity(samples: readonly { audioRms: number; wallMs: number }[]): AudioContinuity;
