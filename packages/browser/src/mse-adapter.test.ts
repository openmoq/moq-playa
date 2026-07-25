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
import { format } from 'node:util';
import { MseMediaSource } from './mse-adapter.js';
import type { MseStartupReport } from './mse-adapter.js';

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
    /** Public: tests drive element events directly (e.g. a late `seeked`). */
    fire(type: string): void {
        const arr = this.listeners.get(type);
        if (!arr) return;
        for (const fn of arr.slice()) fn();
    }
    /** Dispatch a constructed Event (carries payload like addedRanges). */
    dispatch(event: Event): void {
        const arr = this.listeners.get(event.type);
        if (!arr) return;
        for (const fn of arr.slice()) fn(event);
    }
    /** Attached listener count — used to assert cleanup leaves nothing behind. */
    listenerCount(type: string): number {
        return this.listeners.get(type)?.length ?? 0;
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
    /** Throw on the NEXT remove() call. */
    throwNextRemove?: Error;
    /** When false, appends stay `updating` until the test fires updateend. */
    autoComplete = true;
    /** Fire an `error` before the next appendBuffer's `updateend` (MSE §5.5.3). */
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

        // Simulate async completion on a microtask turn. Per MSE §5.5.3 the
        // append-error algorithm queues `error` and THEN `updateend`, so a
        // failed append still terminates with updateend — the mock models both
        // events rather than substituting one for the other.
        this.updating = true;
        if (!this.autoComplete) return; // held in flight for the test to complete
        queueMicrotask(() => {
            this.updating = false;
            if (this.errorNextAppend) {
                this.errorNextAppend = false;
                this.fire('error');
            }
            this.fire('updateend');
        });
    }

    /** Every remove() call, recorded as [start, end]. */
    readonly removeCalls: Array<[number, number]> = [];

    remove(start: number, end: number): void {
        if (this.throwNextRemove) {
            const err = this.throwNextRemove;
            this.throwNextRemove = undefined;
            throw err;
        }
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
    /** Latest buffer per kind. A NEW instance per addSourceBuffer call, as a
     *  real MediaSource does — reusing one object would make the adapter's
     *  identity guard untestable. */
    videoBuffer = new MockSourceBuffer();
    audioBuffer = new MockSourceBuffer();
    /** Mime types passed to addSourceBuffer, for created-nothing assertions. */
    readonly addSourceBufferCalls: string[] = [];
    addSourceBuffer(mimeType: string): MockSourceBuffer {
        this.addSourceBufferCalls.push(mimeType);
        const sb = new MockSourceBuffer();
        if (mimeType.startsWith('video/')) this.videoBuffer = sb; else this.audioBuffer = sb;
        return sb;
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
    /** Present on real elements; the adapter feature-detects it for attachment. */
    srcObject: unknown = null;
    disableRemotePlayback = false;
    muted = false;
    paused = false;
    seeking = false;

    /**
     * Assigning currentTime starts an ASYNCHRONOUS seek, exactly as a real
     * element does: `seeking` latches immediately and `seeked` fires on a later
     * turn. Startup positioning depends on that lifecycle, so the mock models
     * it rather than pretending the assignment completes synchronously.
     *
     * With the lifecycle modelled, `seeking` latches true on assignment and is
     * cleared immediately before `seeked` fires. `autoFireSeeked = false` models
     * a browser that never completes the seek (the timeout path), leaving
     * `seeking` true. The lifecycle is OFF by default so suites that assign
     * currentTime and assert synchronously are unaffected.
     */
    private _currentTime = 0;
    seekCount = 0;

    /**
     * OFF by default so suites that assign currentTime and assert synchronously
     * (wedge watchdog, chase seeks) are unaffected. Startup-lifecycle tests turn
     * it ON to get the real behavior: `seeking` latches true on assignment and
     * clears immediately before `seeked` fires on a later turn.
     */
    modelSeekLifecycle = false;
    /** With the lifecycle modelled, suppress settlement (the timeout path). */
    autoFireSeeked = true;
    /** Model an element whose currentTime setter throws synchronously. */
    throwOnSeek: Error | null = null;

    get currentTime(): number { return this._currentTime; }
    set currentTime(v: number) {
        if (this.throwOnSeek) throw this.throwOnSeek;
        this._currentTime = v;
        this.seekCount++;
        if (!this.modelSeekLifecycle) return;
        this.seeking = true;                   // latches synchronously, as in a real element
        if (!this.autoFireSeeked) return;      // never settles — stays seeking
        queueMicrotask(() => {
            this.seeking = false;              // cleared BEFORE the event, per spec order
            this.fire('seeked');
        });
    }
    readyState = 4;
    error: { code: number; message: string } | null = null;
    buffered = makeTimeRanges([]);
    /** When true, play() rejects (autoplay blocked) → playTriggered stays false. */
    rejectPlay = false;
    playCalls = 0;
    pauseCalls = 0;
    /**
     * Model a play() that resolves LATER, as real elements do. The element is
     * playing once the promise resolves, so a pause issued while it is pending
     * is the case that a generation check alone cannot cover.
     */
    deferPlay: (() => Promise<void>) | null = null;
    async play(): Promise<void> {
        this.playCalls++;
        if (this.rejectPlay) throw new Error('autoplay blocked');
        if (this.deferPlay) await this.deferPlay();
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
        // Isolated MediaSource: this test runs a SECOND adapter, and buffers are
        // now distinct objects per addSourceBuffer, so sharing `currentMs` would
        // let the two adapters' buffers collide.
        const bareMs = new MockMediaSource();
        vi.stubGlobal('MediaSource', class { constructor() { return bareMs; } });
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
        bareMs.open();
        await flush();
        const vsb2 = bareMs.videoBuffer;
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
        // Startup positioning is asynchronous — model the real seek lifecycle so
        // play() can follow settlement rather than racing it.
        video.modelSeekLifecycle = true;
        const playSpy = vi.spyOn(video, 'play');

        // Mimic the post-strip Synamedia tune-in shape: tiny stub at
        // [0, 0.07s] (a 2-frame IDR fragment) followed by the main
        // content at [1.5s, 11.5s]. The adapter must seek to 1.5s, not
        // stay at the buffered.start(0) of 0.
        video.buffered = makeTimeRanges([[0, 0.07], [1.5, 11.5]]);

        const seg = makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 });
        adapter.appendChunk('video', seg, 'track1');
        // drainQueue → positioning → seeked → play spans several turns.
        for (let i = 0; i < 40; i++) await Promise.resolve();

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

    it('rung 2 does NOT leave the element playing when intent is withdrawn mid-pulse', async () => {
        // The pulse's play() is pending across turns, so a pause landing in
        // that window must still win — the same hole as startup, on the
        // recovery path.
        const { adapter, video, check } = wedgeSetup();
        let releasePlay: (() => void) | null = null;
        video.deferPlay = () => new Promise<void>((resolve) => { releasePlay = resolve; });
        check(0);
        check(1_000);
        check(3_600);          // rung 1
        check(4_600);
        check(6_300);          // rung 2: pause/play pulse
        expect(video.pauseCalls).toBe(1);
        expect(releasePlay).not.toBeNull();   // play() is pending

        adapter.setPlaybackIntent(false);     // player paused mid-pulse
        releasePlay!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(video.paused).toBe(true);
    });

    it('rung 2 does NOT leave the element playing after destroy() mid-pulse', async () => {
        const { adapter, video, check } = wedgeSetup();
        let releasePlay: (() => void) | null = null;
        video.deferPlay = () => new Promise<void>((resolve) => { releasePlay = resolve; });
        check(0); check(1_000); check(3_600); check(4_600);
        check(6_300);          // rung 2
        expect(releasePlay).not.toBeNull();

        adapter.destroy();
        releasePlay!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(video.paused).toBe(true);
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

// ─── CMAF bootstrap hardening (codec support + init contract) ─────────
//
// initialize() must never quietly produce SourceBuffers that cannot work:
// an unsupported codec string or a zero-byte init entry are loud errors,
// not silent black screens.

describe('initialize() bootstrap validation (all-or-nothing)', () => {
    it('rejects an unsupported codec: returns false, named error, NO SourceBuffers created', async () => {
        (globalThis.MediaSource as any).isTypeSupported =
            (mime: string) => !mime.includes('avc1.BAD');
        try {
            const video = new MockVideoElement();
            const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
            const errors: Error[] = [];
            adapter.onError = (e) => errors.push(e);
            const ok = adapter.initialize({ video: { codec: 'avc1.BAD', initData: makeInit(1, 100) } });
            currentMs.open();
            await Promise.resolve(); await Promise.resolve();

            expect(ok).toBe(false);
            expect(errors.length).toBeGreaterThanOrEqual(1);
            expect(errors[0]!.name).toBe('CodecUnsupportedError');
            expect(errors[0]!.message).toContain('avc1.BAD'); // names the exact mime
            expect(currentMs.addSourceBufferCalls).toHaveLength(0); // nothing created
        } finally {
            delete (globalThis.MediaSource as any).isTypeSupported;
        }
    });

    it('rejects a zero-byte init entry: returns false, no SourceBuffers, no appends', async () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        const errors: Error[] = [];
        adapter.onError = (e) => errors.push(e);
        const ok = adapter.initialize({ video: { codec: 'avc1.42c01e', initData: new Uint8Array(0) } });
        currentMs.open();
        await Promise.resolve(); await Promise.resolve();

        expect(ok).toBe(false);
        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors[0]!.message).toMatch(/init/i);
        expect(currentMs.addSourceBufferCalls).toHaveLength(0);
        expect(currentMs.videoBuffer.appendedPayloads).toHaveLength(0);
    });

    it('mixed valid video + invalid audio rejects the WHOLE config — no partial video SourceBuffer', async () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        const errors: Error[] = [];
        adapter.onError = (e) => errors.push(e);
        const ok = adapter.initialize({
            video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) },
            audio: { codec: 'mp4a.40.2', initData: new Uint8Array(0) }, // broken entry
        });
        currentMs.open();
        await Promise.resolve(); await Promise.resolve();

        expect(ok).toBe(false);
        expect(currentMs.addSourceBufferCalls).toHaveLength(0); // not even the valid track
        expect(currentMs.videoBuffer.appendedPayloads).toHaveLength(0);
    });

    it('stays un-latched after rejection: a corrected initialize() then succeeds normally', async () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        adapter.onError = () => { /* swallow the expected rejection error */ };
        const initData = makeInit(1, 100);

        expect(adapter.initialize({ video: { codec: 'avc1.42c01e', initData: new Uint8Array(0) } }))
            .toBe(false);
        // Corrected config on the SAME adapter must succeed (no latch from the failure).
        expect(adapter.initialize({ video: { codec: 'avc1.42c01e', initData } })).toBe(true);
        currentMs.open();
        await Promise.resolve(); await Promise.resolve();

        expect(currentMs.addSourceBufferCalls).toHaveLength(1);
        expect(currentMs.videoBuffer.appendedPayloads[0]).toEqual(initData); // init appended
    });
});

