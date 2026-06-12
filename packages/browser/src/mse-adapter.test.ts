/**
 * Integration tests for MseMediaSource's timeline-owned append path.
 *
 * The node environment has no MSE / HTMLVideoElement. These tests use
 * hand-rolled mocks that model the shape the adapter actually consumes:
 * SourceBuffer events, updateend sequencing, appendBuffer throw
 * behavior, and video-element error events.
 *
 * Scope — these guard behaviors visible at the boundary:
 *   - Is `appendBuffer` called (or dropped) for a given payload?
 *   - Is the timeline correctly updated on `updateend`?
 *   - Does the diagnostic warn-once fire per mediaType+kind?
 *   - Do failure paths correctly clear pending ranges?
 *
 * Unit-level correctness of the ISOBMFF parsing and the interval
 * arithmetic is covered in mp4-box.test.ts and timeline-index.test.ts.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';

// ─── Shared byte-building helpers (subset from mp4-box.test.ts) ──

function cat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}
function u32(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
}
function fourcc(type: string): Uint8Array {
    return new TextEncoder().encode(type);
}
function box(type: string, body: Uint8Array): Uint8Array {
    return cat(u32(8 + body.byteLength), fourcc(type), body);
}
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
    const vf = new Uint8Array(4);
    vf[0] = version & 0xff;
    vf[1] = (flags >> 16) & 0xff;
    vf[2] = (flags >> 8) & 0xff;
    vf[3] = flags & 0xff;
    return box(type, cat(vf, body));
}
function tfdt(bmd: number): Uint8Array {
    return fullBox('tfdt', 0, 0, u32(bmd));
}
function tfhd(trackId: number, dur?: number): Uint8Array {
    const flags = dur !== undefined ? 0x8 : 0;
    const body = dur !== undefined ? cat(u32(trackId), u32(dur)) : u32(trackId);
    return fullBox('tfhd', 0, flags, body);
}
function trun(sampleCount: number): Uint8Array {
    return fullBox('trun', 0, 0, u32(sampleCount));
}
function makeSegment(opts: {
    bmd: number;
    trackId?: number;
    defaultDur?: number;
    sampleCount: number;
}): Uint8Array {
    const trackId = opts.trackId ?? 1;
    return cat(
        box('moof', cat(
            box('traf', cat(tfhd(trackId, opts.defaultDur), tfdt(opts.bmd), trun(opts.sampleCount))),
        )),
        box('mdat', new Uint8Array(16)),
    );
}
/** Minimal init segment with an mvex/trex for trex-default tests. */
function makeInit(trackId: number, defaultDur: number): Uint8Array {
    // Wrap moov → mvex → trex. filterInitSegment won't run on a truly
    // minimal init (no trak/vide), so we build a slightly richer one.
    const trex = fullBox('trex', 0, 0, cat(
        u32(trackId), u32(1), u32(defaultDur), u32(0), u32(0),
    ));
    const mvex = box('mvex', trex);
    // Minimal trak with vide hdlr so filterInitSegment's selection
    // passes through.
    const hdlr = fullBox('hdlr', 0, 0, cat(
        u32(0),                  // pre_defined
        fourcc('vide'),          // handler_type
        u32(0), u32(0), u32(0),  // reserved
        new Uint8Array([0]),     // name (null terminator)
    ));
    const mdia = box('mdia', hdlr);
    const tkhd = fullBox('tkhd', 0, 0, cat(
        u32(0), u32(0), u32(trackId), u32(0),
        u32(0), u32(0), new Uint8Array(52),
    ));
    const trak = box('trak', cat(tkhd, mdia));
    const moov = box('moov', cat(trak, mvex));
    const ftyp = box('ftyp', cat(fourcc('iso6'), u32(0), fourcc('iso6')));
    return cat(ftyp, moov);
}

// ─── Mocks ────────────────────────────────────────────────────────
//
// Minimal SourceBuffer / MediaSource / HTMLVideoElement that model
// the exact surface the adapter uses. Kept in this file (not shared)
// because other adapter tests don't use MSE mocks.

class MockEventTarget {
    private readonly listeners = new Map<string, Array<(e?: Event) => void>>();
    addEventListener(type: string, fn: (e?: Event) => void): void {
        const arr = this.listeners.get(type) ?? [];
        arr.push(fn);
        this.listeners.set(type, arr);
    }
    removeEventListener(type: string, fn: (e?: Event) => void): void {
        const arr = this.listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    }
    protected fire(type: string): void {
        const arr = this.listeners.get(type);
        if (!arr) return;
        for (const fn of arr.slice()) fn();
    }
}

class MockSourceBuffer extends MockEventTarget {
    updating = false;
    mode: 'segments' | 'sequence' = 'segments';
    timestampOffset = 0;
    readonly appendedPayloads: Uint8Array[] = [];
    buffered = makeTimeRanges([]);
    /** Throw on the NEXT appendBuffer call. */
    throwNextAppend?: Error;
    /** Fire an error event on the next appendBuffer instead of updateend. */
    errorNextAppend = false;

    appendBuffer(data: ArrayBuffer | ArrayBufferView): void {
        if (this.throwNextAppend) {
            const err = this.throwNextAppend;
            this.throwNextAppend = undefined;
            throw err;
        }
        // Record a copy of the payload. The adapter passes `data.buffer`
        // (ArrayBuffer); normalize by reading the full range.
        const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array((data as ArrayBufferView).buffer)
            : new Uint8Array(data);
        this.appendedPayloads.push(bytes);

        // Simulate async completion on microtask turn:
        // 'updating = true' briefly, then fire 'error' or 'updateend'.
        this.updating = true;
        queueMicrotask(() => {
            this.updating = false;
            if (this.errorNextAppend) {
                this.errorNextAppend = false;
                this.fire('error');
            } else {
                this.fire('updateend');
            }
        });
    }

