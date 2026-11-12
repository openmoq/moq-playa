/**
 * @openmoq/webtransport — MoQT connection adapter and WebTransport binding.
 * @module
 */

export { MoqtConnection } from './adapter.js';
export type { ObjectReceipt, ObjectReceiptObservation, ObjectReceiptDiscard } from './object-receipts.js';
export { OBSERVED_PROPERTIES_LIMIT } from './object-reception.js';
export type {
  ObjectReception,
  ObjectReceptionEvent,
  ObjectReceptionHeader,
  ObjectReceptionProgress,
  ObjectReceptionEnd,
  ObjectReceptionDatagram,
  ObjectReceptionOrigin,
  ObjectReceptionInterruption,
  ObjectReceptionPropertiesOmission,
  ObjectReceptionOptions,
} from './object-reception.js';
export type { TrackSubscription, TrackSubscribeOptions, IncomingPublish, ConnectOptions, MalformedPublicationTerminationResult, MalformedSourceCancellationResult } from './adapter.js';
export { catToken, AuthorizationError } from './authorization.js';
export type { AuthorizationToken, AuthorizationContext, AuthorizationOperation, AuthorizationProvider, ConnectionAuthorization } from './authorization.js';
export type { DataStreamTerminal, GoawayNotice } from './adapter.js';
export type {
  WebTransportLike,
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
  MoqtSetupRouting,
} from './types.js';
export { MoqtConnectionError } from './adapter-error.js';
export type { MoqtConnectionErrorSource, MoqtConnectionErrorOptions } from './adapter-error.js';

/** @experimental Advanced API — may change between minor versions. */
export { ControlStreamFramer } from './framer.js';
/** @experimental Advanced API — may change between minor versions. */
export type { FramedMessage } from './framer.js';

/** @experimental Stream topology seam — draft-14/16 single-bidi control stream. */
export { createBidiControlTopology } from './topology/bidi-control.js';
/** @experimental */
export type { BidiControlTopology } from './topology/bidi-control.js';

/** @experimental draft-18 uni control-stream pair topology (handshake skeleton). */
export { createUniPairTopology, UniPairTopology } from './topology/uni-pair.js';
/** @experimental */
export type { RequestStream } from './topology/uni-pair.js';

export type { FetchReceiver, FetchReceiveContext } from './fetch-receiver.js';

export { RequestUpdateFailure, RequestUpdateError } from './request-update-confirmation.js';
