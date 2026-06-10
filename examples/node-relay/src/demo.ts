/**
 * Shared demo constants + tiny helpers for the Slice C object-stream example.
 * One fixed track; three small text payloads. Nothing here is protocol logic.
 */
export const DEMO_NAMESPACE = (process.env.DEMO_NAMESPACE ?? 'demo').split('/');
export const DEMO_TRACK = process.env.DEMO_TRACK ?? 'objects';
export const DEMO_ALIAS = 7n;
export const DEMO_PAYLOADS = ['hello-0', 'hello-1', 'hello-2'] as const;

/** A toy ABR-style media ladder (all under DEMO_NAMESPACE) the relay can route. */
export const MEDIA_TRACKS = [
  'catalog',
  'video-1080', 'video-720', 'video-360',
  'audio-en', 'audio-es',
] as const;
export type MediaTrack = (typeof MEDIA_TRACKS)[number];

/** Distinct per-track payloads so a test can prove objects route to the right track
 *  only (e.g. video-720 → ["video-720#0","video-720#1"]). */
export const trackPayloads = (track: string, n = 2): string[] =>
  Array.from({ length: n }, (_, i) => `${track}#${i}`);

const enc = new TextEncoder();
const dec = new TextDecoder();

export const te = (s: string): Uint8Array => enc.encode(s);
export const td = (b: Uint8Array): string => dec.decode(b);
/** ASCII-safe hex of bytes — for building map keys without control characters. */
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** namespace as the wire tuple (array of byte fields). */
export const nsBytes = (parts: string[] = DEMO_NAMESPACE): Uint8Array[] => parts.map(te);
/** human-readable "a/b" for logging/compare. */
export const nsStr = (parts: Uint8Array[]): string => parts.map(td).join('/');

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}
