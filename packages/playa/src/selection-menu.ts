import type { CatalogNamespaceContext, CatalogState, CatalogTrack } from '@openmoq/msf';
import { contextFields, identityKey, namespaceFieldsOf } from '@openmoq/msf';
import type { MediaSelectionSnapshot, TrackIdentity } from '@openmoq/player';
import { mapAudioTracks, mapLevels } from './level-mapper.js';

/** Project committed identities; a missing member never selects another row. */
export function selectionMenu(catalog: CatalogState, selection: MediaSelectionSnapshot, namespace: CatalogNamespaceContext) {
  const tracks = new Map<string, CatalogTrack>();
  for (const track of catalog.tracks) {
    const key = identityKey(namespaceFieldsOf(track) ?? contextFields(namespace), track.name);
    if (tracks.has(key)) throw new Error(`Duplicate catalog track identity: ${key}`);
    tracks.set(key, track);
  }
  const key = (track: TrackIdentity) => identityKey(track.namespaceFields, track.name);
  const find = (track: TrackIdentity | null) => track === null ? undefined : tracks.get(key(track));
  const members = (identities: readonly TrackIdentity[]) => identities
    .map(identity => tracks.get(key(identity))).filter((track): track is CatalogTrack => track !== undefined);
  const levels = mapLevels({ ...catalog, tracks: members(selection.videoAlternatives) }, undefined, namespace);
  const audioTracks = mapAudioTracks({ ...catalog, tracks: members(selection.audioChoices) }, namespace);
  const videoKey = selection.video === null ? undefined : key(selection.video);
  const audioKey = selection.audio === null ? undefined : key(selection.audio);
  return {
    levels, audioTracks,
    currentLevel: videoKey === undefined ? -1 : levels.findIndex(level => level.id === videoKey),
    currentAudioTrack: audioKey === undefined ? -1 : audioTracks.findIndex(track => track.id === audioKey),
    video: find(selection.video), audio: find(selection.audio),
  };
}