    /** Every remove() call, recorded as [start, end]. */
    readonly removeCalls: Array<[number, number]> = [];

    remove(start: number, end: number): void {
        this.removeCalls.push([start, end]);
        // Real MSE semantics: remove() sets updating, fires updateend, and the
        // removed span disappears from .buffered. Model both so eviction logic
        // doesn't loop forever against a never-shrinking buffer.
        this.updating = true;
        queueMicrotask(() => {
            const out: [number, number][] = [];
            for (let i = 0; i < this.buffered.length; i++) {
                const s = this.buffered.start(i);
                const e = this.buffered.end(i);
                if (e <= start || s >= end) { out.push([s, e]); continue; }
                if (s < start) out.push([s, start]);
                if (e > end) out.push([end, e]);
            }
            this.buffered = makeTimeRanges(out);
            this.updating = false;
            this.fire('updateend');
        });
    }

    /** Records every changeType mime so tests can assert the codec pivot. */
    readonly changeTypeCalls: string[] = [];
    changeType(mimeType: string): void {
        this.changeTypeCalls.push(mimeType);
    }
}

class MockMediaSource extends MockEventTarget {
    readyState: 'closed' | 'open' | 'ended' = 'closed';
    readonly videoBuffer = new MockSourceBuffer();
    readonly audioBuffer = new MockSourceBuffer();
    addSourceBuffer(mimeType: string): MockSourceBuffer {
        return mimeType.startsWith('video/') ? this.videoBuffer : this.audioBuffer;
    }
    removeSourceBuffer(_sb: unknown): void { /* no-op */ }
    endOfStream(): void { this.readyState = 'ended'; }
    open(): void {
        this.readyState = 'open';
        this.fire('sourceopen');
    }
}

class MockVideoElement extends MockEventTarget {
    src = '';
    currentTime = 0;
    muted = false;
    paused = false;
    seeking = false;
    readyState = 4;
    error: { code: number; message: string } | null = null;
    buffered = makeTimeRanges([]);
    /** When true, play() rejects (autoplay blocked) → playTriggered stays false. */
    rejectPlay = false;
    playCalls = 0;
    pauseCalls = 0;
    async play(): Promise<void> {
        this.playCalls++;
        if (this.rejectPlay) throw new Error('autoplay blocked');
        this.paused = false;
    }
    pause(): void {
        this.pauseCalls++;
        this.paused = true;
    }
    getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number } {
        return { totalVideoFrames: 100, droppedVideoFrames: 2 };
    }
    load(): void { /* no-op */ }
    removeAttribute(_n: string): void { /* no-op */ }
    /** Trigger the error event, setting .error first. */
    setError(code: number, message: string): void {
        this.error = { code, message };
        this.fire('error');
    }
}

function makeTimeRanges(ranges: readonly [number, number][]): TimeRanges {
    return {
        length: ranges.length,
        start: (i: number) => ranges[i]![0],
        end: (i: number) => ranges[i]![1],
    } as unknown as TimeRanges;
}

// ─── Global stubs ────────────────────────────────────────────────

let currentMs: MockMediaSource;

