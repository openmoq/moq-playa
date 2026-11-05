import { describe, expect, it } from 'vitest';
import type { CatalogSelection, MediaSelectionSnapshot } from '@openmoq/player';
import { programMenu } from './program-menu.js';

const selected: MediaSelectionSnapshot = { revision: 1, scope: { kind: 'render-group', renderGroup: 2 },
  video: { name: 'cam', namespaceFields: ['live/show'] }, audio: null,
  videoAlternatives: [], audioChoices: [], autoQuality: true };

const track = (name: string, index: number, namespaceFields = ['live/show']) => ({
  id: { name, namespaceFields }, mediaType: 'video' as const, catalogIndex: index,
  track: { name, role: 'video' as const, packaging: 'loc' as const, codec: 'avc1.42c028', isLive: true },
});
const model: CatalogSelection = { excluded: [], scopes: [
  { id: { kind: 'render-group', renderGroup: 0 }, video: [
    { id: { kind: 'declared', altGroup: 0 }, tracks: [{ ...track('cam', 0), label: 'Booth' }] },
  ], audio: [] },
  { id: { kind: 'render-group', renderGroup: 2 }, video: [
    { id: { kind: 'declared', altGroup: 0 }, tracks: [{ ...track('cam', 1), label: 'Main' }] },
    { id: { kind: 'singleton' }, tracks: [{ ...track('other', 2), label: 'Tactical' }] },
  ], audio: [] },
  { id: { kind: 'unassigned' }, video: [
    { id: { kind: 'singleton' }, tracks: [track('cam', 3, ['live', 'show'])] },
  ], audio: [] },
] };

describe('program and view menus', () => {
  it('keeps private selectors for group zero and unassigned programs distinct', () => {
    const menu = programMenu(model, selected);
    expect(menu.programSelectors).toBeDefined();
    expect(menu.programSelectors.get(menu.programs[0]!.id)).toEqual({ renderGroup: 0 });
    expect(menu.programSelectors.get(menu.programs[2]!.id)).toEqual({ renderGroup: null });
  });

  it('binds declared views to their program even when alternate group numbers repeat', () => {
    const menu = programMenu(model, selected);
    expect(menu.viewSelectors).toBeDefined();
    const first = menu.programs[0]!, second = menu.programs[1]!;
    expect(menu.viewSelectors.get(first.views[0]!.id)).toEqual({ programId: first.id,
      selection: { renderGroup: 0, videoAltGroup: 0 } });
    expect(menu.viewSelectors.get(second.views[0]!.id)).toEqual({ programId: second.id,
      selection: { renderGroup: 2, videoAltGroup: 0 } });
  });

  it('uses a singleton’s complete tuple identity without inventing an alternate group', () => {
    const menu = programMenu(model, selected);
    expect(menu.viewSelectors).toBeDefined();
    const program = menu.programs[2]!, singleton = program.views[0]!;
    expect(menu.viewSelectors.get(singleton.id)).toEqual({ programId: program.id,
      selection: { renderGroup: null, videoTrack: { name: 'cam', namespace: ['live', 'show'] } } });
  });

  it('keeps display-menu mutation from retargeting a captured view selector', () => {
    const menu = programMenu(model, selected);
    expect(menu.viewSelectors).toBeDefined();
    const program = menu.programs[1]!, singleton = program.views[1]!;
    const captured = menu.viewSelectors.get(singleton.id)!;
    const fields = singleton.levels[0]!.namespace! as string[];
    fields[0] = 'changed';
    expect(captured.selection).toEqual({ renderGroup: 2,
      videoTrack: { name: 'other', namespace: ['live/show'] } });
    expect(model.scopes[1]!.video[1]!.tracks[0]!.id.namespaceFields).toEqual(['live/show']);
  });

  it('keeps declared group zero distinct from unassigned tracks', () => {
    const menu = programMenu(model, null);
    expect(menu.programs.map(program => program.renderGroup)).toEqual([0, 2, null]);
    expect(new Set(menu.programs.map(program => program.id)).size).toBe(3);
    expect(menu.currentProgram).toBeNull();
  });

  it('offers an ungrouped video as its own named view without inventing an altGroup', () => {
    const match = programMenu(model, selected).programs[1]!;
    expect(match.views.map(view => view.label)).toEqual(['Main', 'Tactical']);
    expect(match.views[0]!.altGroup).toBe(0);
    expect(match.views[1]!.altGroup).toBeUndefined();
    expect(match.views[1]!.levels.map(level => level.trackName)).toEqual(['other']);
  });

  it('scopes view identities and finds the adopted view by complete track identity', () => {
    const menu = programMenu(model, selected);
    expect(menu.currentProgram).toBe(menu.programs[1]!.id);
    expect(menu.currentView).toBe(menu.programs[1]!.views[0]!.id);
    expect(menu.programs[0]!.views[0]!.id).not.toBe(menu.programs[1]!.views[0]!.id);
    const missing = programMenu(model, { ...selected, video: { name: 'cam', namespaceFields: ['absent'] } });
    expect(missing.currentView).toBeNull();
  });

  it('keeps unassigned tracks out of every declared program and preserves source fields', () => {
    const menu = programMenu(model, selected);
    expect(menu.programs[0]!.views.flatMap(view => view.levels).map(level => level.namespace)).toEqual([['live/show']]);
    expect(menu.programs[2]!.views[0]!.levels[0]!.namespace).toEqual(['live', 'show']);
    expect(menu.programs[2]!.views[0]!.id).not.toBe(menu.programs[1]!.views[0]!.id);
  });

  it('keeps ids stable across catalog reorder and sorts only the levels within one view', () => {
    const before = programMenu(model, selected);
    const after = programMenu({ ...model, scopes: [...model.scopes].reverse() }, selected);
    expect(after.currentProgram).toBe(before.currentProgram);
    expect(after.currentView).toBe(before.currentView);
    expect(model.scopes[0]!.id).toEqual({ kind: 'render-group', renderGroup: 0 });
  });

  it('copies identity arrays so menu consumers cannot mutate the model', () => {
    const menu = programMenu(model, selected);
    const namespace = menu.programs[0]!.views[0]!.levels[0]!.namespace!;
    expect(namespace).not.toBe(model.scopes[0]!.video[0]!.tracks[0]!.id.namespaceFields);
    expect(namespace).toEqual(['live/show']);
  });
});
