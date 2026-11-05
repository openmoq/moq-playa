/** Observable native-interface test doubles; no decoding or presentation is simulated. */
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
            delete this.throwNextAppend;
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
            const failed = this.errorNextAppend;
            if (failed) {
                this.errorNextAppend = false;
                this.fire('error');
            }
            if (!failed) this.fire('update');
            this.fire('updateend');
        });
    }

    /** Every remove() call, recorded as [start, end]. */
    readonly removeCalls: Array<[number, number]> = [];

    remove(start: number, end: number): void {
        if (this.throwNextRemove) {
            const err = this.throwNextRemove;
            delete this.throwNextRemove;
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
            this.fire('update');
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
    readonly sourceBuffers: MockSourceBuffer[] = [];
    addSourceBuffer(mimeType: string): MockSourceBuffer {
        this.addSourceBufferCalls.push(mimeType);
        const sb = new MockSourceBuffer();
        this.sourceBuffers.push(sb);
        if (mimeType.startsWith('video/')) this.videoBuffer = sb; else this.audioBuffer = sb;
        return sb;
    }
    removeSourceBuffer(sb: unknown): void { const i = this.sourceBuffers.indexOf(sb as MockSourceBuffer); if (i >= 0) this.sourceBuffers.splice(i, 1); }
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

    advancePlayback(time: number): void { this._currentTime = time; }
    frames = 100;
    get currentTime(): number { return this._currentTime; }
    set currentTime(v: number) {
        if (this.throwOnSeek) throw this.throwOnSeek;
        this._currentTime = v;
        this.seekCount++;
        if (!this.modelSeekLifecycle) return;
        this.seeking = true;                   // latches synchronously, as in a real element
        queueMicrotask(() => this.fire('seeking'));
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
    getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number; creationTime: number } {
        return { totalVideoFrames: this.frames, droppedVideoFrames: 0, creationTime: performance.now() };
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


export { MockMediaSource, MockSourceBuffer, MockVideoElement, makeTimeRanges };