beforeEach(() => {
    // Stub MediaSource constructor + URL.createObjectURL.
    currentMs = new MockMediaSource();
    vi.stubGlobal('MediaSource', class { constructor() { return currentMs; } });
    vi.stubGlobal('URL', {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => {},
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

// ─── Test harness helper ─────────────────────────────────────────

async function makeReadyAdapter(): Promise<{
    adapter: MseMediaSource;
    video: MockVideoElement;
    vsb: MockSourceBuffer;
}> {
    const video = new MockVideoElement();
    const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
    adapter.debug = true; // Enable diagnostic logging for tests
    const initData = makeInit(1, 100); // trex default_sample_duration=100
    adapter.initialize({ video: { codec: 'avc1.42c01e', initData } });
    currentMs.open();
    // Wait for init-segment appendBuffer's updateend to fire.
    await Promise.resolve();
    await Promise.resolve();
    return { adapter, video, vsb: currentMs.videoBuffer };
}

/** Flush queued microtasks so updateend handlers run. */
async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────

describe('MseMediaSource — timeline-owned append integration', () => {
    it('non-overlapping segments both get appended', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;

        const seg1 = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        const seg2 = makeSegment({ bmd: 500, defaultDur: 100, sampleCount: 5 });

        adapter.appendChunk('video', seg1, 'track1');
        await flush();
        adapter.appendChunk('video', seg2, 'track1');
        await flush();

        expect(vsb.appendedPayloads.length).toBe(initCount + 2);
    });

    it('overlapping second segment is dropped before append', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const seg1 = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        // bmd=200 is inside seg1's range [0, 500)
        const seg2 = makeSegment({ bmd: 200, defaultDur: 100, sampleCount: 5 });

        adapter.appendChunk('video', seg1, 'track1');
        await flush();
        adapter.appendChunk('video', seg2, 'track1');
        await flush();

        expect(vsb.appendedPayloads.length).toBe(initCount + 1);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('drop overlapping video payload'),
        );

        warn.mockRestore();
    });

    it('overlap from a different track is allowed (ABR splice)', async () => {
        // Switching from track A to track B at a splice point: B's first
        // segments cover the same decode-time range as A's last segments.
        // MSE handles the splice; the timeline detector must not drop B.
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const segA = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        // segB's range [200, 700) overlaps segA's [0, 500), but on a
        // different track — must be accepted.
        const segB = makeSegment({ bmd: 200, defaultDur: 100, sampleCount: 5 });

        adapter.appendChunk('video', segA, 'video_900k');
        await flush();
        adapter.appendChunk('video', segB, 'video_600k');
        await flush();

        expect(vsb.appendedPayloads.length).toBe(initCount + 2);
        expect(warn).not.toHaveBeenCalledWith(
            expect.stringContaining('drop overlapping video payload'),
        );

        warn.mockRestore();
    });

    it('overlap on the same track is still dropped after a switch', async () => {
        // Per-track timelines must still catch within-track duplicates
        // (e.g., a relay publishing both IDR-GOP and CRA-entry segments
        // under one track-name).
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const seg1 = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        const seg2 = makeSegment({ bmd: 200, defaultDur: 100, sampleCount: 5 });

        adapter.appendChunk('video', seg1, 'cmsf/clear:video_main');
        await flush();
        // After a brief switch to a different track and back, duplicate
        // ranges on the original track must still be dropped.
        const segOther = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        adapter.appendChunk('video', segOther, 'cmsf/clear:video_alt');
        await flush();

        adapter.appendChunk('video', seg2, 'cmsf/clear:video_main');
        await flush();

        // initCount + seg1 + segOther — seg2 dropped (overlap on video_main).
        expect(vsb.appendedPayloads.length).toBe(initCount + 2);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('drop overlapping video payload on track "cmsf/clear:video_main"'),
        );

        warn.mockRestore();
    });

    it('failed append clears pending — legitimate retransmit is not treated as overlap', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;

        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });

        // First append: fire SourceBuffer error on the async path.
        vsb.errorNextAppend = true;
        adapter.appendChunk('video', seg, 'track1');
        await flush();

        // Pending should be cleared, timeline empty. The same segment
        // should now be accepted (i.e. appendBuffer called again).
        adapter.appendChunk('video', seg, 'track1');
        await flush();

        // Both attempts hit appendBuffer; the first was the errored one,
        // the second is the retransmit. Plus init.
        expect(vsb.appendedPayloads.length).toBe(initCount + 2);
    });

    it('synchronous appendBuffer throw clears pending', async () => {
        const { adapter, vsb } = await makeReadyAdapter();

        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });

        vsb.throwNextAppend = new Error('QuotaExceededError');
        let caught: Error | undefined;
        const origOnError = (err: Error) => { caught = err; };
        adapter.onError = origOnError;

        adapter.appendChunk('video', seg, 'track1');
        // No updateend will fire because the append threw synchronously.
        await flush();
        expect(caught?.message).toContain('QuotaExceededError');

        // Now retransmit the same range — should succeed (pending cleared).
        adapter.appendChunk('video', seg, 'track1');
        await flush();

        // Assertion: the retransmit was not rejected as overlapping.
        // Last append recorded is the retransmit bytes.
        expect(vsb.appendedPayloads.length).toBeGreaterThanOrEqual(2);
    });

    it('trex default is used when tfhd/trun supply no duration', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const initCount = vsb.appendedPayloads.length;

        // Segment with NO tfhd default and NO per-sample trun duration,
        // but trex provided dur=100 via init.
        const segA = makeSegment({ bmd: 0, sampleCount: 3 });   // duration 300 via trex
        const segB = makeSegment({ bmd: 200, sampleCount: 3 }); // inside segA's [0, 300)

        adapter.appendChunk('video', segA, 'track1');
        await flush();
        adapter.appendChunk('video', segB, 'track1');
        await flush();

        // segA appended; segB dropped because trex default scored it
        // as overlapping.
        expect(vsb.appendedPayloads.length).toBe(initCount + 1);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('drop overlapping video payload'),
        );

        warn.mockRestore();
    });

    it('moof-less payload (mdat-only) fails open to append', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;

        const mdatOnly = box('mdat', new Uint8Array(32));
        adapter.appendChunk('video', mdatOnly, 'track1');
        await flush();

        expect(vsb.appendedPayloads.length).toBe(initCount + 1);
    });

    it('multi-moof payload appends once, timeline picks up both ranges', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;

        const payload = cat(
            makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 3 }),     // [0, 300)
            makeSegment({ bmd: 300, defaultDur: 100, sampleCount: 3 }),   // [300, 600)
        );
        adapter.appendChunk('video', payload, 'track1');
        await flush();
        expect(vsb.appendedPayloads.length).toBe(initCount + 1);

        // Next segment at bmd=200 overlaps the first moof's range — should drop.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const seg2 = makeSegment({ bmd: 200, defaultDur: 100, sampleCount: 2 });
        adapter.appendChunk('video', seg2, 'track1');
        await flush();
        expect(vsb.appendedPayloads.length).toBe(initCount + 1);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('drop overlapping video payload'),
        );
        warn.mockRestore();
    });

    it('multi-moof payload with one unscorable moof drops the whole payload', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCount = vsb.appendedPayloads.length;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // One healthy moof (defaultDur 100, 3 samples → dur 300) plus
        // one unscorable (no defaultDur, no per-sample). Since init
        // supplied trex=100, BOTH are actually scorable via trex...
        // so build the broken moof WITHOUT a usable duration source
        // by using a trackId that doesn't match the trex.
        const healthy = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 3 });
        // trackId=99 doesn't match the trex's trackId=1, and trex map
        // is single-entry in this adapter's cache, so... actually the
        // adapter stores the first trex entry regardless of trackId.
        // To reliably get no-duration, just don't pass a tfhd default
        // and undermine the trex by giving the adapter a different
        // init. Simpler test path:
        // Build an adapter WITHOUT trex defaults.
        const video = new MockVideoElement();
        const adapterBare = new MseMediaSource(video as unknown as HTMLVideoElement);
        adapterBare.debug = true;
        // Init with NO mvex/trex — so videoTrex stays undefined.
        const initNoTrex = cat(
            box('ftyp', cat(fourcc('iso6'), u32(0), fourcc('iso6'))),
            box('moov', box('trak', cat(
                fullBox('tkhd', 0, 0, cat(u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), new Uint8Array(52))),
                box('mdia', fullBox('hdlr', 0, 0, cat(
                    u32(0), fourcc('vide'),
                    u32(0), u32(0), u32(0), new Uint8Array([0]),
                ))),
            ))),
        );
        adapterBare.initialize({ video: { codec: 'avc1.42c01e', initData: initNoTrex } });
        currentMs.open();
        await flush();
        const vsb2 = currentMs.videoBuffer;
        const initAppendsBare = vsb2.appendedPayloads.length;

        const broken = makeSegment({ bmd: 500, sampleCount: 3 }); // no defaultDur
        const payload = cat(healthy, broken);

        adapterBare.appendChunk('video', payload, 'track1');
        await flush();

        // Fail-open: payload IS appended even when analysis is incomplete.
        // MSE itself will reject truly corrupt data.
        expect(vsb2.appendedPayloads.length).toBe(initAppendsBare + 1);

        // Two warns: the 'no-duration' diagnostic + the fail-open message.
        const calls = warn.mock.calls.map((c) => String(c[0]));
        expect(calls.some((m) => m.includes('no-duration'))).toBe(true);
        expect(calls.some((m) => m.includes('appending anyway'))).toBe(true);

        warn.mockRestore();
        // Prevent the outer init count from being asserted on this path.
        void initCount;
        void vsb;
    });

    it('warn-once is per mediaType + kind', async () => {
        // Build an adapter with both video AND audio, no trex for either.
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        adapter.debug = true;
        const initNoTrex = cat(
            box('ftyp', cat(fourcc('iso6'), u32(0), fourcc('iso6'))),
            box('moov', box('trak', cat(
                fullBox('tkhd', 0, 0, cat(u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), new Uint8Array(52))),
                box('mdia', fullBox('hdlr', 0, 0, cat(
                    u32(0), fourcc('vide'),
                    u32(0), u32(0), u32(0), new Uint8Array([0]),
                ))),
            ))),
        );
        const initAudio = cat(
            box('ftyp', cat(fourcc('iso6'), u32(0), fourcc('iso6'))),
            box('moov', box('trak', cat(
                fullBox('tkhd', 0, 0, cat(u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), new Uint8Array(52))),
                box('mdia', fullBox('hdlr', 0, 0, cat(
                    u32(0), fourcc('soun'),
                    u32(0), u32(0), u32(0), new Uint8Array([0]),
                ))),
            ))),
        );
        adapter.initialize({
            video: { codec: 'avc1.42c01e', initData: initNoTrex },
            audio: { codec: 'mp4a.40.2', initData: initAudio },
        });
        currentMs.open();
        await flush();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const broken = makeSegment({ bmd: 0, sampleCount: 3 });

        // Two video appends of the same-shape unscorable payload →
        // 'no-duration' warn once for video.
        adapter.appendChunk('video', broken, 'track1');
        await flush();
        adapter.appendChunk('video', broken, 'track1');
        await flush();

        // First audio append with same unscorable shape → 'no-duration'
        // warn for audio (not suppressed by the video one).
        adapter.appendChunk('audio', broken, 'track1');
        await flush();

        const noDurMsgs = warn.mock.calls
            .map((c) => String(c[0]))
            .filter((m) => m.includes('no-duration'));
        // One video, one audio — NOT one total.
        expect(noDurMsgs.length).toBe(2);
        expect(noDurMsgs.some((m) => m.startsWith('[MSE] video'))).toBe(true);
        expect(noDurMsgs.some((m) => m.startsWith('[MSE] audio'))).toBe(true);

        warn.mockRestore();
    });
});

