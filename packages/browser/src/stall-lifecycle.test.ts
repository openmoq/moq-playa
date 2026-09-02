/**
 * Stall lifecycle — detection is separate from completion.
 *
 * A stall event answers "playback is stuck right now"; it fires at a threshold
 * while the outage is still running, so its `durationMs` is a detection
 * latency. Only a genuine recovery knows the outage length. Conflating the two
 * made a 43-second freeze report as 257 ms, because measurement ended at the
 * first `timeupdate` — which the HTML Standard queues when the ready state
 * *falls*, and which runs on a ~250 ms cadence.
 *
 * @see https://html.spec.whatwg.org/multipage/media.html
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { CanvasRenderer } from './canvas-renderer.js';

const THRESHOLD = 250;

/** Minimal video element for the stall handlers. */
function makeVideo() {
  return {
    currentTime: 0,
    readyState: 4,
    paused: false,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    addEventListener() {}, removeEventListener() {},
    removeAttribute() {}, setAttribute() {}, load() {}, pause() {},
    play: () => Promise.resolve(),
  } as unknown as HTMLVideoElement;
}

describe('MSE stall lifecycle', () => {
  let detected: number[];
  let recovered: number[];
  let adapter: MseMediaSource;

  beforeEach(() => {
    // The adapter constructs a MediaSource; only the stall handlers are
    // exercised here, so a bare stub suffices.
    vi.stubGlobal('MediaSource', class {
      readyState = 'closed';
      addEventListener() {}
      removeEventListener() {}
      addSourceBuffer() { return {}; }
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    detected = [];
    recovered = [];
    adapter = new MseMediaSource(makeVideo(), { stallThresholdMs: THRESHOLD });
    adapter.onStall = (ms) => detected.push(ms);
    adapter.onStallRecovered = (ms) => recovered.push(ms);
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const waiting = () => (adapter as any).handleWaiting();
  const timeupdate = () => (adapter as any).handleTimeUpdate();
  const playing = () => (adapter as any).handlePlaying();

  it('detects at the threshold and completes on playing, not on timeupdate', () => {
    // Paul's schedule: waiting, a timeupdate at ~260ms, then playing 43s later.
    waiting();
    vi.advanceTimersByTime(THRESHOLD);
    expect(detected).toEqual([THRESHOLD]);

    vi.advanceTimersByTime(10);
    timeupdate();
    expect(recovered).toEqual([]);          // timeupdate is not recovery

    vi.advanceTimersByTime(43_100);
    playing();
    expect(recovered).toEqual([43_360]);    // the real outage
    expect(detected).toHaveLength(1);
  });

  it('is independent of event ordering', () => {
    waiting();
    vi.advanceTimersByTime(THRESHOLD);
    vi.advanceTimersByTime(1_000);
    playing();
    timeupdate();                            // arrives after recovery
    expect(detected).toHaveLength(1);
    expect(recovered).toEqual([1_250]);
  });

  it('keeps the first waiting authoritative when it repeats', () => {
    // A browser may re-emit `waiting` during one uninterrupted freeze;
    // restarting the clock would shorten the reported outage.
    waiting();
    vi.advanceTimersByTime(500);
    waiting();
    vi.advanceTimersByTime(500);
    playing();
    expect(recovered).toEqual([1_000]);
  });

  it('reports nothing for a wait that recovers before the threshold', () => {
    waiting();
    vi.advanceTimersByTime(THRESHOLD - 50);
    playing();
    expect(detected).toEqual([]);
    expect(recovered).toEqual([]);
  });

  it('cancels without completing when destroyed mid-episode', () => {
    waiting();
    vi.advanceTimersByTime(THRESHOLD);
    expect(detected).toHaveLength(1);
    adapter.destroy();
    vi.advanceTimersByTime(10_000);
    expect(recovered).toEqual([]);
  });
});

describe('Canvas stall lifecycle', () => {
  let detected: number[];
  let recovered: number[];
  let renderer: CanvasRenderer;
  let now: number;

  /** A canvas whose 2d context records nothing. */
  function makeCanvas() {
    return {
      width: 2, height: 2,
      getContext: () => ({ canvas: { width: 2, height: 2 }, drawImage() {} }),
    } as unknown as HTMLCanvasElement;
  }

  /** A frame that closes cleanly. */
  function frame(timestampUs: number) {
    return { timestamp: timestampUs, close() {} } as unknown as VideoFrame;
  }

  const BASE = 1_000; // lastRenderTimeMs > 0 gates detection

  beforeEach(() => {
    // Detection is suppressed while the page is hidden, and start() subscribes
    // to visibilitychange.
    vi.stubGlobal('document', {
      hidden: false, addEventListener() {}, removeEventListener() {},
    });
    now = BASE;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    detected = [];
    recovered = [];
    renderer = new CanvasRenderer(makeCanvas(), { stallThresholdMs: THRESHOLD });
    renderer.onStall = (ms) => detected.push(ms);
    renderer.onStallRecovered = (ms) => recovered.push(ms);
    // Render one frame so the renderer has a baseline.
    renderer.enqueue(frame(0), 0);
    (renderer as any).renderTick(0);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('detects once and does not repeat while frozen', () => {
    now = BASE + THRESHOLD + 10;
    (renderer as any).renderTick(now * 1000);
    expect(detected).toHaveLength(1);
    now = BASE + 5_000;
    (renderer as any).renderTick(now * 1000);
    expect(detected).toHaveLength(1);
  });

  it('completes with the full interval on the next rendered frame', () => {
    now = BASE + THRESHOLD + 10;
    (renderer as any).renderTick(now * 1000);
    now = BASE + 43_360;
    renderer.enqueue(frame(1_000), 0);
    (renderer as any).renderTick(now * 1000);
    expect(recovered).toEqual([43_360]);
  });

  it('survives a recovery-owned flush so the next frame still completes it', () => {
    // The player's stall recovery resets the video pipeline, which flushes this
    // renderer. Dropping the episode there would make an automatically
    // recovered stall permanently unreportable.
    now = BASE + THRESHOLD + 10;
    (renderer as any).renderTick(now * 1000);
    expect(detected).toHaveLength(1);

    renderer.flush();

    now = BASE + 2_000;
    renderer.enqueue(frame(2_000), 0);
    (renderer as any).renderTick(now * 1000);
    expect(recovered).toEqual([2_000]);
  });

  it('cancels on an explicit supersede without completing', () => {
    now = BASE + THRESHOLD + 10;
    (renderer as any).renderTick(now * 1000);
    renderer.cancelStallEpisode();
    now = BASE + 3_000;
    renderer.enqueue(frame(3_000), 0);
    (renderer as any).renderTick(now * 1000);
    expect(recovered).toEqual([]);
  });

  it('commits frame state before publishing, so a throwing listener cannot corrupt it', () => {
    // TypedEmitter propagates listener exceptions by design. A throwing
    // `stall_recovered` handler must not leave the frame half-recorded or the
    // old episode able to redetect.
    now = BASE + THRESHOLD + 10;
    (renderer as any).renderTick(now * 1000);
    expect(detected).toHaveLength(1);

    renderer.onStallRecovered = () => { throw new Error('listener bug'); };
    now = BASE + 2_000;
    renderer.enqueue(frame(2_000), 0);
    expect(() => (renderer as any).renderTick(now * 1000)).toThrow('listener bug');

    // The frame was fully recorded despite the throw: no episode survives, so
    // a later tick at the same instant cannot redetect the old one.
    renderer.onStallRecovered = (ms) => recovered.push(ms);
    (renderer as any).renderTick(now * 1000);
    expect(detected).toHaveLength(1);
    expect(recovered).toEqual([]);
  });

  it('reports nothing when a frame arrives before the threshold', () => {
    now = BASE + THRESHOLD - 50;
    renderer.enqueue(frame(500), 0);
    (renderer as any).renderTick(now * 1000);
    expect(detected).toEqual([]);
    expect(recovered).toEqual([]);
  });
});

describe('MSE episode ownership across intentional playback changes', () => {
  let detected: number[];
  let recovered: number[];
  let adapter: MseMediaSource;

  beforeEach(() => {
    vi.stubGlobal('MediaSource', class {
      readyState = 'closed';
      addEventListener() {}
      removeEventListener() {}
      addSourceBuffer() { return {}; }
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    detected = [];
    recovered = [];
    adapter = new MseMediaSource(makeVideo(), { stallThresholdMs: THRESHOLD });
    adapter.onStall = (ms) => detected.push(ms);
    adapter.onStallRecovered = (ms) => recovered.push(ms);
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const waiting = () => (adapter as any).handleWaiting();
  const playing = () => (adapter as any).handlePlaying();

  it('a pause cancels a detected episode, so resuming completes nothing', () => {
    // Otherwise the episode spans the paused interval and reports it as an
    // outage the moment the user resumes.
    waiting();
    vi.advanceTimersByTime(THRESHOLD);
    expect(detected).toHaveLength(1);

    adapter.setPlaybackIntent(false);
    vi.advanceTimersByTime(60_000);
    adapter.setPlaybackIntent(true);
    playing();

    expect(recovered).toEqual([]);
  });

  it('a waiting delivered after pause is not a stall', () => {
    adapter.setPlaybackIntent(false);
    waiting();
    vi.advanceTimersByTime(THRESHOLD * 4);
    expect(detected).toEqual([]);
  });

  it('an explicit cancel supersedes a detected episode', () => {
    waiting();
    vi.advanceTimersByTime(THRESHOLD);
    adapter.cancelStallEpisode();
    vi.advanceTimersByTime(5_000);
    playing();
    expect(recovered).toEqual([]);
  });
});

describe('stall threshold validation', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaSource', class {
      readyState = 'closed';
      addEventListener() {}
      removeEventListener() {}
      addSourceBuffer() { return {}; }
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('rejects values that would silently become an immediate timer', () => {
    // setTimeout coerces NaN and overflow to 0, turning an explicit policy
    // back into the accidental one this change exists to remove.
    for (const bad of [NaN, Infinity, -1, 12.5, 2_147_483_648]) {
      expect(
        () => new MseMediaSource(makeVideo(), { stallThresholdMs: bad }),
        `must reject ${bad}`,
      ).toThrow(RangeError);
    }
  });

  it('accepts a non-negative integer', () => {
    expect(() => new MseMediaSource(makeVideo(), { stallThresholdMs: 0 })).not.toThrow();
    expect(() => new MseMediaSource(makeVideo(), { stallThresholdMs: 1_000 })).not.toThrow();
  });
});

describe('MSE publishes recovery only after committing its own state', () => {
  it('commits firstFrameFired before a throwing recovered listener runs', () => {
    vi.stubGlobal('MediaSource', class {
      readyState = 'closed';
      addEventListener() {}
      removeEventListener() {}
      addSourceBuffer() { return {}; }
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const adapter = new MseMediaSource(makeVideo(), { stallThresholdMs: THRESHOLD });
      let firstFrames = 0;
      adapter.onFirstFrame = () => { firstFrames++; };
      adapter.onStall = () => {};
      adapter.onStallRecovered = () => { throw new Error('listener bug'); };

      (adapter as any).handleWaiting();
      vi.advanceTimersByTime(THRESHOLD);
      expect(() => (adapter as any).handlePlaying()).toThrow('listener bug');

      // Assert immediately: a later `playing` would commit first-frame state
      // itself and mask a publish-before-commit ordering.
      expect(firstFrames).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('a throwing listener cannot end the render loop', () => {
  it('re-arms the next animation frame even when recovery publication throws', () => {
    // The rAF loop scheduled the next frame AFTER the tick, so a propagated
    // listener exception silently ended playback.
    let now = 1_000;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('document', {
      hidden: false, addEventListener() {}, removeEventListener() {},
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    try {
      const ctx = { canvas: { width: 2, height: 2 }, drawImage() {} };
      const renderer = new CanvasRenderer(
        { getContext: () => ctx } as unknown as HTMLCanvasElement,
        { stallThresholdMs: THRESHOLD },
      );
      const frame = (ts: number) => ({ timestamp: ts, close() {} }) as unknown as VideoFrame;

      renderer.enqueue(frame(0), 0);
      renderer.start();
      frames.pop()!(0);                       // first tick renders the baseline

      now = 1_000 + THRESHOLD + 10;
      frames.pop()!(0);                       // detects
      renderer.onStallRecovered = () => { throw new Error('listener bug'); };

      now = 5_000;
      renderer.enqueue(frame(1_000), 0);
      const armed = frames.length;
      expect(() => frames.pop()!(0)).toThrow('listener bug');

      // The loop must still be alive.
      expect(frames.length).toBe(armed);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe('the hidden-tab loop matches the rAF contract', () => {
  it('retires on stop() and still lets the listener exception escape', () => {
    // The interval path must not swallow what the rAF path propagates, even
    // when the listener tears the renderer down before throwing.
    let now = 1_000;
    let tick: (() => void) | null = null;
    let cleared = 0;
    // `hidden` selects the interval path at start(); detection is suppressed
    // while hidden, so it is cleared once the loop is armed.
    const doc = { hidden: true, addEventListener() {}, removeEventListener() {} };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('setInterval', (fn: () => void) => { tick = fn; return 7; });
    vi.stubGlobal('clearInterval', () => { cleared++; });
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    try {
      const ctx = { canvas: { width: 2, height: 2 }, drawImage() {} };
      const renderer = new CanvasRenderer(
        { getContext: () => ctx } as unknown as HTMLCanvasElement,
        { stallThresholdMs: THRESHOLD },
      );
      const frame = (ts: number) => ({ timestamp: ts, close() {} }) as unknown as VideoFrame;

      renderer.enqueue(frame(0), 0);
      renderer.start();
      doc.hidden = false;                       // loop armed; allow detection
      tick!();                                  // baseline frame

      now = 1_000 + THRESHOLD + 10;
      tick!();                                  // detects
      renderer.onStallRecovered = () => {
        renderer.stop();                        // tear down, THEN throw
        throw new Error('listener bug');
      };

      now = 5_000;
      renderer.enqueue(frame(1_000), 0);
      expect(() => tick!()).toThrow('listener bug');
      expect(cleared).toBeGreaterThan(0);       // the interval was retired
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe('Canvas validates before acquiring browser state', () => {
  it('rejects an invalid threshold without calling getContext', () => {
    const getContext = vi.fn(() => ({ canvas: { width: 2, height: 2 }, drawImage() {} }));
    const canvas = { getContext } as unknown as HTMLCanvasElement;
    for (const bad of [NaN, Infinity, -1, 12.5, 2_147_483_648]) {
      expect(
        () => new CanvasRenderer(canvas, { stallThresholdMs: bad }),
        `must reject ${bad}`,
      ).toThrow(RangeError);
    }
    expect(getContext).not.toHaveBeenCalled();
  });
});
