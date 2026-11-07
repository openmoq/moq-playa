import type { ScheduleStep, ShaperOptions } from './shaper.mjs';
export function parseSchedule(text: string): ScheduleStep[];
export function parseShaperArgs(argv: readonly string[]): (ShaperOptions & { listen: number; listenHost: string; seed: number }) | { help: true };
