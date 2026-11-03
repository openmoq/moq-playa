import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogState } from '@openmoq/msf';
import type { AudioSelectionOptions, MediaSelectionSnapshot, MoqtPlayer, PlayerEventMap as EngineEvents, TypedEmitter } from '@openmoq/player';
import { Player } from './player.js';

function element() {
  return { style: {}, hidden: false, muted: false, volume: 1, playsInline: false,
    appendChild: vi.fn(), removeChild: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })), parentNode: null,
    play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: element, hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('HTMLVideoElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const video = { name: 'video', namespaceFields: ['live/show'] };
const english = { name: 'audio', namespaceFields: ['live/show'] };
const spanish = { name: 'audio', namespaceFields: ['live', 'show'] };
const key = (track: typeof english) => JSON.stringify([track.namespaceFields, track.name]);
const catalog = { version: 1, tracks: [
  { name: 'video', role: 'video', codec: 'avc1.42c028', packaging: 'loc', altGroup: 1, renderGroup: 1 },
  { name: 'audio', role: 'audio', codec: 'opus', packaging: 'loc', lang: 'en', altGroup: 3, renderGroup: 1 },
  { name: 'audio', namespace: 'live/show', role: 'audio', codec: 'opus', packaging: 'loc', lang: 'es', altGroup: 3, renderGroup: 1 },
] } as CatalogState;
const selected: MediaSelectionSnapshot = {
  revision: 1, scope: { kind: 'render-group', renderGroup: 1 }, video, audio: english,
  videoAlternatives: [video], audioChoices: [english, spanish], autoQuality: true,
};

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const player = new Player(element() as unknown as HTMLElement, { url: 'https://relay.example/moq', namespace: 'live/show',
    audioActivation: 'gesture', moqtPlayerConfig: { namespace: ['live/show'], audioConstraints: { lang: 'en' } } });
  const engine = (player as unknown as { engine: Pick<MoqtPlayer, 'selectAudioTrack' | 'audioTimelineReference' | 'destroy'>
    & { emitter: TypedEmitter<EngineEvents> } }).engine;
  engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog });
  const adopt = (selection: MediaSelectionSnapshot, context = catalog) => engine.emitter.emit('selection_changed',
    { type: 'selection_changed', selection, catalog: context });
  return { player, engine, adopt };
}

