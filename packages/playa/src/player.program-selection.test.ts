import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogState } from '@openmoq/msf';
import type { MediaSelectionOptions, MediaSelectionSnapshot, MoqtPlayer, PlayerEventMap, TypedEmitter } from '@openmoq/player';
import { Player } from './player.js';

function element() {
  return { style: {}, hidden: false, muted: false, volume: 1, playsInline: false,
    appendChild: vi.fn(), removeChild: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })), parentNode: null,
    play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
}
beforeEach(() => {
  vi.stubGlobal('document', { createElement: element, hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  for (const name of ['HTMLElement', 'HTMLVideoElement', 'HTMLCanvasElement']) vi.stubGlobal(name, class {});
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const catalog: CatalogState = { version: 1, tracks: [
  { name: 'main', role: 'video', renderGroup: 0, altGroup: 1, codec: 'avc1.42c028', packaging: 'loc', isLive: true },
  { name: 'other', namespace: 'other/view', role: 'video', renderGroup: 0, codec: 'avc1.42c028', packaging: 'loc', isLive: true },
  { name: 'main', namespace: 'next/program', role: 'video', renderGroup: 2, altGroup: 1, codec: 'avc1.42c028', packaging: 'loc', isLive: true },
] };
const oldVideo = { name: 'main', namespaceFields: ['live/show'] };
const selected: MediaSelectionSnapshot = { revision: 1, scope: { kind: 'render-group', renderGroup: 0 },
  video: oldVideo, audio: null, videoAlternatives: [oldVideo], audioChoices: [], autoQuality: true };
function fixture() {
  const player = new Player(element() as unknown as HTMLElement, { url: 'https://relay.example/moq', namespace: 'live/show',
    audioActivation: 'gesture', moqtPlayerConfig: { namespace: ['live/show'] } });
  const engine = (player as unknown as { engine: Pick<MoqtPlayer, 'selectMedia' | 'selectVideoTrack' | 'mediaTimelineReference'>
    & { emitter: TypedEmitter<PlayerEventMap> } }).engine;
  engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog });
  const adopt = (state: MediaSelectionSnapshot) => engine.emitter.emit('selection_changed',
    { type: 'selection_changed', selection: state, catalog });
  adopt(selected);
  return { player, engine, adopt };
}

describe('facade program and view selection', () => {
  it('keeps the full identity when a quality level shares its name with another rendition', async () => {
    const f = fixture(), select = vi.spyOn(f.engine, 'selectVideoTrack').mockResolvedValue();
    try {
      const lower = { name: 'main', namespaceFields: ['video', 'rendition'] };
      const expanded: CatalogState = { ...catalog, tracks: [...catalog.tracks,
        { ...catalog.tracks[0]!, namespace: 'video/rendition', bitrate: 1000 }] };
      f.engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: expanded });
      f.engine.emitter.emit('selection_changed', { type: 'selection_changed', catalog: expanded,
        selection: { ...selected, videoAlternatives: [oldVideo, lower] } });
      const level = f.player.levels.find(item => JSON.stringify(item.namespace) === JSON.stringify(lower.namespaceFields));
      expect(level).toBeDefined();
      const before = f.player.currentLevel;
      await f.player.setQuality(level!.index);
      expect(select).toHaveBeenCalledExactlyOnceWith({ name: lower.name, namespace: lower.namespaceFields }, 'manual');
      expect(f.player.currentLevel).toBe(before);
    } finally { await f.player.destroy(); }
  });

  it('forwards an exact program selector but changes readback only after adoption', async () => {
    const f = fixture();
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    const select = vi.spyOn(f.engine, 'selectMedia').mockReturnValue(pending);
    try {
      const target = f.player.programs[1]!;
      const previous = f.player.currentProgram, changed = vi.fn(); f.player.on('programchange', changed);
      const options: MediaSelectionOptions = { timeline: { kind: 'reference-map', referenceToken: {},
        video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 10_000_000n } } };
      const operation = f.player.selectProgram(target.id, options);
      expect(select).toHaveBeenCalledExactlyOnceWith({ renderGroup: 2 }, options);
      expect(f.player.currentProgram).toBe(previous); expect(changed).not.toHaveBeenCalled();
      const identity = { name: 'main', namespaceFields: ['next', 'program'] };
      f.adopt({ ...selected, revision: 2, scope: { kind: 'render-group', renderGroup: 2 },
        video: identity, videoAlternatives: [identity] });
      resolve(); await operation;
      expect(f.player.currentProgram).toBe(target.id);
      expect(changed).toHaveBeenCalledExactlyOnceWith({ program: f.player.programs[1] });
    } finally { resolve(); await f.player.destroy(); }
  });

  it('uses the singleton full identity and leaves adoption to the engine', async () => {
    const f = fixture(), select = vi.spyOn(f.engine, 'selectMedia').mockResolvedValue();
    try {
      const target = f.player.views[1]!, previous = f.player.currentView;
      await f.player.selectView(target.id);
      expect(select).toHaveBeenCalledExactlyOnceWith({ renderGroup: 0,
        videoTrack: { name: 'other', namespace: ['other', 'view'] } }, undefined);
      expect(f.player.currentView).toBe(previous);
    } finally { await f.player.destroy(); }
  });

  it('refuses a view from another program instead of silently changing both outputs', async () => {
    const f = fixture(), select = vi.spyOn(f.engine, 'selectMedia').mockResolvedValue();
    try {
      await expect(f.player.selectView(f.player.programs[1]!.views[0]!.id)).rejects.toThrow(/active program/);
      expect(select).not.toHaveBeenCalled(); expect(f.player.currentProgram).toBe(f.player.programs[0]!.id);
    } finally { await f.player.destroy(); }
  });

  it('reports one view failure and retains the adopted menu', async () => {
    const f = fixture(); vi.spyOn(f.engine, 'selectMedia').mockRejectedValue(new Error('no usable target'));
    try {
      const target = f.player.views[1]!, previous = f.player.currentView, failed = vi.fn(); f.player.on('viewchangefailed', failed);
      await expect(f.player.selectView(target.id)).rejects.toThrow('no usable target');
      expect(failed).toHaveBeenCalledExactlyOnceWith({ viewId: target.id, message: 'no usable target' });
      expect(f.player.currentView).toBe(previous);
    } finally { await f.player.destroy(); }
  });

  it('rejects unknown and post-destroy identities without consulting the engine', async () => {
    const f = fixture(), select = vi.spyOn(f.engine, 'selectMedia').mockResolvedValue();
    try {
      await expect(f.player.selectProgram('missing')).rejects.toThrow(/Unknown program/);
      await expect(f.player.selectView('missing')).rejects.toThrow(/Unknown view/);
      expect(select).not.toHaveBeenCalled();
      const id = f.player.programs[1]!.id; await f.player.destroy();
      await expect(f.player.selectProgram(id)).rejects.toThrow(/destruction/);
      expect(select).not.toHaveBeenCalled();
    } finally { await f.player.destroy(); }
  });

  it('exposes the canonical reference without replacing the owner token', async () => {
    const f = fixture(), token = {}, reference = { token, track: oldVideo, domain: 'media-time' as const, observedSourceTimeUs: 1n };
    const read = vi.spyOn(f.engine, 'mediaTimelineReference', 'get').mockReturnValue(reference);
    try { expect(f.player.mediaTimelineReference).toBe(reference); }
    finally { await f.player.destroy(); }
    read.mockClear(); expect(f.player.mediaTimelineReference).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
});

describe('facade selection notification ownership', () => {
  const nextState = () => { const video = { name: 'main', namespaceFields: ['next', 'program'] };
    return { ...selected, revision: 2, scope: { kind: 'render-group' as const, renderGroup: 2 }, video, videoAlternatives: [video] }; };

  it('emits only the current view after a program callback reenters with a newer adoption', async () => {
    const f = fixture(), events: string[] = [], views = vi.fn();
    try {
      const oldProgram = f.player.currentProgram!, newProgram = f.player.programs[1]!.id, oldView = f.player.currentView;
      f.player.on('programchange', event => {
        events.push(event.program!.id);
        if (event.program!.id === newProgram) f.adopt({ ...selected, revision: 3 });
      });
      f.player.on('viewchange', views);
      f.adopt(nextState());
      expect(events).toEqual([newProgram, oldProgram]);
      expect(f.player.currentProgram).toBe(oldProgram);
      expect(views).toHaveBeenCalledTimes(1);
      expect(views.mock.calls[0]![0].view.id).toBe(oldView);
    } finally { await f.player.destroy(); }
  });

  it('does not emit stale program/view notifications after audio callback reentry', async () => {
    const f = fixture(), programs = vi.fn(), views = vi.fn();
    const audioCatalog = { ...catalog, tracks: [...catalog.tracks,
      { name: 'a0', namespace: 'old/sound', role: 'audio' as const, renderGroup: 0, codec: 'opus', packaging: 'loc' as const, isLive: true },
      { name: 'a2', namespace: 'next/sound', role: 'audio' as const, renderGroup: 2, codec: 'opus', packaging: 'loc' as const, isLive: true }] };
    const a0 = { name: 'a0', namespaceFields: ['old','sound'] }, a2 = { name: 'a2', namespaceFields: ['next','sound'] };
    const old = { ...selected, audio: a0, audioChoices: [a0] };
    const adopt = (state: MediaSelectionSnapshot) => f.engine.emitter.emit('selection_changed', { type: 'selection_changed', selection: state, catalog: audioCatalog });
    try {
      adopt(old);
      f.player.on('programchange', programs); f.player.on('viewchange', views);
      f.player.on('audiochange', event => { if (event.track.trackName === 'a2') adopt({ ...old, revision: 3 }); });
      adopt({ ...nextState(), audio: a2, audioChoices: [a2] });
      expect(f.player.currentProgram).toBe(f.player.programs[0]!.id);
      expect(programs.mock.calls.map(call => call[0].program.id)).toEqual([f.player.programs[0]!.id]);
      expect(views.mock.calls.map(call => call[0].view.id)).toEqual([f.player.currentView]);
    } finally { await f.player.destroy(); }
  });

  it('stops post-adoption view events immediately when a program callback destroys the facade', async () => {
    const f = fixture(), views = vi.fn(); let destroyed: Promise<void> | undefined;
    f.player.on('programchange', () => { destroyed = f.player.destroy(); }); f.player.on('viewchange', views);
    try {
      f.adopt(nextState());
      expect(views).not.toHaveBeenCalled();
      expect(f.player.currentProgram).toBeNull(); expect(f.player.currentView).toBeNull();
      expect(f.player.mediaTimelineReference).toBeNull();
      await destroyed;
    } finally { await f.player.destroy(); }
  });

  it.each(['program', 'view'] as const)('preserves %s rejection identity when a failure listener throws', async role => {
    const f = fixture(), original = Object.freeze({ code: 123, toString: () => 'original rejection' });
    const failed = vi.fn(() => { throw Error('listener exception'); });
    vi.spyOn(f.engine, 'selectMedia').mockRejectedValue(original);
    try {
      const before = { program: f.player.currentProgram, view: f.player.currentView };
      if (role === 'program') {
        f.player.on('programchangefailed', failed);
        await expect(f.player.selectProgram(f.player.programs[1]!.id)).rejects.toBe(original);
      } else {
        f.player.on('viewchangefailed', failed);
        await expect(f.player.selectView(f.player.views[1]!.id)).rejects.toBe(original);
      }
      expect(failed).toHaveBeenCalledOnce();
      expect({ program: f.player.currentProgram, view: f.player.currentView }).toEqual(before);
    } finally { await f.player.destroy(); }
  });

  it.each(['program', 'view'] as const)('does not report a late %s failure after destruction', async role => {
    const f = fixture(); let reject!: (value: Error) => void;
    vi.spyOn(f.engine, 'selectMedia').mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const failed = vi.fn();
    f.player.on('programchangefailed', failed); f.player.on('viewchangefailed', failed);
    const pending = role === 'program' ? f.player.selectProgram(f.player.programs[1]!.id) : f.player.selectView(f.player.views[1]!.id);
    const original = new Error('cancelled');
    const rejection = expect(pending).rejects.toBe(original);
    await f.player.destroy(); reject(original); await rejection;
    expect(failed).not.toHaveBeenCalled();
  });

  it('ignores mutations to public display metadata and gives the engine an independent selector copy', async () => {
    const f = fixture(), select = vi.spyOn(f.engine, 'selectMedia').mockResolvedValue();
    try {
      const display = f.player.programs[0]!, view = display.views[1]!, id = view.id;
      Reflect.set(display, 'renderGroup', 999); Reflect.set(view, 'altGroup', 999); Reflect.set(view, 'id', 'changed');
      Object.assign(view.levels[0]!.namespace!, { 0: 'changed' }); Reflect.set(view.levels[0]!, 'trackName', 'changed');
      await f.player.selectView(id);
      expect(select).toHaveBeenLastCalledWith({ renderGroup: 0, videoTrack: { name: 'other', namespace: ['other','view'] } }, undefined);
      const sent = select.mock.calls[0]![0];
      Object.assign(sent.videoTrack!.namespace!, { 0: 'engine mutation' });
      await f.player.selectView(id);
      expect(select).toHaveBeenLastCalledWith({ renderGroup: 0, videoTrack: { name: 'other', namespace: ['other','view'] } }, undefined);
      expect(f.player.views[1]!.id).toBe(id); expect(f.player.views[1]!.levels[0]!.namespace).toEqual(['other','view']);
    } finally { await f.player.destroy(); }
  });

  it('does not emit duplicate adoption events for revision-only changes', async () => {
    const f = fixture(), programs = vi.fn(), views = vi.fn();
    try {
      f.player.on('programchange', programs); f.player.on('viewchange', views);
      f.adopt({ ...selected, revision: 2 });
      expect(programs).not.toHaveBeenCalled(); expect(views).not.toHaveBeenCalled();
      const video = { name: 'other', namespaceFields: ['other','view'] };
      f.adopt({ ...selected, revision: 3, video, videoAlternatives: [video] });
      expect(programs).not.toHaveBeenCalled(); expect(views).toHaveBeenCalledOnce();
      expect(views.mock.calls[0]![0].view.id).toBe(f.player.currentView);
    } finally { await f.player.destroy(); }
  });
});