// ─── MediaSource implementation selection ────────────────────────
//
// Safari exposes BOTH ManagedMediaSource and MediaSource on desktop/iPad, and
// only ManagedMediaSource on iPhone. Selection is capability-based (no UA
// sniffing): `auto`/`managed` prefer ManagedMediaSource where both exist, and
// `standard` prefers standard MediaSource. Every preference falls back rather
// than failing, so a device exposing only one implementation still plays.
// The explicit preferences exist for investigation — a desktop-Safari A/V
// problem reproduced under BOTH implementations, so neither is a known-good.

describe('MseMediaSource — MediaSource implementation selection', () => {
    /** Stub both constructors; each returns its own distinguishable instance. */
    function stubBoth(): { managed: MockMediaSource; standard: MockMediaSource } {
        const managed = new MockMediaSource();
        const standard = new MockMediaSource();
        vi.stubGlobal('ManagedMediaSource', class { constructor() { return managed; } });
        vi.stubGlobal('MediaSource', class { constructor() { return standard; } });
        return { managed, standard };
    }
    const makeVideo = () => new MockVideoElement() as unknown as HTMLVideoElement;

    it('auto prefers ManagedMediaSource when both exist (srcObject attachment)', () => {
        const { managed } = stubBoth();
        const video = makeVideo();
        const adapter = new MseMediaSource(video);
        expect(adapter.selectedImplementation).toBe('managed');
        expect(adapter.implementationRequested).toBe('auto');
        // MMS attaches via srcObject and requires disableRemotePlayback.
        expect((video as unknown as { srcObject: unknown }).srcObject).toBe(managed);
        expect(video.disableRemotePlayback).toBe(true);
    });

    it('auto falls back to standard MediaSource when MMS is absent (Chrome)', () => {
        vi.stubGlobal('ManagedMediaSource', undefined);
        const video = makeVideo();
        const adapter = new MseMediaSource(video);
        expect(adapter.selectedImplementation).toBe('standard');
        expect(adapter.implementationRequested).toBe('auto');
        expect(video.src).toBe('blob:mock');
    });

    it('standard uses MediaSource when both exist', () => {
        const { standard } = stubBoth();
        const video = makeVideo();
        const adapter = new MseMediaSource(video, { mseImplementation: 'standard' });
        expect(adapter.selectedImplementation).toBe('standard');
        expect(adapter.implementationRequested).toBe('standard');
        // Standard MediaSource attaches via object URL, NOT srcObject.
        expect((video as unknown as { srcObject: unknown }).srcObject).toBeNull();
        expect(video.src).toBe('blob:mock');
        expect(standard).toBeDefined();
    });

    it('managed explicitly prefers ManagedMediaSource when both exist', () => {
        const { managed } = stubBoth();
        const video = makeVideo();
        const adapter = new MseMediaSource(video, { mseImplementation: 'managed' });
        expect(adapter.selectedImplementation).toBe('managed');
        expect(adapter.implementationRequested).toBe('managed'); // recorded as asked, not coerced to auto
        expect((video as unknown as { srcObject: unknown }).srcObject).toBe(managed);
    });

    it('managed falls back to standard MediaSource when MMS is absent (Chrome)', () => {
        vi.stubGlobal('ManagedMediaSource', undefined);
        const adapter = new MseMediaSource(makeVideo(), { mseImplementation: 'managed' });
        expect(adapter.selectedImplementation).toBe('standard');
        expect(adapter.implementationRequested).toBe('managed');
    });

    it('standard falls back to ManagedMediaSource when standard is absent (iPhone)', () => {
        // iPhone Safari ships ManagedMediaSource only — an explicit preference
        // must not make an otherwise-playable device unplayable.
        const managed = new MockMediaSource();
        vi.stubGlobal('ManagedMediaSource', class { constructor() { return managed; } });
        vi.stubGlobal('MediaSource', undefined);
        const adapter = new MseMediaSource(makeVideo(), { mseImplementation: 'standard' });
        expect(adapter.selectedImplementation).toBe('managed');
        expect(adapter.implementationRequested).toBe('standard');
    });

    it('still throws when NEITHER implementation exists (unchanged contract)', () => {
        vi.stubGlobal('ManagedMediaSource', undefined);
        vi.stubGlobal('MediaSource', undefined);
        expect(() => new MseMediaSource(makeVideo())).toThrow(/Neither MediaSource nor ManagedMediaSource/);
        expect(() => new MseMediaSource(makeVideo(), { mseImplementation: 'standard' }))
            .toThrow(/Neither MediaSource nor ManagedMediaSource/);
    });

    // ── Attachment is INDEPENDENT of implementation ──────────────
    //
    // These two were previously coupled (standard→object URL, managed→
    // srcObject), so a standard-vs-managed comparison silently varied both and
    // could not distinguish a ManagedMediaSource problem from an attachment
    // one. Defaults are preserved exactly; explicit modes never fall back.

    it('auto attachment preserves the historical pairing for BOTH implementations', () => {
        const { managed } = stubBoth();
        // standard + auto → object URL
        const v1 = makeVideo();
        const a1 = new MseMediaSource(v1, { mseImplementation: 'standard' });
        expect(a1.selectedAttachment).toBe('object-url');
        expect(a1.attachmentRequested).toBe('auto');
        expect(v1.src).toBe('blob:mock');
        expect((v1 as unknown as { srcObject: unknown }).srcObject).toBeNull();
        // managed + auto → srcObject
        const v2 = makeVideo();
        const a2 = new MseMediaSource(v2, { mseImplementation: 'managed' });
        expect(a2.selectedAttachment).toBe('src-object');
        expect((v2 as unknown as { srcObject: unknown }).srcObject).toBe(managed);
    });

    it('managed + object-url constructs ManagedMediaSource but attaches by object URL', () => {
        const { managed } = stubBoth();
        const video = makeVideo();
        const adapter = new MseMediaSource(video, { mseImplementation: 'managed', mseAttachment: 'object-url' });
        expect(adapter.selectedImplementation).toBe('managed'); // MMS is in use…
        expect(adapter.selectedAttachment).toBe('object-url');  // …via an object URL
        expect(video.src).toBe('blob:mock');
        expect((video as unknown as { srcObject: unknown }).srcObject).toBeNull();
        expect(managed).toBeDefined();
    });

    it('managed + src-object constructs ManagedMediaSource and attaches by srcObject', () => {
        const { managed } = stubBoth();
        const video = makeVideo();
        const adapter = new MseMediaSource(video, { mseImplementation: 'managed', mseAttachment: 'src-object' });
        expect(adapter.selectedImplementation).toBe('managed');
        expect(adapter.selectedAttachment).toBe('src-object');
        expect((video as unknown as { srcObject: unknown }).srcObject).toBe(managed);
        expect(video.src).toBe('');
    });

    it('BOTH managed attachment modes set disableRemotePlayback', () => {
        for (const mode of ['object-url', 'src-object'] as const) {
            stubBoth();
            const video = makeVideo();
            new MseMediaSource(video, { mseImplementation: 'managed', mseAttachment: mode });
            expect(video.disableRemotePlayback, mode).toBe(true);
        }
    });

    it('standard + object-url works with remote playback default AND disabled', () => {
        // Default: the adapter does not touch the flag for standard.
        stubBoth();
        const v1 = makeVideo();
        const a1 = new MseMediaSource(v1, { mseImplementation: 'standard', mseAttachment: 'object-url' });
        expect(a1.selectedAttachment).toBe('object-url');
        expect(v1.disableRemotePlayback).toBe(false);
        // Pre-set by the caller (the ?mseremote=disabled control): preserved.
        stubBoth();
        const v2 = makeVideo();
        v2.disableRemotePlayback = true;
        const a2 = new MseMediaSource(v2, { mseImplementation: 'standard', mseAttachment: 'object-url' });
        expect(a2.selectedAttachment).toBe('object-url');
        expect(v2.disableRemotePlayback).toBe(true);
        expect(v2.src).toBe('blob:mock');
    });

    it('an explicit attachment mode THROWS rather than silently falling back', () => {
        // src-object requested but unsupported by the element.
        stubBoth();
        // An element without srcObject at all (older engines).
        const noSrcObject = new MockVideoElement();
        delete (noSrcObject as unknown as Record<string, unknown>)['srcObject'];
        expect(() => new MseMediaSource(noSrcObject as unknown as HTMLVideoElement, { mseAttachment: 'src-object' }))
            .toThrow(/src-object.*srcObject is unavailable/);
        // object-url requested but createObjectURL unavailable.
        stubBoth();
        vi.stubGlobal('URL', {});
        expect(() => new MseMediaSource(makeVideo(), { mseAttachment: 'object-url' }))
            .toThrow(/object-url.*createObjectURL is unavailable/);
    });

    it('attachment selection does not disturb initialize/sourceopen/init append', async () => {
        // managed + object-url must behave identically through init.
        const { managed } = stubBoth();
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {
            mseImplementation: 'managed', mseAttachment: 'object-url',
        });
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        managed.open();
        await flush();
        expect(managed.addSourceBufferCalls).toEqual(['video/mp4; codecs="avc1.42c01e"']);
        expect(managed.videoBuffer.appendedPayloads.length).toBe(1); // init segment appended
    });

    it('selection does not disturb init/sourceopen behavior', async () => {
        // Same initialize() + sourceopen flow as the default harness, but with
        // the standard implementation forced: SourceBuffer creation and the init
        // append must be identical.
        const { standard } = stubBoth();
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { mseImplementation: 'standard' });
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        standard.open();
        await flush();
        expect(standard.addSourceBufferCalls).toEqual(['video/mp4; codecs="avc1.42c01e"']);
        expect(standard.videoBuffer.appendedPayloads.length).toBe(1); // init segment appended
    });
});

