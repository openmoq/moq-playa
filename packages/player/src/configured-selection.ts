import { contextFields } from '@openmoq/msf';
import type { MoqtPlayerConfig, TrackRefConfig } from './config.js';
import type { ScopeId, SelectionIntent, TrackIdentity } from './catalog-selection.js';

/** Translate configured selectors into catalog intent; disabled outputs ignore their selectors. */
export function selectionIntentFromConfig(config: MoqtPlayerConfig): SelectionIntent | undefined {
  const selection = config.selection;
  const altGroup = config.videoAltGroup ?? selection?.videoAltGroup;
  const identity = (reference: TrackRefConfig | undefined): TrackIdentity | undefined => {
    if (reference === undefined) return undefined;
    const namespaceFields = contextFields(reference.namespace ?? config.namespace);
    if (namespaceFields === undefined) throw new Error('Track selection requires a namespace context');
    return { namespaceFields, name: reference.name };
  };
  const video = config.disableVideo ? undefined : identity(selection?.videoTrack);
  const audio = config.disableAudio ? undefined : identity(selection?.audioTrack);
  const scope: ScopeId | undefined = selection?.renderGroup === undefined ? undefined
    : selection.renderGroup === null ? { kind: 'unassigned' }
      : { kind: 'render-group', renderGroup: selection.renderGroup };
  const intent: SelectionIntent = {
    ...(scope !== undefined ? { scope } : {}),
    ...(altGroup !== undefined && !config.disableVideo ? { videoAltGroup: altGroup } : {}),
    ...(video !== undefined ? { videoTrack: video } : {}),
    ...(selection?.audioAltGroup !== undefined && !config.disableAudio
      ? { audioAltGroup: selection.audioAltGroup } : {}),
    ...(audio !== undefined ? { audioTrack: audio } : {}),
    ...(config.disableVideo ? { disableVideo: true } : {}),
    ...(config.disableAudio ? { disableAudio: true } : {}),
  };
  return Object.keys(intent).length > 0 ? intent : undefined;
}
