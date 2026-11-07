import type { LinkOptions } from './shaper.mjs';
export const netShapePresets: Record<'cap-1m' | 'step-5m-1m' | 'jitter' | 'ample', { down: LinkOptions; up: LinkOptions }>;
