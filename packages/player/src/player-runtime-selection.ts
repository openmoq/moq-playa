import type { CatalogNamespaceContext, CatalogState } from '@openmoq/msf';
import type { ClockSource } from '@openmoq/playback';
import type { SelectionConfig } from './config.js';
import { sameScope, type SelectionIntent } from './catalog-selection.js';
import { selectionIntentFromSelectors } from './configured-selection.js';
import type { MediaSelectionSnapshot } from './player-selection-state.js';
import { QualityController, type QualityControllerConfig } from './quality-controller.js';
import { composeSelection, type ComposedSelection, type CompositionOptions } from './selection-composition.js';

interface RuntimeSelectionOptions extends CompositionOptions {
  readonly selection: SelectionConfig;
  readonly current: MediaSelectionSnapshot;
  readonly catalogNamespace: CatalogNamespaceContext;
  readonly disableVideo?: boolean;
  readonly disableAudio?: boolean;
  readonly quality: Omit<QualityControllerConfig, 'autoQuality' | 'clock'>;
  readonly clock: ClockSource;
}

export type RuntimeSelection =
  | { readonly ok: true; readonly selected: Extract<ComposedSelection, { ok: true }>;
      readonly controller: QualityController; readonly scopeChanged: boolean }
  | { readonly ok: false; readonly reason: string };

/** Prepare policy in a candidate-owned controller; never mutate the live choice. */
export function prepareRuntimeSelection(catalog: CatalogState, options: RuntimeSelectionOptions): RuntimeSelection {
  if (options.current.scope === null) return { ok: false, reason: 'No presentation has been adopted' };
  const configured = selectionIntentFromSelectors(options.selection, options.catalogNamespace, options) ?? {};
  const scope = configured.scope ?? options.current.scope;
  const scopeChanged = !sameScope(scope, options.current.scope);
  const videoSpecified = !options.disableVideo
    && (configured.videoTrack !== undefined || configured.videoAltGroup !== undefined);
  const audioSpecified = !options.disableAudio
    && (configured.audioTrack !== undefined || configured.audioAltGroup !== undefined);
  const keepVideo = !scopeChanged && !videoSpecified && !options.disableVideo;
  const keepAudio = !scopeChanged && !audioSpecified && !options.disableAudio;
  const intent: SelectionIntent = {
    ...configured, scope,
    ...(keepVideo ? options.current.video === null ? { disableVideo: true }
      : { videoTrack: options.current.video } : {}),
    ...(keepAudio ? options.current.audio === null ? { disableAudio: true }
      : { audioTrack: options.current.audio } : {}),
  };
  const controller = new QualityController({ ...options.quality, autoQuality: options.current.autoQuality, clock: options.clock });
  const selected = composeSelection(catalog, { catalogNamespace: options.catalogNamespace, intent, controller,
    ...(options.videoConstraints !== undefined ? { videoConstraints: options.videoConstraints } : {}),
    ...(options.audioConstraints !== undefined ? { audioConstraints: options.audioConstraints } : {}),
    ...(options.audioLanguages !== undefined ? { audioLanguages: options.audioLanguages } : {}) });
  if (!selected.ok) return selected;
  for (const role of ['video', 'audio'] as const) {
    const outcome = selected[role];
    if (outcome.state === 'excluded' || outcome.state === 'unsatisfied') {
      return { ok: false, reason: `${role} is declared but no eligible track satisfies the selection` };
    }
  }
  if (selected.video.state !== 'selected' && selected.audio.state !== 'selected') {
    return { ok: false, reason: 'The target has no enabled playable media' };
  }
  // Retaining an automatic member is continuity, not an explicit manual pin.
  const manualVideo = !options.disableVideo && configured.videoTrack !== undefined;
  if (options.current.autoQuality && !manualVideo) controller.unlockAuto();
  return { ok: true, selected: { ...selected, manualVideo }, controller, scopeChanged };
}