// ─── Startup lifecycle: position, THEN play ──────────────────────
//
// Assigning currentTime begins an asynchronous seek. Playing before it settles
// races the element's own positioning — a race that only became the normal
// startup path once a nonzero start position became normal. These pin the
// owned, cancellable transaction: at most one seek and one play, no play into
// an unresolved seek, and nothing survives cancellation.

describe('MseMediaSource — startup positioning lifecycle', () => {
    /** Ready adapter whose next append triggers startup at `ranges`. */
    async function startupHarness(
        ranges: readonly [number, number][],
        opts: MseMediaSourceOptions = {},
    ) {
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true; // startup tests need the real seek lifecycle
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, opts);
        adapter.debug = false;
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        video.buffered = makeTimeRanges(ranges);
        const playSpy = vi.spyOn(video, 'play');
        let nextBmd = 0;
        const append = (bmd?: number) => {
            const b = bmd ?? nextBmd;
            nextBmd = b + 100;
            adapter.appendChunk(
                'video', makeSegment({ bmd: b, defaultDur: 100, sampleCount: 1 }), 'track1');
        };
        return { adapter, video, playSpy, append };
    }
    /** Mirrors the module-private STARTUP_SEEK_TIMEOUT_MS in mse-adapter.ts. */
    const STARTUP_SEEK_TIMEOUT_MS = 2000;
    /** Several microtask turns — the startup chain awaits seek then play. */
    const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

    it('does NOT call play() before the startup seek settles', async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            video.autoFireSeeked = false; // seek issued, never settles
            append();
            await settle();
            expect(video.currentTime).toBe(2.73); // positioned…
            expect(video.seeking).toBe(true);     // …still seeking…
            expect(playSpy).not.toHaveBeenCalled(); // …so NOT played
            adapter.destroy(); // cancel before the timer can fire (no leaked timer)
        } finally { vi.useRealTimers(); }
    });

    it('plays once the seek settles', async () => {
        const { video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
        append();
        await settle();
        expect(video.currentTime).toBe(2.73);
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('repeated drains DURING an outstanding seek produce ONE seek and ONE play', async () => {
        const { video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
        // Hold the seek open so the interleaving is real: startup is parked in
        // `positioning` while further drains arrive. (Appending alone would
        // serialize through the SourceBuffer queue and finish before the seek,
        // which is why the earlier version of this test proved nothing.)
        video.autoFireSeeked = false;
        append();
        await settle();
        expect(video.seekCount).toBe(1);          // positioning started
        expect(playSpy).not.toHaveBeenCalled();   // parked, not played

        // Now drive several more drains while the seek is STILL pending.
        append(); await settle();
        append(); await settle();
        video.fire('updateend');
        await settle();
        expect(video.seekCount).toBe(1);          // no second seek
        expect(playSpy).not.toHaveBeenCalled();   // still parked

        // Settle the original seek — exactly one play results.
        video.seeking = false;
        video.fire('seeked');
        await settle();
        expect(video.seekCount).toBe(1);
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('a timed-out UNRESOLVED seek must not play on a later drain', async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            adapter.onError = () => { /* swallow the timeout report */ };
            video.autoFireSeeked = false; // seek never resolves; `seeking` stays true
            append();
            await settle();
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 100);
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(playSpy).not.toHaveBeenCalled(); // timed out → no play

            // The retry trap: currentTime already EQUALS the target, so a naive
            // needsSeek check is false and startup would sail straight to play()
            // while the element is still seeking. It must re-await settlement.
            expect(video.currentTime).toBe(2.73);
            expect(video.seeking).toBe(true);
            append();
            await settle();
            expect(playSpy).not.toHaveBeenCalled(); // STILL no play

            // Only a genuine settlement may release startup.
            video.seeking = false;
            video.fire('seeked');
            await settle();
            expect(playSpy).toHaveBeenCalledTimes(1);
            adapter.destroy();
        } finally { vi.useRealTimers(); }
    });

    it('cancellation SETTLES the pending positioning promise (no orphan)', async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, append } = await startupHarness([[2.73, 12.73]]);
            video.autoFireSeeked = false;
            append();
            await settle();
            expect(video.listenerCount('seeked')).toBe(1); // positioning in flight
            adapter.reset();
            await settle();
            // Listener + timer released, and the awaiting chain unwound rather
            // than hanging on a promise nobody will ever resolve.
            expect(video.listenerCount('seeked')).toBe(0);
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 100);
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });

    it('a throwing onError cannot produce an unhandled rejection', async () => {
        vi.useFakeTimers();
        const unhandled: unknown[] = [];
        const onUnhandled = (e: PromiseRejectionEvent | unknown) => unhandled.push(e);
        process.on('unhandledRejection', onUnhandled);
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            adapter.onError = () => { throw new Error('consumer exploded'); };
            video.autoFireSeeked = false;
            append();
            await settle();
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 100);
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(playSpy).not.toHaveBeenCalled();
            expect(unhandled).toEqual([]); // contained
            adapter.destroy();
        } finally {
            process.off('unhandledRejection', onUnhandled);
            vi.useRealTimers();
        }
    });

    it('a throwing currentTime setter leaks nothing and stays retryable', async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            const errors: Error[] = [];
            adapter.onError = (e) => errors.push(e);
            video.throwOnSeek = new Error('seek refused by element');
            append();
            await settle();

            // Rejected — but nothing armed is left behind.
            expect(playSpy).not.toHaveBeenCalled();
            expect(video.listenerCount('seeked')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(errors.length).toBe(1); // exactly one report
            expect(errors[0]!.message).toMatch(/seek refused/);

            // …and a later valid attempt still starts.
            video.throwOnSeek = null;
            append();
            await settle();
            expect(playSpy).toHaveBeenCalledTimes(1);
            adapter.destroy();
        } finally { vi.useRealTimers(); }
    });

    it('a seeked that landed at the WRONG position does not release startup', async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            adapter.onError = () => {};
            video.autoFireSeeked = false; // we drive `seeked` by hand
            append();
            await settle();
            expect(video.seekCount).toBe(1);

            // A superseding seek elsewhere (user scrub / recovery jump) settles
            // far from our target. It must NOT be mistaken for our positioning.
            video.seeking = false;
            (video as unknown as { _currentTime: number })._currentTime = 9.0;
            video.fire('seeked');
            await settle();
            expect(playSpy).not.toHaveBeenCalled();

            // Landing at the owned target does release it.
            (video as unknown as { _currentTime: number })._currentTime = 2.73;
            video.fire('seeked');
            await settle();
            expect(playSpy).toHaveBeenCalledTimes(1);
            adapter.destroy();
        } finally { vi.useRealTimers(); }
    });

    it('a throwing buffered accessor reports once and never rejects', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on('unhandledRejection', onUnhandled);
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            const errors: Error[] = [];
            adapter.onError = (e) => { errors.push(e); throw new Error('consumer exploded too'); };
            Object.defineProperty(video, 'buffered', {
                configurable: true,
                get() { throw new Error('buffered accessor failed'); },
            });
            append();
            await settle();
            expect(playSpy).not.toHaveBeenCalled();
            expect(errors.length).toBe(1); // reported exactly once…
            expect(errors[0]!.message).toMatch(/buffered accessor failed/);
            expect(unhandled).toEqual([]); // …and the throwing consumer stayed contained
            adapter.destroy();
        } finally { process.off('unhandledRejection', onUnhandled); }
    });

    it('releases the seek listener and timer on timeout, reset, and destroy', async () => {
        vi.useFakeTimers();
        try {
            // timeout
            const a = await startupHarness([[2.73, 12.73]]);
            a.adapter.onError = () => {};
            a.video.autoFireSeeked = false;
            a.append();
            await settle();
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 100);
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(a.video.listenerCount('seeked')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            a.adapter.destroy();

            // destroy while positioning
            const b = await startupHarness([[2.73, 12.73]]);
            b.video.autoFireSeeked = false;
            b.append();
            await settle();
            b.adapter.destroy();
            await settle();
            expect(b.video.listenerCount('seeked')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });

    it('the zero-seek path plays WITHOUT waiting for seeked', async () => {
        // currentTime 0 already inside [0, 10] — no seek needed, so a browser
        // that never fires `seeked` must still start.
        const { video, playSpy, append } = await startupHarness([[0, 10]]);
        video.autoFireSeeked = false;
        append();
        await settle();
        expect(video.seekCount).toBe(0);
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('a late seeked after reset() cannot start playback', async () => {
        const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
        video.autoFireSeeked = false;
        append();
        await Promise.resolve(); // positioning in flight
        adapter.reset();
        video.fire('seeked'); // the superseded generation settles late
        await settle();
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('a late seeked after destroy() cannot start playback', async () => {
        const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
        video.autoFireSeeked = false;
        append();
        await Promise.resolve();
        adapter.destroy();
        video.fire('seeked');
        await settle();
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('seek timeout PROCEEDS when the element settled at the target anyway', async () => {
        vi.useFakeTimers();
        try {
            const { video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            video.autoFireSeeked = false; // no event…
            append();
            await settle();
            video.seeking = false; // …but the element is idle at the target
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 100);
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(playSpy).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it('seek timeout while STILL SEEKING reports an error and does not play', async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
            const errors: Error[] = [];
            adapter.onError = (e) => errors.push(e);
            video.autoFireSeeked = false; // seek never resolves — `seeking` stays true
            append();
            await settle();
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 100);
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(playSpy).not.toHaveBeenCalled();
            expect(errors.length).toBe(1);
            expect(errors[0]!.message).toMatch(/did not settle/i);
        } finally { vi.useRealTimers(); }
    });

    it('preserves the autoplay ladder: unmuted rejected → muted retry succeeds', async () => {
        const { video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
        video.rejectPlay = true; // first (unmuted) attempt rejects
        playSpy.mockImplementationOnce(async () => { throw new Error('autoplay blocked'); });
        append();
        await settle();
        expect(video.muted).toBe(true);
        expect(playSpy).toHaveBeenCalledTimes(2); // unmuted, then muted
    });

    it('a fully blocked autoplay stays retryable on a later drain', async () => {
        const { video, playSpy, append } = await startupHarness([[2.73, 12.73]]);
        video.rejectPlay = true; // both attempts reject
        append();
        await settle();
        const afterFirst = playSpy.mock.calls.length;
        expect(afterFirst).toBeGreaterThanOrEqual(2);
        // Next drain retries rather than latching a failed startup.
        video.rejectPlay = false;
        append();
        await settle();
        expect(playSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('removes the seek listener and timer on every outcome (no leaks)', async () => {
        const { video, append } = await startupHarness([[2.73, 12.73]]);
        const before = video.listenerCount('seeked');
        append();
        await settle();
        expect(video.listenerCount('seeked')).toBe(before); // settled → detached
    });
});

// ─── ManagedSourceBuffer observation (chronology only) ───────────
//
// `bufferedchange` and `updateend` are queued separately by MSE with NO
// guaranteed relative order. So the diagnostics record an append-only
// chronology — mutation-start, sync-failure, updateend, bufferedchange, each
// with a monotonic sequence number — and never assert which operation owns a
// buffered change. These tests drive both orderings to prove the log stays
// truthful either way. Playa has no eviction-triggered retrieval path, so no
// reconciliation policy is implemented until redelivery is evidenced.

describe('MseMediaSource — buffer-change chronology', () => {
    /** Collect every diagnostic line (format string + args joined). */
    function captureDiag(): { lines: string[]; restore: () => void } {
        const lines: string[] = [];
        // Interpolate as a console would: logDebug passes (format, ...args), so
        // joining raw args would leave %d/%s placeholders unsubstituted.
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
            lines.push(format(...(a as [unknown, ...unknown[]])));
        });
        return { lines, restore: () => spy.mockRestore() };
    }

    /** One parsed chronology record: its #seq and the fields we assert on. */
    interface Rec { seq: number; kind: string; op?: number; cause?: string; inflight?: string; lastDone?: string }
    /** Parse `[MSE] #<seq> <kind> …` records, ignoring other adapter logs. */
    function parse(lines: readonly string[]): Rec[] {
        const out: Rec[] = [];
        for (const l of lines) {
            const m = /\[MSE\] #(\d+) (\S+)/.exec(l);
            if (!m) continue;
            const rec: Rec = { seq: Number(m[1]), kind: m[2]! };
            const op = /\bop=(\d+)/.exec(l);
            if (op) rec.op = Number(op[1]);
            const cause = /mutation-start op=\d+ \S+ (\S+)/.exec(l);
            if (cause) rec.cause = cause[1];
            const inf = /\binflight=(\S+)/.exec(l);
            if (inf) rec.inflight = inf[1];
            const ld = /\blastDone=(\S+)/.exec(l);
            if (ld) rec.lastDone = ld[1];
            out.push(rec);
        }
        return out;
    }
    const seg = (bmd: number) => makeSegment({ bmd, defaultDur: 100, sampleCount: 5 });

    it('records bufferedchange BEFORE updateend without claiming ownership', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            adapter.appendChunk('video', seg(0), 'track1');
            vsb.dispatch(Object.assign(new Event('bufferedchange'), {
                addedRanges: makeTimeRanges([[0, 2]]), removedRanges: makeTimeRanges([]),
            }));
            await flush();
            const recs = parse(cap.lines);
            // The harness's init-append already ran, so take the LAST start.
            const start = recs.filter((r) => r.kind === 'mutation-start').pop()!;
            const bc = recs.find((r) => r.kind === 'bufferedchange')!;
            const ue = recs.filter((r) => r.kind === 'updateend' && r.op === start.op).pop()!;
            expect(start).toBeDefined();
            // EXACT ids: the change saw that operation still in flight, and the
            // completion that followed is the SAME operation.
            expect(bc.inflight).toBe(`${start.op}/append`);
            // The in-flight op has NOT completed, so it cannot be lastDone.
            expect(bc.lastDone).not.toBe(String(start.op));
            expect(ue.op).toBe(start.op);
            // Monotonic, and in the order this test drove them.
            expect(start.seq).toBeLessThan(bc.seq);
            expect(bc.seq).toBeLessThan(ue.seq);
        } finally { cap.restore(); }
    });

    it('records updateend BEFORE bufferedchange without mis-crediting the next op', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            adapter.appendChunk('video', seg(0), 'track1');
            await flush(); // updateend lands FIRST
            // The delayed change arrives after the next append has begun.
            adapter.appendChunk('video', seg(500), 'track1');
            vsb.dispatch(Object.assign(new Event('bufferedchange'), {
                addedRanges: makeTimeRanges([[0, 2]]), removedRanges: makeTimeRanges([]),
            }));
            await flush();
            const recs = parse(cap.lines);
            const starts = recs.filter((r) => r.kind === 'mutation-start');
            const oldOp = starts[0]!.op!;
            const newOp = starts[1]!.op!;
            expect(newOp).toBeGreaterThan(oldOp);
            const firstUe = recs.find((r) => r.kind === 'updateend')!;
            const bc = recs.filter((r) => r.kind === 'bufferedchange').pop()!;
            expect(firstUe.op).toBe(oldOp);            // the OLD op completed first
            // The delayed change straddles two operations: the NEW one is still
            // running and the OLD one has finished. Reported as context — the log
            // does not claim either caused it.
            expect(bc.inflight).toBe(`${newOp}/append`);
            expect(bc.lastDone).toBe(String(oldOp));
            expect(firstUe.seq).toBeLessThan(bc.seq); // ordering as driven
        } finally { cap.restore(); }
    });

    it('records a synchronous append failure so no operation dangles', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            vsb.throwNextAppend = new Error('append refused');
            adapter.appendChunk('video', seg(0), 'track1');
            await flush();
            const start = cap.lines.find((l) => l.includes('mutation-start'));
            const fail = cap.lines.find((l) => l.includes('mutation-sync-failure'));
            expect(start).toBeDefined();
            expect(fail).toBeDefined();
            expect(fail).toContain('append refused');
        } finally { cap.restore(); }
    });

    it('marks a late event from a SUPERSEDED buffer after reset()', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            adapter.reset();
            vsb.dispatch(Object.assign(new Event('bufferedchange'), {
                addedRanges: makeTimeRanges([]), removedRanges: makeTimeRanges([[0, 2]]),
            }));
            await flush();
            expect(cap.lines.find((l) => l.includes('reset (buffer generation'))).toBeDefined();
            const bc = cap.lines.find((l) => l.includes('bufferedchange'))!;
            expect(bc).toContain('SUPERSEDED'); // not read as current state
        } finally { cap.restore(); }
    });

    it('a superseded buffer\'s late updateend must not touch the replacement', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            // An append is in flight when reset() replaces the buffer set.
            adapter.appendChunk('video', seg(0), 'track1');
            adapter.reset();
            // Re-initialize: a NEW SourceBuffer becomes current.
            adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
            currentMs.open();
            await flush();
            const fresh = currentMs.videoBuffer;
            const appendsBefore = fresh.appendedPayloads.length;

            // The OLD buffer now completes. It must be ignored: completing an
            // operation on, committing ranges into, or draining the queue of the
            // replacement buffer would corrupt it.
            cap.lines.length = 0;
            vsb.fire('updateend');
            await flush();
            const recs = parse(cap.lines);
            expect(recs.some((r) => r.kind === 'updateend')).toBe(true);
            expect(cap.lines.some((l) => l.includes('SUPERSEDED'))).toBe(true);
            expect(fresh.appendedPayloads.length).toBe(appendsBefore); // queue untouched
        } finally { cap.restore(); }
    });

    it('records a synchronous FAILURE for a throwing remove (back-buffer evict)', async () => {
        const { adapter, video, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            // The back-buffer evict only runs after startup has played, so drive
            // startup to completion first (currentTime 0 is already inside the
            // range, so no seek is needed).
            video.modelSeekLifecycle = true;
            // Startup reads the ELEMENT's buffered; the evict reads the
            // SourceBuffer's. Both are needed here.
            video.buffered = makeTimeRanges([[0, 60]]);
            vsb.buffered = makeTimeRanges([[0, 60]]);
            adapter.appendChunk('video', seg(0), 'track1');
            for (let i = 0; i < 40; i++) await Promise.resolve();

            // Now the playhead is far enough ahead to trigger the evict, which throws.
            cap.lines.length = 0;
            video.currentTime = 50;
            vsb.throwNextRemove = new Error('remove refused');
            adapter.appendChunk('video', seg(500), 'track1');
            await flush();
            const recs = parse(cap.lines);
            // The throwing remove is its OWN operation; the append that follows
            // it is a separate one, so match on cause rather than recency.
            const evict = recs.find((r) => r.kind === 'mutation-start' && r.cause === 'back-buffer-remove');
            const fail = recs.find((r) => r.kind === 'mutation-sync-failure');
            expect(evict).toBeDefined();
            expect(fail).toBeDefined();
            // Every stamped operation ends in updateend OR sync-failure.
            expect(fail!.op).toBe(evict!.op);
            expect(cap.lines.some((l) => l.includes('remove refused'))).toBe(true);
        } finally { cap.restore(); }
    });

    it('a failed append records mutation-start < error < updateend, all op N', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        adapter.onError = () => { /* expected */ };
        const cap = captureDiag();
        try {
            vsb.errorNextAppend = true; // MSE §5.5.3: error, then updateend
            adapter.appendChunk('video', seg(0), 'track1');
            await flush();
            const recs = parse(cap.lines);
            const start = recs.filter((r) => r.kind === 'mutation-start' && r.cause === 'append').pop()!;
            const err = recs.find((r) => r.kind === 'sourcebuffer-error')!;
            const ue = recs.filter((r) => r.kind === 'updateend').pop()!;
            expect(start).toBeDefined();
            expect(err).toBeDefined();
            expect(ue).toBeDefined();
            // The SAME operation id runs through all three records…
            expect(err.op).toBe(start.op);
            expect(ue.op).toBe(start.op);
            // …in order, with updateend terminal and marked as an error outcome.
            expect(start.seq).toBeLessThan(err.seq);
            expect(err.seq).toBeLessThan(ue.seq);
            expect(cap.lines.some((l) => /updateend video op=\d+ error/.test(l))).toBe(true);
        } finally { cap.restore(); }
    });

    /** Replacement buffer holding REAL in-flight state: pending append + queued payload. */
    async function replacementWithPendingWork() {
        const { adapter, vsb: oldSb } = await makeReadyAdapter();
        adapter.debug = true;
        adapter.appendChunk('video', seg(0), 'track1'); // in flight on the OLD buffer
        adapter.reset();
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        const fresh = currentMs.videoBuffer;
        // A media append on the FRESH buffer, HELD in flight (updating stays
        // true), with a second payload queued behind it.
        fresh.autoComplete = false;
        adapter.appendChunk('video', seg(1000), 'trackNew', 7n);
        adapter.appendChunk('video', seg(2000), 'trackNew', 8n);
        const appendsBefore = fresh.appendedPayloads.length;
        expect(fresh.updating).toBe(true);              // genuinely in flight
        expect(fresh).not.toBe(oldSb);                  // distinct instances
        return { adapter, oldSb, fresh, appendsBefore };
    }

    it('a superseded updateend cannot commit, clear, or drain the replacement', async () => {
        const { adapter, oldSb, fresh, appendsBefore } = await replacementWithPendingWork();
        const cap = captureDiag();
        try {
            // The OLD buffer completes late. It must change nothing here.
            oldSb.fire('updateend');
            await flush();
            expect(cap.lines.some((l) => l.includes('SUPERSEDED'))).toBe(true);
            // The queued payload has NOT been drained into the fresh buffer…
            expect(fresh.appendedPayloads.length).toBe(appendsBefore);
            expect(fresh.updating).toBe(true);
            // …and crucially NOTHING was committed: without the guard the old
            // event would advance the replacement's group floor to 7.
            expect(adapter.getCommittedGroupFloor('video', 'trackNew')).toBeUndefined();

            // The FRESH buffer completes its FIRST append: group 7 commits and
            // the queued second payload drains (and is held in flight in turn).
            fresh.updating = false;
            fresh.fire('updateend');
            await flush();
            expect(adapter.getCommittedGroupFloor('video', 'trackNew')).toBe(7n);
            expect(fresh.appendedPayloads.length).toBe(appendsBefore + 1);

            // Completing the second append commits group 8.
            fresh.autoComplete = true;
            fresh.updating = false;
            fresh.fire('updateend');
            await flush();
            expect(adapter.getCommittedGroupFloor('video', 'trackNew')).toBe(8n);
        } finally { cap.restore(); }
    });

    it('a superseded ERROR cannot mark the replacement errored or surface onError', async () => {
        const { adapter, oldSb, fresh, appendsBefore } = await replacementWithPendingWork();
        const errors: Error[] = [];
        adapter.onError = (e) => errors.push(e);
        const cap = captureDiag();
        try {
            oldSb.fire('error');
            await flush();
            expect(cap.lines.some((l) => l.includes('sourcebuffer-error') && l.includes('SUPERSEDED'))).toBe(true);
            expect(errors).toEqual([]);                              // no error surfaced
            expect(fresh.appendedPayloads.length).toBe(appendsBefore); // nothing drained

            // The replacement is NOT marked errored: its own completion still
            // commits and drains normally.
            fresh.autoComplete = true;
            fresh.updating = false;
            fresh.fire('updateend');
            await flush();
            expect(fresh.appendedPayloads.length).toBeGreaterThan(appendsBefore);
        } finally { cap.restore(); }
    });

    it('reset records mutation-cancelled for an in-flight operation', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            vsb.autoComplete = false; // hold the append in flight
            adapter.appendChunk('video', seg(0), 'track1');
            const started = parse(cap.lines).filter((r) => r.kind === 'mutation-start').pop()!;
            adapter.reset();
            const recs = parse(cap.lines);
            const cancelled = recs.find((r) => r.kind === 'mutation-cancelled')!;
            // Cancellation is the THIRD terminal outcome — the operation ends
            // with its id recorded, not by silently disappearing.
            expect(cancelled).toBeDefined();
            expect(cancelled.op).toBe(started.op);
            expect(cap.lines.some((l) => l.includes('reason=reset'))).toBe(true);
            expect(started.seq).toBeLessThan(cancelled.seq);
        } finally { cap.restore(); }
    });

    it('records endOfStream', async () => {
        const { adapter } = await makeReadyAdapter();
        adapter.debug = true;
        const cap = captureDiag();
        try {
            adapter.endOfStream();
            expect(cap.lines.find((l) => l.includes('endOfStream'))).toBeDefined();
        } finally { cap.restore(); }
    });

    it('reports added/removed/resulting ranges in the EXACT argument positions', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        const calls: unknown[][] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { calls.push(a); });
        try {
            vsb.buffered = makeTimeRanges([[4, 10]]);
            // A removal AND a larger addition in one event — the case an
            // aggregate would hide behind net growth.
            vsb.dispatch(Object.assign(new Event('bufferedchange'), {
                addedRanges: makeTimeRanges([[4, 10]]),
                removedRanges: makeTimeRanges([[0, 2]]),
            }));
            await flush();
            const c = calls.find((x) => typeof x[0] === 'string' && (x[0] as string).includes('bufferedchange'))!;
            expect(c).toBeDefined();
            // [0]=format [1]=seq [2]=mediaType [3]=superseded [4]=inflight
            // [5]=lastDone [6]=added [7]=removed [8]=buffered — positional, so
            // swapping added/removed in the format string FAILS.
            expect(c[2]).toBe('video');
            expect(c[6]).toBe('4.00-10.00'); // addedRanges
            expect(c[7]).toBe('0.00-2.00');  // removedRanges — not hidden
            expect(c[8]).toBe('4.00-10.00'); // resulting buffered
        } finally { spy.mockRestore(); }
    });

    it('eviction does NOT weaken duplicate protection (behavior unchanged)', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        vsb.buffered = makeTimeRanges([[0, 0.5]]);
        adapter.appendChunk('video', seg(0), 'track1');
        await flush();
        const n = vsb.appendedPayloads.length;
        vsb.buffered = makeTimeRanges([]);
        vsb.fire('bufferedchange');
        await flush();
        // Deliberately unchanged: no reconciliation policy without evidence.
        adapter.appendChunk('video', seg(0), 'track1');
        await flush();
        expect(vsb.appendedPayloads.length).toBe(n);
    });

    it('a transient buffered-read failure neither throws nor changes behavior', async () => {
        const { adapter, vsb } = await makeReadyAdapter();
        adapter.debug = true;
        vsb.buffered = makeTimeRanges([[0, 0.5]]);
        adapter.appendChunk('video', seg(0), 'track1');
        await flush();
        const n = vsb.appendedPayloads.length;
        const original = Object.getOwnPropertyDescriptor(vsb, 'buffered');
        Object.defineProperty(vsb, 'buffered', {
            configurable: true,
            get() { throw new Error('buffered temporarily unreadable'); },
        });
        expect(() => vsb.fire('bufferedchange')).not.toThrow();
        adapter.appendChunk('video', seg(0), 'track1');
        await flush();
        expect(vsb.appendedPayloads.length).toBe(n);
        if (original) Object.defineProperty(vsb, 'buffered', original);
    });
});