describe('facade adopted audio selection', () => {
  it('discovers programs before acceptance without claiming a current view', async () => {
    const h = fixture();
    try {
      expect(h.player.programs).toHaveLength(1);
      expect(h.player.programs[0]!.renderGroup).toBe(1);
      expect(h.player.currentProgram).toBeNull();
      expect(h.player.views).toEqual([]);
      h.adopt(selected);
      expect(h.player.currentProgram).toBe(h.player.programs[0]!.id);
      expect(h.player.views[0]!.id).toBe(h.player.currentView);
      expect(h.player.programs[0]!.audioTracks.map(track => track.language)).toEqual(['en', 'es']);
    } finally { await h.player.destroy(); }
    expect(h.player.programs).toEqual([]);
    expect(h.player.currentProgram).toBeNull();
    expect(h.player.currentView).toBeNull();
  });

  it('projects the multi-program catalog without borrowing booth or unassigned tracks', async () => {
    const h = fixture();
    const offered: CatalogState = { version: 1, tracks: [
      { name: 'booth-video', role: 'video', renderGroup: 1, codec: 'avc1.42c028', packaging: 'loc', isLive: true, label: 'Booth' },
      { name: 'booth-audio', role: 'audio', renderGroup: 1, codec: 'opus', packaging: 'loc', isLive: true },
      { name: 'main', role: 'video', renderGroup: 2, altGroup: 1, codec: 'avc1.42c028', packaging: 'loc', isLive: true, label: 'Main' },
      { name: 'tactical', role: 'video', renderGroup: 2, altGroup: 2, codec: 'avc1.42c028', packaging: 'loc', isLive: true, label: 'Tactical' },
      { name: 'en', role: 'audio', renderGroup: 2, altGroup: 3, lang: 'en', codec: 'opus', packaging: 'loc', isLive: true },
      { name: 'es', role: 'audio', renderGroup: 2, altGroup: 3, lang: 'es', codec: 'opus', packaging: 'loc', isLive: true },
      { name: 'unassigned', role: 'video', codec: 'avc1.42c028', packaging: 'loc', isLive: true },
    ] };
    const ref = (name: string) => ({ name, namespaceFields: ['live/show'] });
    try {
      h.engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: offered });
      expect(h.player.programs.map(program => program.renderGroup)).toEqual([1, 2, null]);
      expect(h.player.programs[0]!.views[0]!.altGroup).toBeUndefined();
      h.adopt({ ...selected, scope: { kind: 'render-group', renderGroup: 2 }, video: ref('tactical'), audio: ref('es'),
        videoAlternatives: [ref('tactical')], audioChoices: [ref('en'), ref('es')] }, offered);
      expect(h.player.views.map(view => view.label)).toEqual(['Main', 'Tactical']);
      expect(h.player.currentView).toBe(h.player.views[1]!.id);
      expect(h.player.audioTracks.map(track => track.trackName)).toEqual(['en', 'es']);
      expect(h.player.currentAudioTrack).toBe(1);
      expect(h.player.levels.map(level => level.trackName)).toEqual(['tactical']);
    } finally { await h.player.destroy(); }
  });

  it('exposes the engine audio source reference without replacing its identity witness', async () => {
    const h = fixture();
    const token = Object.freeze({});
    const reference = { token, track: english, domain: 'media-time' as const, observedSourceTimeUs: 1_000_000_000n };
    const read = vi.spyOn(h.engine, 'audioTimelineReference', 'get').mockReturnValue(reference);
    expect(h.player.audioTimelineReference).toBe(reference);
    expect(h.player.audioTimelineReference!.token).toBe(token);
    await h.player.destroy();
    read.mockClear();
    expect(h.player.audioTimelineReference).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('reports accepted Spanish and the actual video index instead of startup defaults', async () => {
    const h = fixture();
    try {
      expect(h.player.currentAudioTrack).toBe(-1);
      h.adopt({ ...selected, audio: spanish });
      expect(h.player.currentAudioTrack).toBe(1);
      expect(h.player.currentLevel).toBe(0);
      expect(h.player.audioTracks[1]!.language).toBe('es');
    } finally { await h.player.destroy(); }
  });

  it('keeps the old index pending and captures the target tuple before a menu reorder', async () => {
    const h = fixture(), operation = deferred();
    h.adopt(selected);
    const select = vi.spyOn(h.engine, 'selectAudioTrack').mockReturnValue(operation.promise);
    try {
      expect(h.player.setAudioTrack(1)).toBeUndefined();
      expect(select).toHaveBeenCalledExactlyOnceWith({ name: 'audio', namespace: ['live', 'show'] }, undefined);
      expect(h.player.currentAudioTrack).toBe(0);
      h.adopt({ ...selected, revision: 2, audioChoices: [spanish, english] });
      expect(h.player.currentAudioTrack).toBe(1);
      h.adopt({ ...selected, revision: 3, audio: spanish, audioChoices: [spanish, english] });
      operation.resolve();
      await operation.promise;
      expect(h.player.currentAudioTrack).toBe(0);
      expect(select).toHaveBeenCalledTimes(1);
    } finally { await h.player.destroy(); }
  });

  it('forwards explicit timeline policy without flattening a stable target identity', async () => {
    const h = fixture(); h.adopt(selected);
    const options: AudioSelectionOptions = { timeline: { kind: 'live-resync' } };
    const select = vi.spyOn(h.engine, 'selectAudioTrack').mockImplementation(async () => {
      h.adopt({ ...selected, revision: 2, audio: spanish });
    });
    try {
      await h.player.selectAudioTrack(key(spanish), options);
      expect(select).toHaveBeenCalledExactlyOnceWith({ name: 'audio', namespace: ['live', 'show'] }, options);
      expect(h.player.currentAudioTrack).toBe(1);
    } finally { await h.player.destroy(); }
  });

  it('reports legacy setter failure once and retains the prior selection', async () => {
    const h = fixture(), operation = deferred(); h.adopt(selected);
    vi.spyOn(h.engine, 'selectAudioTrack').mockReturnValue(operation.promise);
    const failed = vi.fn(), errors = vi.fn(), changed = vi.fn();
    h.player.on('audiochangefailed', failed); h.player.on('error', errors); h.player.on('audiochange', changed);
    try {
      h.player.setAudioTrack(1);
      operation.reject(new Error('request refused'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
      expect(failed).toHaveBeenCalledExactlyOnceWith({ trackId: key(spanish), message: 'request refused' });
      expect(changed).not.toHaveBeenCalled();
      expect(h.player.currentAudioTrack).toBe(0);
    } finally { await h.player.destroy(); }
  });

  it('does not publish a late failure after destruction', async () => {
    const h = fixture(), operation = deferred(); h.adopt(selected);
    vi.spyOn(h.engine, 'selectAudioTrack').mockReturnValue(operation.promise);
    const failed = vi.fn(), errors = vi.fn();
    h.player.on('audiochangefailed', failed); h.player.on('error', errors);
    h.player.setAudioTrack(1);
    await h.player.destroy();
    operation.reject(new Error('retired'));
    await operation.promise.catch(() => {});
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
    expect(h.player.currentAudioTrack).toBe(-1);
  });

  it('does not substitute another namesake when the chosen track leaves the catalog', async () => {
    const h = fixture(); h.adopt({ ...selected, audio: spanish });
    try {
      h.engine.emitter.emit('catalog_updated', { type: 'catalog_updated',
        catalog: { ...catalog, tracks: catalog.tracks.filter(track => track.namespace === undefined) } });
      expect(h.player.audioTracks.map(track => track.language)).toEqual(['en']);
      expect(h.player.currentAudioTrack).toBe(-1);
      expect(h.player.activeMediaType).toBe('canvas');
    } finally { await h.player.destroy(); }
  });

  it('uses the adoption catalog atomically before a later catalog update event', async () => {
    const h = fixture(); h.adopt(selected);
    const nextCatalog = { ...catalog, tracks: catalog.tracks.map(track => ({ ...track, namespace: 'replacement',
      name: track.role === 'video' ? 'new-video' : track.lang === 'en' ? 'new-en' : 'new-es' })) };
    const v = { name: 'new-video', namespaceFields: ['replacement'] };
    const en = { name: 'new-en', namespaceFields: ['replacement'] };
    const es = { name: 'new-es', namespaceFields: ['replacement'] };
    try {
      h.adopt({ ...selected, revision: 2, video: v, audio: es, videoAlternatives: [v], audioChoices: [en, es] }, nextCatalog);
      expect(h.player.currentAudioTrack).toBe(1);
      expect(h.player.audioTracks[1]!.id).toBe(key(es));
      expect(h.player.levels[0]!.trackName).toBe('new-video');
    } finally { await h.player.destroy(); }
  });

  it('keeps the preview video surface when audio acceptance precedes video', async () => {
    const h = fixture();
    try {
      const mixed = { ...catalog, tracks: catalog.tracks.map(track => track.role === 'audio'
        ? { ...track, packaging: 'cmaf' as const, codec: 'mp4a.40.2' } : track) };
      expect(h.player.activeMediaType).toBe('canvas');
      h.adopt({ ...selected, video: null }, mixed);
      expect(h.player.activeMediaType).toBe('canvas');
      expect(h.player.currentLevel).toBe(-1);
    } finally { await h.player.destroy(); }
  });

  it('prepares the accepted audio output independently of a pending MSE video', async () => {
    const h = fixture();
    let contexts = 0;
    vi.stubGlobal('AudioContext', class {
      state = 'running'; currentTime = 0; outputLatency = 0; destination = { maxChannelCount: 2 };
      constructor() { contexts++; }
      async resume() {}
      async close() { this.state = 'closed'; }
      getOutputTimestamp() { return { contextTime: 0, performanceTime: 0 }; }
      createGain() { return { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }; }
    });
    const mse = { ...catalog, tracks: catalog.tracks.map(track => ({ ...track, packaging: 'cmaf' as const,
      codec: track.role === 'video' ? 'avc1.42c028' : 'mp4a.40.2' })) };
    try {
      h.engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: mse });
      expect(h.player.activeMediaType).toBe('video');
      const accepted = { ...mse, tracks: mse.tracks.map(track => track.role === 'audio'
        ? { ...track, packaging: 'loc' as const, codec: 'opus' } : track) };
      h.adopt({ ...selected, video: null }, accepted);
      expect(h.player.activeMediaType).toBe('video');
      await h.player.prepareAudio();
      expect(contexts).toBe(1);
    } finally { await h.player.destroy(); }
  });
});
