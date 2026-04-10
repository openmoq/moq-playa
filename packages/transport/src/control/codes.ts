/**
 * Control message type codes.
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import { varint } from '../primitives/varint.js';

/**
 * Wire type codes for all MOQT control messages.
 * @see draft-ietf-moq-transport-16 §9
 */
export const MessageType = {
  REQUEST_UPDATE: varint(0x02),
  SUBSCRIBE: varint(0x03),
  SUBSCRIBE_OK: varint(0x04),
  REQUEST_ERROR: varint(0x05),
  PUBLISH_NAMESPACE: varint(0x06),
  REQUEST_OK: varint(0x07),
  NAMESPACE: varint(0x08),
  PUBLISH_NAMESPACE_DONE: varint(0x09),
  UNSUBSCRIBE: varint(0x0a),
  PUBLISH_DONE: varint(0x0b),
  PUBLISH_NAMESPACE_CANCEL: varint(0x0c),
  TRACK_STATUS: varint(0x0d),
  NAMESPACE_DONE: varint(0x0e),
  GOAWAY: varint(0x10),
  SUBSCRIBE_NAMESPACE: varint(0x11),
  MAX_REQUEST_ID: varint(0x15),
  FETCH: varint(0x16),
  FETCH_CANCEL: varint(0x17),
  FETCH_OK: varint(0x18),
  REQUESTS_BLOCKED: varint(0x1a),
  PUBLISH: varint(0x1d),
  PUBLISH_OK: varint(0x1e),
  CLIENT_SETUP: varint(0x20),
  SERVER_SETUP: varint(0x21),
} as const;

export type MessageTypeCode = (typeof MessageType)[keyof typeof MessageType];