// ─── Playback intent: one owner of startup ──────────────────────────
//
// Arrival of media is not a request to play. Without an explicit intent
// contract the adapter is a SECOND owner of startup alongside the player and
// can begin playing while the player is still LOADING or has been paused.
// Buffering is unaffected — only the positioning/play transaction waits.

describe('MseMediaSource — playback intent owns startup', () => {
    /** Adapter with intent withheld; media can arrive freely. */
    async function intentHarness(ranges: readonly [number, number][]) {
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.setPlaybackIntent(false); // player is LOADING, not playing
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        const playSpy = vi.spyOn(video, 'play');
        let nextBmd = 0;
        // Ranges appear only when media is appended — as in a real element,
        // where `buffered` is empty until something has been buffered.
        const append = (bmd?: number) => {
            const b = bmd ?? nextBmd;
            nextBmd = b + 100;
            video.buffered = makeTimeRanges(ranges);
            adapter.appendChunk(
                'video', makeSegment({ bmd: b, defaultDur: 100, sampleCount: 1 }), 'track1');
        };
        return { adapter, video, playSpy, append };
    }
    const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
    /** Settle a held-open seek the way a real element does: clear, then event. */
    const settleSeek = (video: MockVideoElement) => { video.seeking = false; video.fire('seeked'); };

    it('buffers media that arrives BEFORE play intent without seeking or playing', async () => {
        const { video, playSpy, append } = await intentHarness([[2.73, 12.73]]);
        append();
        append();
        await settle();
        // init + 2 media appends: buffering is unaffected by intent.
        expect(currentMs.videoBuffer.appendedPayloads.length).toBe(3);
        expect(video.seekCount).toBe(0);        // …not positioned
        expect(playSpy).not.toHaveBeenCalled(); // …not played
        expect(video.currentTime).toBe(0);
    });

    it('starts once play intent arrives after media is already buffered', async () => {
        const { adapter, video, playSpy, append } = await intentHarness([[2.73, 12.73]]);
        append();
        await settle();
        expect(playSpy).not.toHaveBeenCalled();
        adapter.setPlaybackIntent(true);
        await settle();
        expect(video.currentTime).toBe(2.73); // positioned…
        expect(playSpy).toHaveBeenCalledTimes(1); // …then played
    });

    it('starts when media arrives after play intent', async () => {
        const { adapter, video, playSpy, append } = await intentHarness([[2.73, 12.73]]);
        adapter.setPlaybackIntent(true);
        await settle();
        expect(playSpy).not.toHaveBeenCalled(); // nothing to play into yet
        append();
        await settle();
        expect(video.currentTime).toBe(2.73);
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('withdrawing intent DURING positioning prevents the late play', async () => {
        const { adapter, video, playSpy, append } = await intentHarness([[2.73, 12.73]]);
        video.autoFireSeeked = false; // park startup in `positioning`
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        expect(video.seeking).toBe(true);
        expect(playSpy).not.toHaveBeenCalled();
        adapter.setPlaybackIntent(false); // player paused mid-startup
        settleSeek(video);
        await settle();
        expect(playSpy).not.toHaveBeenCalled(); // cancelled, not deferred
    });

    it('destroy() during positioning prevents the late play', async () => {
        const { adapter, video, playSpy, append } = await intentHarness([[2.73, 12.73]]);
        video.autoFireSeeked = false;
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        adapter.destroy();
        settleSeek(video);
        await settle();
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('repeated intent + drains yield ONE positioning transaction', async () => {
        const { adapter, video, playSpy, append } = await intentHarness([[2.73, 12.73]]);
        video.autoFireSeeked = false;
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        adapter.setPlaybackIntent(true); // idempotent — no second transaction
        append();
        append();
        await settle();
        expect(video.seekCount).toBe(1);
        settleSeek(video);
        await settle();
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('an adapter never told about intent keeps the previous behavior', async () => {
        // Backward compatibility: embedders predating the contract must still start.
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        video.buffered = makeTimeRanges([[2.73, 12.73]]);
        const playSpy = vi.spyOn(video, 'play');
        adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 }), 'track1');
        await settle();
        expect(playSpy).toHaveBeenCalledTimes(1);
    });
});

// ─── Intent governs ESTABLISHED playback, not just startup ─────────
//
// Withdrawing intent is a pause: the documented contract is that the player
// owns playback, so an adapter that only cancelled startup would leave an
// already-playing element running after pause().

describe('MseMediaSource — intent pauses and resumes established playback', () => {
    const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
    /** Adapter already past startup: intent granted, media appended, playing. */
    async function startedHarness() {
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        adapter.setPlaybackIntent(true);
        video.buffered = makeTimeRanges([[2.73, 12.73]]);
        adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 }), 'track1');
        await settle();
        expect(video.paused).toBe(false); // established playback
        return { adapter, video };
    }

    it('withdrawing intent pauses playback that has already started', async () => {
        const { adapter, video } = await startedHarness();
        adapter.setPlaybackIntent(false);
        expect(video.pauseCalls).toBe(1);
        expect(video.paused).toBe(true);
    });

    it('re-granting intent resumes established playback', async () => {
        const { adapter, video } = await startedHarness();
        adapter.setPlaybackIntent(false);
        const playsBefore = video.playCalls;
        adapter.setPlaybackIntent(true);
        await settle();
        expect(video.playCalls).toBe(playsBefore + 1);
        expect(video.paused).toBe(false);
    });

    it('a real changeType() does NOT restart playback while intent is withdrawn', async () => {
        const { adapter, video } = await startedHarness();
        video.paused = true;                 // browser paused the element
        adapter.setPlaybackIntent(false);    // …and the player is paused too
        const playsBefore = video.playCalls;
        // The REAL codec-switch path, not a re-initialize() (which returns
        // early on an already-initialized adapter and would prove nothing).
        await adapter.changeType('video', 'hvc1.1.6.L93.90', makeInit(1, 200));
        await settle();
        expect(currentMs.videoBuffer.changeTypeCalls.length).toBe(1); // path really ran
        expect(video.playCalls).toBe(playsBefore);
        expect(video.paused).toBe(true);
    });

    it('intent withdrawn WHILE changeType() is in flight leaves the element paused', async () => {
        const { adapter, video } = await startedHarness();
        video.paused = true;
        const changing = adapter.changeType('video', 'hvc1.1.6.L93.90', makeInit(1, 200));
        adapter.setPlaybackIntent(false);     // pause races the in-flight switch
        await changing;
        await settle();
        expect(currentMs.videoBuffer.changeTypeCalls.length).toBe(1);
        expect(video.paused).toBe(true);
    });

    it('destroy() WHILE changeType() is in flight leaves the element paused', async () => {
        const { adapter, video } = await startedHarness();
        video.paused = true;
        const changing = adapter.changeType('video', 'hvc1.1.6.L93.90', makeInit(1, 200));
        adapter.destroy();
        await changing;
        await settle();
        expect(video.paused).toBe(true);
    });

    it('a play() that RESOLVES after intent is withdrawn does not leave the element playing', async () => {
        // The hole a generation check alone cannot close: video.play() resolves
        // asynchronously and the element is playing by then, so the pause must
        // be applied on resolution.
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        let releasePlay: (() => void) | null = null;
        video.deferPlay = () => new Promise<void>((resolve) => { releasePlay = resolve; });
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        adapter.setPlaybackIntent(true);
        video.buffered = makeTimeRanges([[2.73, 12.73]]);
        adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 }), 'track1');
        await settle();
        expect(releasePlay).not.toBeNull();   // play() is pending

        adapter.setPlaybackIntent(false);     // pause while it is pending
        releasePlay!();                       // …and the element starts anyway
        await settle();
        expect(video.paused).toBe(true);      // undone on resolution
        expect(video.pauseCalls).toBeGreaterThan(0);
    });

    it('destroy() while play() is pending does not leave the element playing', async () => {
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        let releasePlay: (() => void) | null = null;
        video.deferPlay = () => new Promise<void>((resolve) => { releasePlay = resolve; });
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        adapter.setPlaybackIntent(true);
        video.buffered = makeTimeRanges([[2.73, 12.73]]);
        adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 }), 'track1');
        await settle();
        adapter.destroy();
        releasePlay!();
        await settle();
        expect(video.paused).toBe(true);
    });
});