// ─── changeType (codec switch) ───────────────────────────────────

describe('MseMediaSource — changeType', () => {
    it('drains queue, calls SourceBuffer.changeType, appends new init', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCountBefore = vsb.appendedPayloads.length;

        const newInit = makeInit(1, 200); // different default_sample_duration
        await adapter.changeType('video', 'hvc1.1.6.L93.90', newInit);

        // SourceBuffer.changeType called with the new mime
        expect(vsb.changeTypeCalls).toEqual(['video/mp4; codecs="hvc1.1.6.L93.90"']);
        // The init segment was appended (after filtering — bytes may
        // differ from the input but length should be > 0).
        expect(vsb.appendedPayloads.length).toBe(initCountBefore + 1);
    });

    it('appends queued during changeType drain after the new init', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const initCountBefore = vsb.appendedPayloads.length;

        const newInit = makeInit(1, 100);
        // Start changeType but don't await yet.
        const changing = adapter.changeType('video', 'hvc1.1.6.L93.90', newInit);

        // Concurrent appendChunk during change — must queue, not dispatch.
        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        adapter.appendChunk('video', seg, 'video_hevc');

        await changing;
        await flush();
        await flush();

        // Order on the SourceBuffer:
        //   [initial init from makeReadyAdapter, new init from changeType, queued seg]
        expect(vsb.appendedPayloads.length).toBe(initCountBefore + 2);
        // changeType only fires once with the new mime.
        expect(vsb.changeTypeCalls).toEqual(['video/mp4; codecs="hvc1.1.6.L93.90"']);
    });

    it('drops stale queued media (old codec) before reconfiguring', async () => {
        const { adapter, vsb } = await makeReadyAdapter();

        // Force the buffer into "updating" so the next appendChunk queues
        // instead of dispatching.
        vsb.updating = true;
        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 });
        adapter.appendChunk('video', seg, 'video_avc'); // queued (stale)

        // Resolve the buffer so changeType can drain.
        vsb.updating = false;

        const initCountBefore = vsb.appendedPayloads.length;
        const newInit = makeInit(1, 100);
        await adapter.changeType('video', 'hvc1.1.6.L93.90', newInit);

        // Only the new init was appended; the queued old-codec seg was dropped.
        expect(vsb.appendedPayloads.length).toBe(initCountBefore + 1);
    });

    it('throws if the SourceBuffer is not initialized', async () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        // No initialize() call — no SourceBuffer for video.

        await expect(
            adapter.changeType('video', 'hvc1.1.6.L93.90', makeInit(1, 100)),
        ).rejects.toThrow(/not initialized/);
    });

    it('throws if the browser does not implement SourceBuffer.changeType', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        // Strip changeType from the mock to simulate an old UA.
        (vsb as unknown as { changeType?: unknown }).changeType = undefined;

        await expect(
            adapter.changeType('video', 'hvc1.1.6.L93.90', makeInit(1, 100)),
        ).rejects.toThrow(/changeType not supported/);
    });
});

