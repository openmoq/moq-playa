import type { MoqtObject, TrackPropertyValue } from '@openmoq/transport';
import type { DataStreamTerminal } from '@openmoq/webtransport';
import type { SeekFetchCut } from './seek-fetch-pages.js';

export interface SeekTrack {
  readonly role: 'video' | 'audio';
  readonly name: string;
  readonly namespace: readonly string[];
  readonly sourceKey: string;
  readonly codec: string;
  readonly init: Uint8Array;
  readonly packaging: 'cmaf' | 'locmaf';
}

export interface SeekInputReceiver {
  onObject(object: MoqtObject, input?: object): Promise<void>;
  onClosed(terminal: DataStreamTerminal): void;
}

export interface SeekLiveInput {
  onObject(object: MoqtObject, input?: object, stillAdmitted?: () => boolean): Promise<void>;
  /** The engine has established genuine track completion, not a group FIN. */
  endTrack(): Promise<void>;
  cancel(): void;
}

export interface SeekGroupPageAcceptance {
  readonly start: { readonly groupId: bigint; readonly objectId: bigint };
  readonly through: SeekFetchCut;
  readonly endOfTrack: boolean;
  readonly groupOrder: 'ascending';
  readonly rangeFilters: false;
  /** Request-local defaults from FETCH_OK, or the accepted SUBSCRIBE_OK for initial FILL. */
  readonly trackProperties?: ReadonlyMap<bigint, readonly TrackPropertyValue[]>;
}