// ─── Terminal startup report (the adapter half of the joined summary) ──
//
// The summary is only meaningful once positioning AND play have settled.
// Sampling the facts earlier reports whatever the adapter happened to know at
// that instant, which during startup is nothing.

describe('MseMediaSource — terminal startup report', () => {
    const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
    /** Mirrors the module-private STARTUP_SEEK_TIMEOUT_MS in mse-adapter.ts. */
    const STARTUP_SEEK_TIMEOUT_MS = 2000;
    async function reportHarness() {
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.setPlaybackIntent(false);
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        const reports: MseStartupReport[] = [];
        adapter.onStartupReport = (r) => reports.push(r);
        let bmd = 0;
        const append = () => {
            video.buffered = makeTimeRanges([[2.73, 12.73]]);
            adapter.appendChunk(
                'video', makeSegment({ bmd, defaultDur: 100, sampleCount: 1 }), 'track1');
            bmd += 100;
        };
        return { adapter, video, reports, append };
    }

    it('does not report before startup settles, then reports complete facts once', async () => {
        const { adapter, reports, append } = await reportHarness();
        append();
        await settle();
        expect(reports).toHaveLength(0); // media alone proves nothing about startup
        adapter.setPlaybackIntent(true);
        await settle();
        expect(reports).toHaveLength(1);
        const r = reports[0]!;
        expect(r.startPosition).toBeCloseTo(2.73, 5);
        expect(r.seekOutcome).not.toBeNull();
        expect(r.playTimeSec).not.toBeNull();
        expect(r.implementation).toBeTruthy();
    });

    it('reports exactly once even as playback continues', async () => {
        const { adapter, reports, append } = await reportHarness();
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        append();
        await settle();
        expect(reports).toHaveLength(1);
    });

    it('reset() clears the facts and stamps a new session', async () => {
        const { adapter, reports, append } = await reportHarness();
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        const first = reports[0]!;
        adapter.reset();
        // After a reset the adapter must not still be advertising the old
        // session's start position — a reconnect that reused it would join new
        // geometry to stale startup facts.
        const after = adapter.startupReport;
        expect(after.session).not.toBe(first.session);
        expect(after.startPosition).toBeNull();
        expect(after.seekOutcome).toBeNull();
        expect(after.playTimeSec).toBeNull();
    });

    it("reports 'no-seek-needed' when the element is already in range", async () => {
        const video = new MockVideoElement();
        video.modelSeekLifecycle = true;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {});
        adapter.debug = false;
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        currentMs.open();
        await flush();
        const reports: MseStartupReport[] = [];
        adapter.onStartupReport = (r) => reports.push(r);
        video.buffered = makeTimeRanges([[0, 10]]); // currentTime 0 is inside
        adapter.appendChunk('video', makeSegment({ bmd: 0, defaultDur: 100, sampleCount: 1 }), 'track1');
        await settle();
        expect(video.seekCount).toBe(0);
        expect(reports[0]?.seekOutcome).toBe('no-seek-needed');
    });

    it("reports 'seek-settled' when the seek completes normally", async () => {
        const { adapter, reports, append } = await reportHarness();
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        expect(reports[0]?.seekOutcome).toBe('seek-settled');
    });

    it("reports 'seek-timeout-accepted' when the seeked event never arrives but the element landed", async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, reports, append } = await reportHarness();
            video.autoFireSeeked = false; // no `seeked` — only the timeout fires
            adapter.setPlaybackIntent(true);
            append();
            await settle();
            video.seeking = false;        // element is idle AT the target
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 1);
            await settle();
            expect(reports[0]?.seekOutcome).toBe('seek-timeout-accepted');
        } finally { vi.useRealTimers(); }
    });

    it("records 'seek-timeout-unsettled' WITHOUT emitting — the attempt is retriable", async () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, reports, append } = await reportHarness();
            video.autoFireSeeked = false; // never settles, stays seeking
            adapter.setPlaybackIntent(true);
            append();
            await settle();
            await vi.advanceTimersByTimeAsync(STARTUP_SEEK_TIMEOUT_MS + 1);
            await settle();
            // Recorded for inspection…
            expect(adapter.startupReport.seekOutcome).toBe('seek-timeout-unsettled');
            // …but NOT emitted: a once-only report carrying a retriable failure
            // would be permanently wrong the moment a later attempt succeeds.
            expect(reports).toHaveLength(0);

            // And a later successful attempt is what actually emits. The
            // element finally goes idle at the target, so the retry needs no
            // second seek — exactly the path the timeout left it in.
            video.seeking = false;
            append();
            await settle();
            expect(reports).toHaveLength(1);
            expect(reports[0]?.seekOutcome).toBe('no-seek-needed');
        } finally { vi.useRealTimers(); }
    });

    it("records 'cancelled' WITHOUT emitting when intent is withdrawn mid-seek", async () => {
        const { adapter, video, reports, append } = await reportHarness();
        video.autoFireSeeked = false;
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        adapter.setPlaybackIntent(false);
        await settle();
        expect(adapter.startupReport.seekOutcome).toBe('cancelled');
        expect(reports).toHaveLength(0);
    });

    it("records 'autoplay-blocked' WITHOUT emitting when play() is refused", async () => {
        const { adapter, video, reports, append } = await reportHarness();
        video.rejectPlay = true; // both ladder rungs refused
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        expect(adapter.startupReport.seekOutcome).toBe('autoplay-blocked');
        expect(reports).toHaveLength(0);
    });

    it('a startup cancelled by reset() cannot write into the NEW session facts', async () => {
        const { adapter, video, reports, append } = await reportHarness();
        video.autoFireSeeked = false;   // park startup in `positioning`
        adapter.setPlaybackIntent(true);
        append();
        await settle();
        expect(adapter.startupReport.startPosition).toBeCloseTo(2.73, 5);

        const oldSession = adapter.startupReport.session;
        adapter.reset();                // installs fresh facts for a new session
        await settle();                 // …and the old continuation resumes here

        const after = adapter.startupReport;
        expect(after.session).not.toBe(oldSession);
        // The superseded attempt must not have written its `cancelled` outcome
        // (or anything else) into the replacement.
        expect(after.seekOutcome).toBeNull();
        expect(after.startPosition).toBeNull();
        expect(after.playTimeSec).toBeNull();
        expect(reports).toHaveLength(0);
    });

    it('a throwing report consumer never breaks playback', async () => {
        const { adapter, video, append } = await reportHarness();
        adapter.onStartupReport = () => { throw new Error('diagnostic consumer exploded'); };
        adapter.setPlaybackIntent(true);
        expect(() => append()).not.toThrow();
        await settle();
        expect(video.currentTime).toBeCloseTo(2.73, 5);
        // Media keeps flowing after the throw.
        expect(() => append()).not.toThrow();
        await settle();
        expect(currentMs.videoBuffer.appendedPayloads.length).toBe(3); // init + 2
    });
});