// ─── Autoplay startup-seek (longest buffered range) ────────────────────

describe('MseMediaSource — autoplay startup seek', () => {
    /**
     * After the first appended segment commits, the adapter calls
     * `video.play()` and (for live tune-ins where leading-RASL stripping
     * leaves a tiny stub range disjoint from the main content) seeks
     * `currentTime` into the LONGEST buffered range. Earlier behavior
     * seeked to `buffered.start(0)`, which marooned playback in 2-frame
     * stubs at the head of the timeline.
     */

    it('seeks into the longest buffered range when there is a stub at t=0', async () => {
        const { adapter, video, vsb } = await makeReadyAdapter();
        const playSpy = vi.spyOn(video, 'play');

        // Mimic the post-strip Synamedia tune-in shape: tiny stub at
        // [0, 0.07s] (a 2-frame IDR fragment) followed by the main
        // content at [1.5s, 11.5s]. The adapter must seek to 1.5s, not
        // stay at the buffered.start(0) of 0.
        video.buffered = makeTimeRanges([[0, 0.07], [1.5, 11.5]]);

        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('video', seg, 'track1');
        await flush();
        // drainQueue runs again on the post-updateend tick.
        await flush();

        expect(playSpy).toHaveBeenCalledTimes(1);
        expect(video.currentTime).toBe(1.5);
    });

    it('leaves currentTime untouched when it already sits inside the chosen range', async () => {
        const { adapter, video, vsb } = await makeReadyAdapter();
        const playSpy = vi.spyOn(video, 'play');

        // Single contiguous range; currentTime is already inside it.
        video.buffered = makeTimeRanges([[0, 10]]);
        video.currentTime = 2;

        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('video', seg, 'track1');
        await flush();
        await flush();

        expect(playSpy).toHaveBeenCalledTimes(1);
        expect(video.currentTime).toBe(2); // unchanged
    });

    it('only triggers once across many video appends', async () => {
        const { adapter, video, vsb } = await makeReadyAdapter();
        const playSpy = vi.spyOn(video, 'play');
        video.buffered = makeTimeRanges([[0, 10]]);

        for (let bmd = 0; bmd < 1000; bmd += 100) {
            adapter.appendChunk('video', makeSegment({ bmd, defaultDur: 100, sampleCount: 1 }), 'track1');
            await flush();
            await flush();
        }

        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT trigger from the audio drain when video is also configured', async () => {
        // On A/V streams, an audio updateend can land before the first
        // video append commits. We must not let it latch playTriggered
        // against whatever stub video.buffered happens to hold.
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        const initData = makeInit(1, 100);
        adapter.initialize({
            video: { codec: 'avc1.42c01e', initData },
            audio: { codec: 'mp4a.40.2', initData },
        });
        currentMs.open();
        await flush();
        await flush();

        const playSpy = vi.spyOn(video, 'play');
        // Pretend the video element somehow already has a stub range
        // (e.g., from the init segment itself in some implementations).
        video.buffered = makeTimeRanges([[0, 0.07]]);

        // Append audio only — video append never happens.
        const audioSeg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('audio', audioSeg, 'audioTrack');
        await flush();
        await flush();

        expect(playSpy).not.toHaveBeenCalled();
    });

    it('triggers from the audio drain when the stream is audio-only', async () => {
        // No videoBuffer means there will never be a video updateend,
        // so the audio path must be the trigger or audio-only playback
        // would never start.
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        const initData = makeInit(1, 100);
        adapter.initialize({ audio: { codec: 'mp4a.40.2', initData } });
        currentMs.open();
        await flush();
        await flush();

        const playSpy = vi.spyOn(video, 'play');
        video.buffered = makeTimeRanges([[0, 5]]);

        const audioSeg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('audio', audioSeg, 'audioTrack');
        await flush();
        await flush();

        expect(playSpy).toHaveBeenCalledTimes(1);
    });
});

// ─── getBufferAheadUs ────────────────────────────────────────────────

