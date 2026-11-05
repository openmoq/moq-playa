import { identityKey } from '@openmoq/msf';
import type { CatalogSelection, MediaSelectionSnapshot, SelectableTrack, SelectionConfig } from '@openmoq/player';
import type { Program } from './types.js';
import { mapAudioTracks, mapLevels } from './level-mapper.js';

/** Presentation of the model's scopes and sets; no new grouping or eligibility policy. */
export function programMenu(model: CatalogSelection, selection: MediaSelectionSnapshot | null): {
  programs: readonly Program[]; currentProgram: string | null; currentView: string | null;
  programSelectors: ReadonlyMap<string, SelectionConfig>;
  viewSelectors: ReadonlyMap<string, { readonly programId: string; readonly selection: SelectionConfig }>;
} {
  let currentProgram: string | null = null;
  let currentView: string | null = null;
  const programSelectors = new Map<string, SelectionConfig>();
  const viewSelectors = new Map<string, { readonly programId: string; readonly selection: SelectionConfig }>();
  // Injected catalogs need not carry parser provenance. Menus use the model's
  // resolved identity, never re-split display text or rediscover by bare name.
  const project = (member: SelectableTrack) => ({ ...member.track,
    resolvedNamespace: { fields: [...member.id.namespaceFields], source: member.track.resolvedNamespace?.source ?? 'inherited' as const },
  });
  const programs = model.scopes.map(scope => {
    const scopeParts = scope.id.kind === 'render-group' ? ['render-group', scope.id.renderGroup] : ['unassigned'];
    const id = JSON.stringify(scopeParts);
    const renderGroup = scope.id.kind === 'render-group' ? scope.id.renderGroup : null;
    programSelectors.set(id, Object.freeze({ renderGroup }));
    const selectedScope = selection?.scope !== null && selection?.scope !== undefined
      && selection.scope.kind === scope.id.kind
      && (selection.scope.kind !== 'render-group' || scope.id.kind !== 'render-group'
        || selection.scope.renderGroup === scope.id.renderGroup);
    if (selectedScope) currentProgram = id;
    const views = scope.video.map(set => {
      const singleton = set.id.kind === 'singleton' ? set.tracks[0] : undefined;
      if (set.id.kind === 'singleton' && singleton === undefined) throw new Error('A singleton view must contain a track');
      const viewId = JSON.stringify([scopeParts, set.id.kind, set.id.kind === 'declared' ? set.id.altGroup
        : identityKey(singleton!.id.namespaceFields, singleton!.id.name)]);
      const selector: SelectionConfig = Object.freeze({ renderGroup,
        ...(set.id.kind === 'declared' ? { videoAltGroup: set.id.altGroup } : {
          videoTrack: Object.freeze({ name: singleton!.id.name, namespace: Object.freeze([...singleton!.id.namespaceFields]) }),
        }),
      });
      viewSelectors.set(viewId, Object.freeze({ programId: id, selection: selector }));
      if (selectedScope && selection?.video && set.tracks.some(member =>
        identityKey(member.id.namespaceFields, member.id.name) === identityKey(selection.video!.namespaceFields, selection.video!.name))) {
        currentView = viewId;
      }
      return {
        id: viewId,
        label: set.tracks.find(member => member.label !== undefined)?.label
          ?? (set.id.kind === 'declared' ? `View ${set.id.altGroup}` : singleton!.id.name),
        ...(set.id.kind === 'declared' ? { altGroup: set.id.altGroup } : {}),
        levels: mapLevels({ version: 1, tracks: set.tracks.map(project) }),
      };
    });
    const audio = scope.audio.flatMap(set => set.tracks).sort((a, b) => a.catalogIndex - b.catalogIndex);
    return {
      id, label: scope.id.kind === 'render-group' ? `Program ${scope.id.renderGroup}` : 'Unassigned',
      renderGroup,
      views, audioTracks: mapAudioTracks({ version: 1, tracks: audio.map(project) }),
    };
  });
  return { programs, currentProgram, currentView, programSelectors, viewSelectors };
}
