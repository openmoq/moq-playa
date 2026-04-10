/**
 * Connection callback wiring — extracted from MoqtPlayer.
 *
 * Pure function that sets connection callbacks by delegating to
 * handler functions provided by the caller.
 *
 * @see draft-ietf-moq-transport-16 §3.2 (Control stream)
 * @see draft-ietf-moq-transport-16 §10.3 (Datagrams)
 * @see draft-ietf-moq-transport-16 §10.4 (Stream lifecycle)
 * @see draft-ietf-moq-transport-16 §10.4.4 (Fetch streams)
 * @see draft-ietf-moq-transport-16 §6.1 (Namespace discovery)
 * @module
 */

import type { ControlMessage, ObjectDatagram, DataStreamHeader, QlogEvent } from '@moqt/transport';
import type { MoqtObject } from '@moqt/transport';
import type { MoqtConnection } from '@moqt/webtransport';

// ─── Types ───────────────────────────────────────────────────────────

/** Callbacks from connection to player — the inversion-of-control boundary. */
export interface ConnectionHandlers {
  onControlMessage: (msg: ControlMessage) => void;
  onClose: (error?: number, reason?: string) => void;
  onError: (error: Error) => void;
  onObject: (streamId: bigint, obj: MoqtObject) => void;
  onStreamClosed: (streamId: bigint, error?: number) => void;
  onDataStream: (streamId: bigint, header: DataStreamHeader) => void;
  onNamespaceMessage: (requestId: bigint, msg: ControlMessage) => void;
  onDatagram: (datagram: ObjectDatagram) => void;
  onQlogEvent?: (event: QlogEvent) => void;
}

// ─── wireConnectionCallbacks ───────────────────────────────────────────

/**
 * Wire connection callbacks to handler functions.
 *
 * This inverts the coupling: instead of the wiring function
 * reaching back into player, the player provides all behavior
 * through the handlers interface.
 *
 * @see draft-ietf-moq-transport-16 §3.2 (Control stream — onMessage)
 * @see draft-ietf-moq-transport-16 §10.2 (Data streams — onObject)
 * @see draft-ietf-moq-transport-16 §10.3 (Datagrams — onDatagram)
 * @see draft-ietf-moq-transport-16 §10.4 (Stream lifecycle — onStreamClosed)
 * @see draft-ietf-moq-transport-16 §10.4.4 (Fetch streams — onDataStream)
 * @see draft-ietf-moq-transport-16 §6.1 (Namespace discovery — onNamespaceMessage)
 */
export function wireConnectionCallbacks(
  conn: MoqtConnection,
  handlers: ConnectionHandlers,
): void {
  conn.onMessage = (msg: ControlMessage) => {
    handlers.onControlMessage(msg);
  };

  conn.onClose = (error?: number, reason?: string) => {
    handlers.onClose(error, reason);
  };

  conn.onError = (error: Error) => {
    handlers.onError(error);
  };

  conn.onObject = (streamId: bigint, obj: MoqtObject) => {
    handlers.onObject(streamId, obj);
  };

  conn.onStreamClosed = (streamId: bigint, error?: number) => {
    handlers.onStreamClosed(streamId, error);
  };

  conn.onDataStream = (streamId: bigint, header: DataStreamHeader) => {
    handlers.onDataStream(streamId, header);
  };

  conn.onNamespaceMessage = (requestId: bigint, msg: ControlMessage) => {
    handlers.onNamespaceMessage(requestId, msg);
  };

  conn.onDatagram = (datagram: ObjectDatagram) => {
    handlers.onDatagram(datagram);
  };

  if (handlers.onQlogEvent) {
    conn.onQlogEvent = handlers.onQlogEvent;
  }
}