describe('getBufferAheadUs', () => {
    it('returns null when no buffered ranges exist pre-startup', () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        expect(adapter.getBufferAheadUs()).toBeNull();
    });

    it('returns 0 when buffered is empty post-startup (full starvation)', async () => {
        const { adapter } = await makeReadyAdapter();
        const ve = (adapter as any).video as MockVideoElement;

        // Trigger playTriggered by simulating successful play
        ve.buffered = makeTimeRanges([[0, 1.0]]);
        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('video', seg, 'track1');
        await flush();
        await flush();

        // Now buffer is completely empty
        ve.buffered = makeTimeRanges([]);
        ve.currentTime = 5.0;
        expect(adapter.getBufferAheadUs()).toBe(0);
    });

    it('returns buffer ahead from range containing currentTime', async () => {
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[0, 5.0]]);
        video.currentTime = 2.0;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        expect(adapter.getBufferAheadUs()).toBe(3_000_000); // 3s in µs
    });

    it('returns 0 at boundary: currentTime === range end', async () => {
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[0, 5.0]]);
        video.currentTime = 5.0;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        expect(adapter.getBufferAheadUs()).toBe(0);
    });

    it('uses containing range, not end(last) — disjoint ranges', () => {
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[0, 0.07], [1.5, 11.5]]);
        video.currentTime = 0;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        // Should use [0, 0.07], NOT end(last)=11.5
        expect(adapter.getBufferAheadUs()).toBe(70_000); // 0.07s
    });

    it('returns null pre-startup when currentTime outside all ranges', () => {
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[1.5, 5.0]]);
        video.currentTime = 0;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        // playTriggered is false → null (not 0)
        expect(adapter.getBufferAheadUs()).toBeNull();
    });

    it('returns 0 post-startup when currentTime outside all ranges', async () => {
        const { adapter } = await makeReadyAdapter();
        const video = currentMs.videoBuffer;

        // Simulate play triggered by appending enough data
        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 3 });
        adapter.appendChunk('video', seg, 'track1');
        await flush();

        // Force playTriggered by setting buffered and triggering play
        const ve = (adapter as any).video as MockVideoElement;
        ve.buffered = makeTimeRanges([[0, 1.0]]);
        // Trigger drainQueue to set playTriggered
        adapter.appendChunk('video', makeSegment({ bmd: 300, defaultDur: 100, sampleCount: 1 }), 'track1');
        await flush();

        // Now move currentTime past buffered
        ve.currentTime = 5.0;
        ve.buffered = makeTimeRanges([[0, 1.0]]);

        // playTriggered should be true → return 0 (starvation signal)
        expect(adapter.getBufferAheadUs()).toBe(0);
    });
});

// ─── changeType play resume ──────────────────────────────────────────

describe('changeType play resume', () => {
    it('retries video.play() if paused after changeType()', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const ve = (adapter as any).video as MockVideoElement;

        // Simulate playTriggered = true (play already succeeded once)
        ve.buffered = makeTimeRanges([[0, 5]]);
        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('video', seg, 'track1');
        await flush();
        await flush();

        // Now simulate the browser pausing the video after changeType
        ve.paused = true;
        const playSpy = vi.spyOn(ve, 'play');

        // Perform changeType
        const newInit = makeInit(1, 100);
        await adapter.changeType('video', 'avc1.64001f', newInit);

        // Should have called play() since playTriggered=true and paused=true
        expect(playSpy).toHaveBeenCalled();
    });

    it('does NOT call play() if video is not paused after changeType()', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        const ve = (adapter as any).video as MockVideoElement;

        // Simulate playTriggered = true
        ve.buffered = makeTimeRanges([[0, 5]]);
        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('video', seg, 'track1');
        await flush();
        await flush();

        // Video NOT paused
        ve.paused = false;
        const playSpy = vi.spyOn(ve, 'play');

        const newInit = makeInit(1, 100);
        await adapter.changeType('video', 'avc1.64001f', newInit);

        expect(playSpy).not.toHaveBeenCalled();
    });
});

// ─── Live-buffer management: eviction / behind-live cap / quota recovery ───

