import type { MoqtConnection } from '@openmoq/webtransport';
import type { PlayerEventMap } from './events.js';
import type { PlayerStats } from './stats.js';
import type { PlayerStateValue } from './state.js';

/** Application-side observation handles. Never serialize connection references. */
export interface PlayerDiagnosticConnection {
  readonly connection: MoqtConnection;
  /** Configured destination only; no userinfo, query or fragment. */
  readonly endpoint: { readonly origin: string; readonly path: string } | null;
}
export type PlayerConnectionObservation =
  | ({ readonly kind: 'available' } & PlayerDiagnosticConnection)
  | { readonly kind: 'retired'; readonly connection: MoqtConnection };
export interface PlayerDiagnosticTrack {
  readonly namespace: readonly string[];
  readonly name: string;
  readonly mediaType: string | null;
  readonly codec: string | null;
  readonly packaging: string | null;
}
export interface PlayerDiagnosticSubscription {
  readonly connection: MoqtConnection;
  readonly requestId: bigint;
  /** Null until the player's own validated SUBSCRIBE_OK binding. */
  readonly trackAlias: bigint | null;
  readonly namespace: readonly string[];
  readonly name: string;
  readonly mediaType: string;
}
export interface PlayerDiagnosticSnapshot {
  readonly mediaStages?: { readonly evidenceLossCount: number; readonly unobservableAppendCount: number; readonly unattributedInputCount: number;
    readonly decodedVideoCount?: number | null; readonly decodedAudioCount?: number | null;
    readonly unobservableVideoCount?: number; readonly unobservableAudioCount?: number;
    readonly refusedReconstructionCount?: number; readonly refusedVideoCount?: number; readonly refusedAudioCount?: number;
    readonly inputAdmissionRefusalCount?: number;
  };
  readonly destroyed: boolean;
  readonly state: PlayerStateValue;
  readonly connections: readonly PlayerDiagnosticConnection[];
  readonly tracks: readonly PlayerDiagnosticTrack[];
  readonly subscriptions: readonly PlayerDiagnosticSubscription[];
}
/** Structural app-side interface for separately imported optional tooling. */
export interface PlayerDiagnosticSource {
  readonly state: PlayerStateValue;
  readonly stats: Readonly<PlayerStats>;
  on<K extends keyof PlayerEventMap>(event: K, listener: (event: PlayerEventMap[K]) => void): () => void;
  observeConnections(listener: (event: PlayerConnectionObservation) => void | Promise<void>): () => void;
  readonly mediaStageCapabilities?: readonly ('cmaf-append-stages' | 'loc-video-stages' | 'loc-audio-stages')[];
  observeMediaStages?(listener: import('./media-diagnostic-types.js').MediaStageObserver, options?: { createTracker?: import('./media-diagnostic-types.js').MediaDiagnosticsFactory }): () => void;
  diagnosticSnapshot(): PlayerDiagnosticSnapshot;
}
export interface PlayerDiagnosticFacade {
  /** The same engine for every access; facade and engine represent one source. */
  readonly diagnosticSource: PlayerDiagnosticSource;
}
