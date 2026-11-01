import type { MoqtObject, ObjectDatagram } from '@openmoq/transport';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { PlayerConnectionObservation } from './diagnostics.js';
import type { MediaSourceLike, MediaAppendReason, VideoFrameReason, AudioScheduleReason } from './interfaces.js';
import type { DispatcherOutputObserver, DispatcherOutputReason } from './command-dispatcher.js';
import type { PlaybackInputDiscardReason } from '@openmoq/playback';
import type { ObjectRoutingContext, ObjectRoutingProvenance } from './subscription-manager.js';

export type MediaDiscardReason = MediaAppendReason | VideoFrameReason | AudioScheduleReason | DispatcherOutputReason
  | PlaybackInputDiscardReason | Parameters<ObjectRoutingProvenance['discarded']>[1];

/** Local opaque identities only. No media bytes or wire-location inference. */
export interface MediaStageObservation {
  readonly unit: object | null;
  readonly inputs: readonly ObjectRoutingContext[];
  readonly stage: 'reconstructed' | 'appended' | 'decoded' | 'scheduled' | 'presented' | 'discarded';
  readonly reason: MediaDiscardReason | null;
}
export type MediaStageObserver = (event: MediaStageObservation) => void | Promise<void>;
export interface MediaDiagnosticHost {
  readonly currentConnection: MoqtConnection | null;
  /** Replay all currently owned connections synchronously, then report lifecycle changes. */
  observeConnections(listener: (event: PlayerConnectionObservation) => void): () => void;
}
export interface MediaDiagnosticRuntime extends ObjectRoutingProvenance {
  /** Capture the original datagram, before conversion to a routed object. */
  capture(sourceConnection: unknown, input: MoqtObject | ObjectDatagram): ObjectRoutingContext | undefined;
  /** Actual dispatcher output callbacks in this diagnostic runtime lifetime, including unattributed/refused units. */
  readonly decodedVideoCount: number;
  readonly decodedAudioCount: number;
  readonly evidenceLossCount: number;
  /** Contributing inputs not proven in this tracker lifetime; no history is inferred. */
  readonly unattributedInputCount: number;
  /** Appends whose source has no observation capability; not media or evidence loss. */
  readonly unobservableAppendCount: number;
  readonly unobservableVideoCount: number;
  readonly unobservableAudioCount: number;
  readonly refusedReconstructionCount: number;
  readonly refusedVideoCount: number;
  readonly refusedAudioCount: number;
  /** Actual decoder output; an input must belong to this observation lifetime. */
  decoded: DispatcherOutputObserver['decoded'];
  discarded(context: ObjectRoutingContext, reason: MediaDiscardReason): void;
  reconstruct(inputs: readonly (ObjectRoutingContext | undefined)[]): object | undefined;
  bindMediaSource(source: MediaSourceLike | null): void;
  appendToken(unit: object, source: MediaSourceLike): object | undefined;
  discardUnit(unit: object, reason: MediaDiscardReason): void;
  dispose(): void;
}
export type MediaDiagnosticsFactory = (host: MediaDiagnosticHost, emit: MediaStageObserver) => MediaDiagnosticRuntime;