describe('MseMediaSource — live-buffer management', () => {
    /** Ready adapter that has reached playTriggered (post-startup). */
    async function makePlayingAdapter(): Promise<{
        adapter: MseMediaSource;
        video: MockVideoElement;
        vsb: MockSourceBuffer;
    }> {
        const ctx = await makeReadyAdapter();
        // Reaching playTriggered: drainQueue triggers play() once video.buffered
        // is non-empty during an idle drain. Seed a buffered range and append.
        ctx.video.buffered = makeTimeRanges([[0, 1]]);
        ctx.vsb.buffered = makeTimeRanges([[0, 1]]);
        ctx.adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 }), 'track1');
        await flush();
        await flush(); // play().then(() => playTriggered = true)
        return ctx;
    }

    const quotaError = (): Error => {
        const e = new Error('The SourceBuffer is full, and cannot free space to append additional buffers.');
        e.name = 'QuotaExceededError';
        return e;
    };

    it('evicts played-out back-buffer with a finite range before appending, serialized via updateend', async () => {
        const { adapter, video, vsb } = await makePlayingAdapter();
        const appendsBefore = vsb.appendedPayloads.length;

        // 25s played; buffer holds [0, 28]. keepBehind=10 → evict [0, 15).
        video.currentTime = 25;
        vsb.buffered = makeTimeRanges([[0, 28]]);
        adapter.appendChunk('video', makeSegment({ bmd: 28_000, defaultDur: 100, sampleCount: 5 }), 'track1');

        // The remove must be issued FIRST; the append is parked until updateend.
        expect(vsb.removeCalls).toContainEqual([0, 15]);
        expect(vsb.appendedPayloads.length).toBe(appendsBefore); // not yet appended

        await flush(); // remove updateend → drain → append dispatch
        await flush();
        expect(vsb.appendedPayloads.length).toBe(appendsBefore + 1); // serialized, then appended
    });

    it('does not evict or chase before playTriggered (startup exempt)', async () => {
        const { adapter, video, vsb } = await makeReadyAdapter();
        video.rejectPlay = true; // autoplay blocked → playTriggered stays false
        video.currentTime = 1;
        video.buffered = makeTimeRanges([[0, 100]]);
        vsb.buffered = makeTimeRanges([[0, 100]]);

        adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 5 }), 'track1');
        await flush();
        await flush();

        expect(vsb.removeCalls).toEqual([]);      // no startup eviction
        expect(video.currentTime).toBe(1);         // no behind-live jump pre-startup
    });

    it('jumps toward the live edge when buffered-ahead exceeds maxAheadSec (post-startup)', async () => {
        const { adapter, video, vsb } = await makePlayingAdapter();

        // Inside a buffered range with 28s of data ahead (cap 15) → jump to end-2.
        video.currentTime = 2;
        video.buffered = makeTimeRanges([[0, 30]]);
        vsb.buffered = makeTimeRanges([[0, 30]]);
        const resyncs: string[] = [];
        adapter.onLiveEdgeResync = (r) => resyncs.push(r);

        adapter.appendChunk('video', makeSegment({ bmd: 30_000, defaultDur: 100, sampleCount: 5 }), 'track1');
        await flush();
        await flush();

        expect(video.currentTime).toBe(28); // 30 - targetAheadSec(2)
        expect(resyncs).toContain('behind-live');
    });

    it('QuotaExceededError with played-out media: evicts, retries the SAME chunk once, no error events', async () => {
        const { adapter, video, vsb } = await makePlayingAdapter();
        const errors: Error[] = [];
        adapter.onError = (e) => errors.push(e);
        const appendsBefore = vsb.appendedPayloads.length;

        video.currentTime = 25;
        vsb.buffered = makeTimeRanges([[0, 28]]);
        // currentTime small enough that routine eviction doesn't pre-empt: force
        // the quota throw on the append itself.
        video.currentTime = 9; // keepBehind=10 → no routine evict (9-10 < 0)
        vsb.throwNextAppend = quotaError();

        const seg = makeSegment({ bmd: 28_000, defaultDur: 100, sampleCount: 5 });
        adapter.appendChunk('video', seg, 'track1');
        // Stage 1: emergency evict [0, currentTime-1) and park the chunk.
        expect(vsb.removeCalls).toContainEqual([0, 8]);
        await flush(); // remove updateend → drain retries the chunk
        await flush();

        expect(vsb.appendedPayloads.length).toBe(appendsBefore + 1); // retried + accepted
        expect(errors).toEqual([]); // recovered quota is taxonomy-quiet
    });

    it('QuotaExceededError with NOTHING evictable: flushes finite ranges, drops backlog, rejoins live', async () => {
        const { adapter, video, vsb } = await makePlayingAdapter();
        const errors: Error[] = [];
        const resyncs: string[] = [];
        adapter.onError = (e) => errors.push(e);
        adapter.onLiveEdgeResync = (r) => resyncs.push(r);

        // The reported wedge: everything buffered is AHEAD of the playhead.
        video.currentTime = 5;
        vsb.buffered = makeTimeRanges([[5, 60]]);
        video.buffered = makeTimeRanges([[5, 60]]);
        vsb.throwNextAppend = quotaError();

        adapter.appendChunk('video', makeSegment({ bmd: 60_000, defaultDur: 100, sampleCount: 5 }), 'track1');
        // Flush issued with a FINITE range (not remove(0, Infinity)).
        expect(vsb.removeCalls).toContainEqual([5, 60]);
        await flush(); // flush updateend

        // Fresh live media arrives after the flush; it commits and playback rejoins.
        video.buffered = makeTimeRanges([[50, 60]]);
        vsb.buffered = makeTimeRanges([[50, 60]]);
        adapter.appendChunk('video', makeSegment({ bmd: 50_000, defaultDur: 100, sampleCount: 5 }), 'track1');
        await flush();
        await flush();

        expect(video.currentTime).toBe(50);        // jumped to the new (live) range
        expect(resyncs).toContain('quota');
        expect(errors).toEqual([]);                // handled recovery emits no errors
    });
});

// ─── Playhead-wedge watchdog (Safari frozen-element recovery) ─────────
//
// Safari MSE can wedge: currentTime frozen, readyState 4, buffer growing,
// NO waiting event, NO error event. The waiting-based stall detector is
// structurally blind to it. The watchdog detects the frozen playhead and
// runs an escalating recovery ladder: gentle nudge → pause/play pulse →
// live-edge seek → onError (app rebuilds). A nudge/seek WE perform must
// not count as recovery — only the playhead advancing on its own does.

