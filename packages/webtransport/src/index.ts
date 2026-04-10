/**
 * @moqt/webtransport — MoQT connection over WebTransport.
 * @module
 */

export { MoqtConnection } from './adapter.js';
export type { TrackSubscription, TrackSubscribeOptions } from './adapter.js';
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
