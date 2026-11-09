import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoqtPlayer, PlayerErrorCode, TypedEmitter, createPlayerError } from '@openmoq/player';
import type { PlayerEventMap as EngineEventMap } from '@openmoq/player';
import { Player } from './player.js';

const players: Player[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { hidden: true, removeEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(async () => {
  for (const player of players.splice(0)) await player.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(strategy: 'mse' | 'webcodecs' = 'mse') {
  vi.stubGlobal('VideoDecoder', strategy === 'webcodecs' ? class {} : undefined);
  vi.stubGlobal('AudioDecoder', strategy === 'webcodecs' ? class {} : undefined);
  vi.stubGlobal('MediaSource', class {});
  const events = new TypedEmitter<EngineEventMap>();
  vi.spyOn(MoqtPlayer.prototype, 'on').mockImplementation(events.on.bind(events));
  const native = vi.fn(() => 2);
  const video = { volume: 1, muted: false, hidden: true, get currentTime() { return native(); } };
  const player = new Player(null, {
    url: 'https://relay.example/moq', namespace: 'test', audioActivation: 'gesture',
    canvas: {} as HTMLCanvasElement, video: video as unknown as HTMLVideoElement,
    moqtPlayerConfig: { logLevel: 'none' },
  });
  players.push(player);
  const engine = player.diagnosticSource;
  const position = vi.spyOn(engine, 'playbackPositionMs', 'get').mockReturnValue(null);
  const baseStats = engine.stats;
  const stats = vi.spyOn(engine, 'stats', 'get').mockReturnValue({ ...baseStats, playbackDurationMs: 100 });
  const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
  const pause = vi.spyOn(engine, 'pause').mockImplementation(() => {});
  const destroy = vi.spyOn(engine, 'destroy').mockResolvedValue();
  return { player, engine, events, position, native, stats, baseStats, play, pause, destroy };
}

describe('facade playback position', () => {
  it('reads the owned engine clock on each getter without RAF, including zero', () => {
    const f = fixture(); f.player.play();
    f.position.mockReturnValue(0); expect(f.player.currentTime).toBe(0);
    f.position.mockReturnValue(12_345); expect(f.player.currentTime).toBe(12_345);
    f.position.mockReturnValue(12_678); expect(f.player.currentTime).toBe(12_678);
    expect(f.position).toHaveBeenCalledTimes(3);
    expect(f.native).not.toHaveBeenCalled(); expect(f.stats).not.toHaveBeenCalled();
  });

  it('holds the owned pending-seek target despite old native numerical movement', () => {
    const f = fixture(); f.player.play(); f.position.mockReturnValue(50_000);
    for (const oldTime of [2, 2.5, 60]) { f.native.mockReturnValue(oldTime); expect(f.player.currentTime).toBe(50_000); }
    expect(f.native).not.toHaveBeenCalled();
    f.position.mockReturnValue(50_120); expect(f.player.currentTime).toBe(50_120);
  });

  it('samples active native time directly while playing even when the borrowed element is hidden', () => {
    const f = fixture(); f.player.play();
    expect(f.player.currentTime).toBe(2000);
    f.native.mockReturnValue(2.75); expect(f.player.currentTime).toBe(2750);
    expect(f.stats).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE, -1])('holds the last value for invalid native time %s', invalid => {
    const f = fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
    f.native.mockReturnValue(invalid); expect(f.player.currentTime).toBe(2000);
    expect(f.stats).not.toHaveBeenCalled();
    f.native.mockReturnValue(3); expect(f.player.currentTime).toBe(3000);
  });

  it('holds the last value when the native getter fails', () => {
    const f = fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
    f.native.mockImplementation(() => { throw new Error('retired native clock'); });
    expect(f.player.currentTime).toBe(2000);
  });

  it('samples once before pause and freezes legacy time while the native sink moves', () => {
    const f = fixture(); f.player.play();
    const order: string[] = [];
    f.native.mockImplementation(() => { order.push('sample'); return 2.75; });
    f.pause.mockImplementation(() => { order.push('pause'); f.native.mockReturnValue(99); });
    f.player.pause();
    expect(order).toEqual(['sample', 'pause']);
    expect(f.player.currentTime).toBe(2750); expect(f.player.currentTime).toBe(2750);
    expect(f.native).toHaveBeenCalledOnce(); expect(f.stats).not.toHaveBeenCalled();
    f.player.play(); expect(f.player.currentTime).toBe(99_000);
  });

  it('preserves the engine paused clock and exposes a new admitted target while paused', () => {
    const f = fixture(); f.player.play(); f.position.mockReturnValue(2400);
    f.pause.mockImplementation(() => { f.position.mockReturnValue(2400); });
    f.player.pause(); expect(f.position).toHaveBeenCalledOnce();
    f.native.mockReturnValue(100); expect(f.player.currentTime).toBe(2400);
    f.position.mockReturnValue(10_000); expect(f.player.currentTime).toBe(10_000);
    expect(f.native).not.toHaveBeenCalled();
  });

  it('keeps legacy elapsed stats for an inactive native sink and freezes them on pause', () => {
    const f = fixture('webcodecs');
    expect(f.player.currentTime).toBe(0);
    f.player.play(); expect(f.player.currentTime).toBe(100);
    f.stats.mockReturnValue({ ...f.baseStats, playbackDurationMs: 350 });
    expect(f.player.currentTime).toBe(350);
    f.player.pause(); f.stats.mockClear(); f.stats.mockReturnValue({ ...f.baseStats, playbackDurationMs: 900 });
    expect(f.player.currentTime).toBe(350); expect(f.stats).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  });

  it('keeps the initial committed position while idle without reading either legacy clock', () => {
    const f = fixture(); expect(f.player.currentTime).toBe(0);
    expect(f.native).not.toHaveBeenCalled(); expect(f.stats).not.toHaveBeenCalled();
  });

  it('keeps committed position while load is pending', async () => {
    const f = fixture(), gate = deferred(); vi.spyOn(f.engine, 'load').mockReturnValue(gate.promise);
    const loading = f.player.load();
    try {
      expect(f.player.state).toBe('loading'); expect(f.player.currentTime).toBe(0);
      expect(f.native).not.toHaveBeenCalled(); expect(f.stats).not.toHaveBeenCalled();
    } finally { gate.resolve(); await loading; }
  });

  it.each(['mse', 'webcodecs'] as const)('holds committed %s position after a fatal engine error while elapsed stats advance', strategy => {
    const f = fixture(strategy); f.player.play();
    const committed = strategy === 'mse' ? 2000 : 100;
    expect(f.player.currentTime).toBe(committed);
    const error = vi.fn(); f.player.on('error', error);
    f.events.emit('error', { type: 'error', error: createPlayerError('fatal', 'decoder', PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE, 'fatal media gap') });
    expect(f.player.state).toBe('error'); expect(error).toHaveBeenCalledOnce();
    f.stats.mockClear().mockReturnValue({ ...f.baseStats, playbackDurationMs: 9000 }); f.native.mockClear().mockReturnValue(99);
    expect(f.player.currentTime).toBe(committed);
    f.stats.mockReturnValue({ ...f.baseStats, playbackDurationMs: 12_000 });
    expect(f.player.currentTime).toBe(committed);
    expect(f.stats).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  });

  it.each(['mse', 'webcodecs'] as const)('holds committed %s position after the engine ended event stops RAF', strategy => {
    const f = fixture(strategy); f.player.play();
    const committed = strategy === 'mse' ? 2000 : 100;
    expect(f.player.currentTime).toBe(committed);
    f.events.emit('state_changed', { type: 'state_changed', from: 'playing', to: 'ended' });
    expect(f.player.state).toBe('ended'); expect(cancelAnimationFrame).toHaveBeenCalled();
    f.stats.mockClear().mockReturnValue({ ...f.baseStats, playbackDurationMs: 9000 }); f.native.mockClear().mockReturnValue(99);
    expect(f.player.currentTime).toBe(committed);
    expect(f.stats).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, -Infinity])('holds the last owned position for invalid engine clock %s without falling back', invalid => {
    const f = fixture(); f.player.play(); f.position.mockReturnValue(2400); expect(f.player.currentTime).toBe(2400);
    f.position.mockReturnValue(invalid); expect(f.player.currentTime).toBe(2400);
    expect(f.native).not.toHaveBeenCalled(); expect(f.stats).not.toHaveBeenCalled();
  });

  it('rejects negative elapsed samples while preserving healthy elapsed progression during playing', () => {
    const f = fixture('webcodecs'); f.player.play(); expect(f.player.currentTime).toBe(100);
    f.stats.mockReturnValue({ ...f.baseStats, playbackDurationMs: -1 }); expect(f.player.currentTime).toBe(100);
    f.stats.mockReturnValue({ ...f.baseStats, playbackDurationMs: 350 }); expect(f.player.currentTime).toBe(350);
  });

  it('emits timeupdate from the same authoritative getter', () => {
    const f = fixture(); const update = vi.fn(); f.player.on('timeupdate', update); f.player.play();
    f.position.mockReturnValue(7400); vi.mocked(performance.now).mockReturnValue(1000);
    const callback = vi.mocked(requestAnimationFrame).mock.calls[0]![0]; callback(1000);
    expect(update).toHaveBeenCalledExactlyOnceWith({ currentTime: 7400 });
    expect(f.player.currentTime).toBe(7400); expect(f.native).not.toHaveBeenCalled();
  });

  it('retires clock reads and seek events before asynchronous destruction finishes', async () => {
    const f = fixture(); f.player.play(); f.position.mockReturnValue(3100); expect(f.player.currentTime).toBe(3100);
    const gate = deferred(); f.destroy.mockReturnValue(gate.promise);
    const seeked = vi.fn(); f.player.on('seeked', seeked);
    const destroying = f.player.destroy();
    try {
      f.position.mockClear().mockReturnValue(99_000); f.native.mockClear(); f.stats.mockClear();
      f.events.emit('seeked', { type: 'seeked', actualTimeMs: 99_000, groupId: 1, objectId: 0 });
      expect(f.player.currentTime).toBe(3100);
      expect(f.position).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.stats).not.toHaveBeenCalled(); expect(seeked).not.toHaveBeenCalled();
    } finally { gate.resolve(); await destroying; }
    expect(f.player.currentTime).toBe(3100);
  });

  it('does not publish a native sample whose getter destroys the facade', async () => {
    const f = fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
    let destroying: Promise<void> | undefined;
    f.native.mockImplementation(() => { destroying = f.player.destroy(); return 99; });
    expect(f.player.currentTime).toBe(2000); await destroying;
  });
});

describe('facade seek delegation and engine events', () => {
  it('emits only engine-admitted events and reports actual landing rather than the request target', async () => {
    const f = fixture(); f.player.play(); const gate = deferred();
    const seek = vi.spyOn(f.engine, 'seek').mockReturnValue(gate.promise), seeking = vi.fn(), seeked = vi.fn();
    f.player.on('seeking', seeking); f.player.on('seeked', seeked);
    const request = f.player.seek(5000);
    expect(seek).toHaveBeenCalledExactlyOnceWith(5000); expect(seeking).not.toHaveBeenCalled(); expect(seeked).not.toHaveBeenCalled();
    f.position.mockReturnValue(5000); f.events.emit('seeking', { type: 'seeking', targetTimeMs: 5000 });
    expect(seeking).toHaveBeenCalledExactlyOnceWith({ targetTime: 5000 });
    gate.resolve(); await request;
    expect(seeked).not.toHaveBeenCalled(); expect(f.player.currentTime).toBe(5000);
    f.position.mockReturnValue(5120); f.events.emit('seeked', { type: 'seeked', actualTimeMs: 5120, groupId: 7, objectId: 8 });
    expect(seeked).toHaveBeenCalledExactlyOnceWith({ currentTime: 5120 }); expect(f.player.currentTime).toBe(5120);
  });

  it('does not invent seek events or position changes for an unadmitted no-op', async () => {
    const f = fixture('webcodecs'); const seeking = vi.fn(), seeked = vi.fn();
    f.player.on('seeking', seeking); f.player.on('seeked', seeked);
    vi.spyOn(f.engine, 'seek').mockResolvedValue(); await f.player.seek(9999);
    expect(seeking).not.toHaveBeenCalled(); expect(seeked).not.toHaveBeenCalled(); expect(f.player.currentTime).toBe(0);
  });

  it('propagates a rejected seek without optimistic facade events', async () => {
    const f = fixture(); const seeking = vi.fn(), seeked = vi.fn();
    f.player.on('seeking', seeking); f.player.on('seeked', seeked);
    vi.spyOn(f.engine, 'seek').mockRejectedValue(new Error('not admitted'));
    await expect(f.player.seek(1000)).rejects.toThrow('not admitted');
    expect(seeking).not.toHaveBeenCalled(); expect(seeked).not.toHaveBeenCalled();
  });

  it('bridges direct engine events and records actual legacy landing while paused', () => {
    const f = fixture('webcodecs'); f.player.play(); f.player.pause(); const seeking = vi.fn(), seeked = vi.fn();
    f.player.on('seeking', seeking); f.player.on('seeked', seeked);
    f.events.emit('seeking', { type: 'seeking', targetTimeMs: 6000 });
    f.events.emit('seeked', { type: 'seeked', actualTimeMs: 5750, groupId: 4, objectId: 1 });
    expect(seeking).toHaveBeenCalledExactlyOnceWith({ targetTime: 6000 });
    expect(seeked).toHaveBeenCalledExactlyOnceWith({ currentTime: 5750 }); expect(f.player.currentTime).toBe(5750);
  });
});

it('fatal error callback observes a held legacy clock and committed error state',()=>{
 const f=fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
 f.native.mockReturnValue(99); let observed:{state:string,time:number}|undefined;
 f.player.on('error',()=>{observed={state:f.player.state,time:f.player.currentTime};});
 f.events.emit('error',{type:'error',error:createPlayerError('fatal','decoder',PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE,'fatal fixture')});
 expect(observed).toEqual({state:'error',time:2000});
 expect(f.player.state).toBe('error'); expect(f.player.currentTime).toBe(2000);
});

it('throwing fatal error observer cannot prevent the facade from holding its position',()=>{
 const f=fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
 f.player.on('error',()=>{throw new Error('observer refused');});
 expect(()=>f.events.emit('error',{type:'error',error:createPlayerError('fatal','decoder',PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE,'fatal fixture')})).toThrow('observer refused');
 f.native.mockReturnValue(99);
 expect(f.player.state).toBe('error'); expect(f.player.currentTime).toBe(2000);
});

it('a degraded observer still sees a playing clock',()=>{
 const f=fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
 f.native.mockReturnValue(2.5); let observed:{state:string,time:number}|undefined;
 f.player.on('error',()=>{observed={state:f.player.state,time:f.player.currentTime};});
 f.events.emit('error',{type:'error',error:createPlayerError('degraded','player',PlayerErrorCode.SEEK_FAILED,'degraded fixture')});
 expect(observed).toEqual({state:'playing',time:2500});
});

it.each([undefined, null, false])('commits fatal state and attempts statechange even when the error observer throws %s', value => {
  const f = fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
  const order: string[] = [];
  f.player.on('error', () => { order.push('error'); throw value; });
  f.player.on('statechange', () => { order.push('statechange'); });
  let threw = false, caught: unknown;
  try { f.events.emit('error', { type: 'error', error: createPlayerError('fatal', 'decoder', PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE, 'fatal fixture') }); }
  catch (error) { threw = true; caught = error; }
  expect(threw).toBe(true); expect(caught).toBe(value);
  expect(order).toEqual(['error', 'statechange']);
  expect(f.player.state).toBe('error'); expect(f.player.currentTime).toBe(2000);
});

it('keeps error publication when a fatal statechange observer throws', () => {
  const f = fixture(); f.player.play();
  const error = vi.fn(); f.player.on('error', error);
  f.player.on('statechange', event => { if (event.state === 'error') throw new Error('state observer refused'); });
  expect(() => f.events.emit('error', { type: 'error', error: createPlayerError('fatal', 'decoder', PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE, 'fatal fixture') }))
    .toThrow('state observer refused');
  expect(error).toHaveBeenCalledOnce(); expect(f.player.state).toBe('error');
});

it('holds legacy time on the engine error-state event even when its error notification is filtered', () => {
  const f = fixture(); f.player.play(); expect(f.player.currentTime).toBe(2000);
  f.native.mockReturnValue(99);
  f.events.emit('state_changed', { type: 'state_changed', from: 'playing', to: 'error' });
  expect(f.player.state).toBe('error'); expect(f.player.currentTime).toBe(2000);
});