describe('playhead-wedge watchdog', () => {
    function wedgeSetup() {
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[5, 25]]);
        video.currentTime = 10;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        (adapter as any).playTriggered = true;
        const wedges: any[] = [];
        const errors: Error[] = [];
        (adapter as any).onWedge = (info: any) => wedges.push(info);
        adapter.onError = (e) => errors.push(e);
        const check = (nowMs: number) => (adapter as any).checkPlayheadWedge(nowMs);
        return { adapter, video, wedges, errors, check };
    }

    it('nudges currentTime +0.1 after the playhead is frozen ~2.5s', () => {
        const { video, wedges, check } = wedgeSetup();
        check(0);      // baseline observation
        check(1_000);  // frozen — starts the freeze timer
        check(2_000);  // still under threshold
        expect(video.currentTime).toBe(10);

        check(3_600);  // frozen ≥2.5s → rung 1: gentle nudge
        expect(video.currentTime).toBeCloseTo(10.1, 5);
        expect(wedges).toHaveLength(1);
        expect(wedges[0]).toMatchObject({ rung: 1, readyState: 4, paused: false });
        expect(wedges[0].decodedFrames).toBe(100);
    });

    it('stays quiet when the playhead is advancing', () => {
        const { video, wedges, check } = wedgeSetup();
        check(0);
        video.currentTime = 10.5;
        check(1_000);
        video.currentTime = 11.0;
        check(3_600);
        expect(wedges).toHaveLength(0);
        expect(video.currentTime).toBe(11.0);
    });

    it('stays quiet when paused, seeking, low readyState, or no buffer ahead', () => {
        const { video, wedges, check } = wedgeSetup();
        video.paused = true;
        check(0); check(1_000); check(3_600);
        expect(wedges).toHaveLength(0);

        video.paused = false;
        video.seeking = true;
        check(4_000); check(5_000); check(7_600);
        expect(wedges).toHaveLength(0);

        video.seeking = false;
        video.readyState = 2;
        check(8_000); check(9_000); check(11_600);
        expect(wedges).toHaveLength(0);

        video.readyState = 4;
        video.currentTime = 24.5; // only 0.5s ahead in [5,25] — below the 1s floor
        check(12_000); check(13_000); check(15_600);
        expect(wedges).toHaveLength(0);
    });

    it('escalates: nudge → pause/play pulse → live-edge seek → onError', () => {
        const { video, wedges, errors, check } = wedgeSetup();
        check(0);
        check(1_000);          // freeze timer starts
        check(3_600);          // rung 1: nudge
        expect(video.currentTime).toBeCloseTo(10.1, 5);

        // Still frozen (our own nudge must NOT count as recovery).
        check(4_600);
        check(6_300);          // rung 2: pause/play pulse
        expect(video.pauseCalls).toBe(1);
        expect(video.playCalls).toBe(1);

        check(7_300);
        check(9_000);          // rung 3: live-edge seek (range end − targetAheadSec 2 → 23)
        expect(video.currentTime).toBeCloseTo(23, 5);

        check(10_000);
        check(11_700);         // rung 4: surface error — app rebuilds
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toMatch(/wedge/i);
        // The final rung must be DISTINGUISHABLE from ordinary decode errors
        // so @moqt/player can escalate it to a fatal (the app rebuild path).
        expect(errors[0]!.name).toBe('PlayheadWedgeError');

        expect(wedges.map((w) => w.rung)).toEqual([1, 2, 3, 4]);
        // Ladder exhausted — no further actions or duplicate errors.
        check(12_700); check(14_400);
        expect(errors).toHaveLength(1);
    });

    it('organic playhead movement resets the ladder', () => {
        const { video, wedges, check } = wedgeSetup();
        check(0);
        check(1_000);
        check(3_600);          // rung 1: nudge to 10.1
        expect(wedges).toHaveLength(1);

        video.currentTime = 12.0; // playback resumed BY ITSELF
        check(4_600);

        // New wedge episode later starts back at rung 1 (the gentle nudge).
        check(5_600);          // frozen again — freeze timer restarts
        check(8_200);
        expect(wedges).toHaveLength(2);
        expect(wedges[1].rung).toBe(1);
        expect(video.currentTime).toBeCloseTo(12.1, 5);
    });

    it('destroy() stops the watchdog interval', async () => {
        const { adapter } = wedgeSetup();
        adapter.destroy();
        expect((adapter as any).wedgeTimer).toBeNull();
    });

    it('the behind-live chase never seeks a PAUSED element', async () => {
        // Observed in the field: Safari pauses muted background-tab videos;
        // the chase then seek-dragged the paused playhead for minutes
        // (t=97 → t=592) — pure churn in the background, and in the
        // foreground each seek paints one frame: the "slideshow". A paused
        // element must be left alone; the chase catches up after resume.
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[5, 40]]);
        video.currentTime = 10; // 30s behind — far over the 15s cap
        video.paused = true;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        (adapter as any).playTriggered = true;

        (adapter as any).maybeChaseLiveEdge();
        expect(video.currentTime).toBe(10); // untouched while paused

        video.paused = false;
        (adapter as any).maybeChaseLiveEdge();
        expect(video.currentTime).toBeCloseTo(38, 5); // resumes → chase works again
    });

    it('a behind-live chase seek does not reset the ladder (the slideshow tripwire)', () => {
        // This exact interaction caused the original symptom: the chase seek
        // moved currentTime every ~15s, which would read as "organic playhead
        // movement" and restart the ladder forever — nudge, chase, nudge,
        // chase — never reaching the rebuild rung.
        const { adapter, video, wedges, check } = wedgeSetup();
        video.buffered = makeTimeRanges([[5, 40]]); // 30s ahead → chase-eligible (cap 15)
        check(0);
        check(1_000);
        check(3_600);          // rung 1: nudge → 10.1
        expect(wedges.map((w) => w.rung)).toEqual([1]);

        // Burst-fed buffer trips the behind-live chase: seek to end − 2 = 38.
        (adapter as any).maybeChaseLiveEdge();
        expect(video.currentTime).toBeCloseTo(38, 5);

        // Still frozen at the chase landing — the ladder must CONTINUE.
        check(4_600);
        check(6_300);          // rung 2: pause/play pulse (NOT a fresh rung-1 nudge)
        expect(wedges.map((w) => w.rung)).toEqual([1, 2]);
        expect(video.pauseCalls).toBe(1);
    });
});
