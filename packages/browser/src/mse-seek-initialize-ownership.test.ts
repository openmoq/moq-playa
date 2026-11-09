import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSeekResource } from '@openmoq/player';
import { parseLocmafTrackContext } from '../../locmaf/src/index.js';
import { MseMediaSource } from './mse-adapter.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';
import { buildInit } from '../../locmaf/test-support/cmaf.js';

// Actual adapter with observable native-interface doubles; no codec/browser evidence.
class SeekVideo extends MockVideoElement {
  override load(): void {
    this.advancePlayback(0); this.seeking = false; this.readyState = 0;
    this.buffered = makeTimeRanges([]); this.error = null;
  }
  override removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
}
const first = { codec: 'avc1.640028', initData: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }) };
const second = { codec: 'avc1.4d401f', initData: buildInit({ trackId: 7, timescale: 48000, handler: 'vide' }) };
const mime = (codec: string) => `video/mp4; codecs="${codec}"`;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let sources: MockMediaSource[], capabilityHook: (() => void) | undefined;
const adapters: MseMediaSource[] = [];
beforeEach(() => {
  vi.useFakeTimers(); sources = []; capabilityHook = undefined;
  vi.stubGlobal('MediaSource', class extends MockMediaSource {
    static isTypeSupported(): boolean { capabilityHook?.(); return true; }
    constructor() { super(); sources.push(this); }
    override addSourceBuffer(type: string) {
      if (this.readyState !== 'open') throw new DOMException('MediaSource is closed', 'InvalidStateError');
      return super.addSourceBuffer(type);
    }
  });
  let nextUrl = 0;
  vi.stubGlobal('URL', { createObjectURL: () => `blob:init-${nextUrl++}`, revokeObjectURL() {} });
});
afterEach(() => {
  capabilityHook = undefined;
  for (const adapter of adapters.splice(0)) adapter.destroy();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});
function fixture() {
  const video = new SeekVideo(); video.paused = true;
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { reorderWindowMs: 0, maxAheadSec: Infinity });
  adapters.push(adapter); const errors: Error[] = []; adapter.onError = error => { errors.push(error); };
  return { video, adapter, errors };
}
function assertNativeInitialization(source: MockMediaSource, entry: typeof first, trackId: number) {
  expect.soft(source.addSourceBufferCalls).toEqual([mime(entry.codec)]);
  const payloads = source.videoBuffer.appendedPayloads;
  expect.soft(payloads).toHaveLength(1);
  if (payloads[0]) expect.soft(parseLocmafTrackContext(payloads[0]).trackId).toBe(trackId);
}

describe('seek initialization admission ownership', () => {
  it.each(['config getter', 'UA capability'] as const)('does not initialize a successor after reentry through %s', async boundary => {
    const f = fixture(), old = f.adapter.beginSeek({});
    let fresh: MediaSeekResource | undefined, entered = 0, failure: unknown;
    const replace = () => {
      if (entered !== 0) return;
      entered++; fresh = f.adapter.beginSeek({});
    };
    const config = boundary === 'config getter'
      ? { video: { get codec() { replace(); return first.codec; }, initData: first.initData } }
      : { video: first };
    if (boundary === 'UA capability') capabilityHook = replace;
    try { old.initialize(config); } catch (error) { failure = error; }
    capabilityHook = undefined;
    expect(entered).toBe(1); expect(old.current).toBe(false);
    if (!fresh) throw new Error('Successor was not created by the tested boundary');
    expect(fresh.current).toBe(true);
    const native = sources.at(-1)!;
    native.open(); await settle();
    expect.soft(native.addSourceBufferCalls, 'retired initialize must not create successor SourceBuffers').toEqual([]);
    expect.soft(native.videoBuffer.appendedPayloads, 'retired initialize must not append old init into the successor').toEqual([]);
    expect.soft(failure).toMatchObject({ name: 'AbortError' });
    // A refused old call must leave the successor available for its own real initialization.
    expect(fresh.initialize({ video: second })).toBe(true);
    await fresh.whenAttached(); await settle();
    assertNativeInitialization(native, second, 7);
    expect(fresh.current).toBe(true); expect(f.errors).toEqual([]); expect(f.video.playCalls).toBe(0);
  });

  it('does not reread live codec/init getters at delayed sourceopen', async () => {
    const f = fixture(), resource = f.adapter.beginSeek({}), native = sources.at(-1)!;
    let value = first, reads = 0;
    const entry = { get codec() { reads++; return value.codec; }, get initData() { reads++; return value.initData; } };
    expect(resource.initialize({ video: entry })).toBe(true);
    const admittedReads = reads;
    const waiting = resource.whenAttached();
    value = second;
    native.open(); await waiting; await settle();
    expect.soft(reads, 'native attachment must consume the admitted snapshot').toBe(admittedReads);
    assertNativeInitialization(native, first, 1);
    expect(resource.current).toBe(true); expect(f.errors).toEqual([]); expect(f.video.playCalls).toBe(0);
  });

  it('keeps healthy initialization and explicit successor initialization independent', async () => {
    const f = fixture(), old = f.adapter.beginSeek({}), native = sources.at(-1)!;
    expect(old.initialize({ video: first })).toBe(true);
    native.open(); await old.whenAttached(); await settle();
    assertNativeInitialization(native, first, 1);
    const fresh = f.adapter.beginSeek({}), next = sources.at(-1)!;
    expect(old.current).toBe(false); expect(fresh.current).toBe(true);
    expect(() => old.initialize({ video: first })).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(next.addSourceBufferCalls).toEqual([]);
    expect(fresh.initialize({ video: second })).toBe(true);
    next.open(); await fresh.whenAttached(); await settle();
    assertNativeInitialization(next, second, 7);
    expect(f.errors).toEqual([]); expect(f.video.playCalls).toBe(0);
  });
});
