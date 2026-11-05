import { contextFields } from '@openmoq/msf';
import type { CatalogNamespaceContext } from '@openmoq/msf';
import type { MoqtPlayerConfig, SelectionConfig, TrackRefConfig } from './config.js';
import type { ScopeId, SelectionIntent, TrackIdentity } from './catalog-selection.js';

/** Translate configured selectors into catalog intent; disabled outputs ignore their selectors. */
export function selectionIntentFromConfig(config: MoqtPlayerConfig): SelectionIntent | undefined {
  return selectionIntentFromSelectors(config.selection ?? {}, config.namespace, config, config.videoAltGroup);
}

/** Startup and runtime selectors share exact identity and disabled-output rules. */
export function selectionIntentFromSelectors(
  selection: SelectionConfig, namespace: CatalogNamespaceContext,
  disabled: { readonly disableVideo?: boolean; readonly disableAudio?: boolean } = {},
  videoAltGroup?: number,
): SelectionIntent | undefined {
  const altGroup = videoAltGroup ?? selection.videoAltGroup;
  const identity = (reference: TrackRefConfig | undefined): TrackIdentity | undefined => {
    if (reference === undefined) return undefined;
    const namespaceFields = contextFields(reference.namespace ?? namespace);
    if (namespaceFields === undefined) throw new Error('Track selection requires a namespace context');
    return { namespaceFields, name: reference.name };
  };
  const video = disabled.disableVideo ? undefined : identity(selection.videoTrack);
  const audio = disabled.disableAudio ? undefined : identity(selection.audioTrack);
  const scope: ScopeId | undefined = selection?.renderGroup === undefined ? undefined
    : selection.renderGroup === null ? { kind: 'unassigned' }
      : { kind: 'render-group', renderGroup: selection.renderGroup };
  const intent: SelectionIntent = {
    ...(scope !== undefined ? { scope } : {}),
    ...(altGroup !== undefined && !disabled.disableVideo ? { videoAltGroup: altGroup } : {}),
    ...(video !== undefined ? { videoTrack: video } : {}),
    ...(selection?.audioAltGroup !== undefined && !disabled.disableAudio
      ? { audioAltGroup: selection.audioAltGroup } : {}),
    ...(audio !== undefined ? { audioTrack: audio } : {}),
    ...(disabled.disableVideo ? { disableVideo: true } : {}),
    ...(disabled.disableAudio ? { disableAudio: true } : {}),
  };
  return Object.keys(intent).length > 0 ? intent : undefined;
}
