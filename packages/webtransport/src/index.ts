/**
 * @moqt/webtransport — MoQT connection over WebTransport.
 * @module
 */

export { MoqtConnection } from './adapter.js';
export type { TrackSubscription, TrackSubscribeOptions, IncomingPublish } from './adapter.js';
export type {
  WebTransportLike,
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
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
