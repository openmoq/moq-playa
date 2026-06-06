/**
 * Control message encoder.
 * Serializes ControlMessage → Uint8Array with framing.
 *
 * Wire format: Type (varint) + Length (uint16) + Payload
 *
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import type { ControlMessage, Parameters, TrackExtensions } from './messages.js';
import { MessageType } from './codes.js';
import { varint, writeVarint, varintEncodingLength, type Varint } from '../primitives/varint.js';
import {
  writeLengthPrefixedBytes,
  lengthPrefixedBytesEncodingLength,
  writeTuple,
  tupleEncodingLength,
  validateTrackNamespace,
  validateTrackNamespacePrefix,
  validateTrackNamespaceSuffix,
  validateFullTrackName,
} from '../primitives/bytes.js';
import { writeKvpList, kvpListEncodingLength, kvpListEntryCount, type KvpValue } from '../primitives/kvp.js';
import { toKvpParams } from './kvp-params.js';
import { MessageParam } from './parameters.js';
import { writeLocation, locationEncodingLength } from '../primitives/location.js';
import { writeReasonPhrase, reasonPhraseEncodingLength } from '../primitives/reason.js';

/**
 * Known message parameter types that must be unique (all except AUTHORIZATION_TOKEN).
 * @see draft-ietf-moq-transport-16 §9.2.2
 */
const UNIQUE_MESSAGE_PARAMS = new Set<bigint>([
  MessageParam.DELIVERY_TIMEOUT as bigint,
  MessageParam.EXPIRES as bigint,
  MessageParam.LARGEST_OBJECT as bigint,
  MessageParam.FORWARD as bigint,
  MessageParam.SUBSCRIBER_PRIORITY as bigint,
  MessageParam.SUBSCRIPTION_FILTER as bigint,
  MessageParam.GROUP_ORDER as bigint,
  MessageParam.NEW_GROUP_REQUEST as bigint,
]);

/** Human-readable names for message parameters (for error messages). */
const MESSAGE_PARAM_NAMES = new Map<bigint, string>([
  [MessageParam.DELIVERY_TIMEOUT as bigint, 'DELIVERY_TIMEOUT'],
  [MessageParam.EXPIRES as bigint, 'EXPIRES'],
  [MessageParam.LARGEST_OBJECT as bigint, 'LARGEST_OBJECT'],
  [MessageParam.FORWARD as bigint, 'FORWARD'],
  [MessageParam.SUBSCRIBER_PRIORITY as bigint, 'SUBSCRIBER_PRIORITY'],
  [MessageParam.SUBSCRIPTION_FILTER as bigint, 'SUBSCRIPTION_FILTER'],
  [MessageParam.GROUP_ORDER as bigint, 'GROUP_ORDER'],
  [MessageParam.NEW_GROUP_REQUEST as bigint, 'NEW_GROUP_REQUEST'],
]);

/**
 * Validate message parameters for sender-side duplicate constraints.
 * §9.2.2.1: AUTHORIZATION_TOKEN may appear multiple times.
 * All other known message parameters must be unique.
 * @throws {Error} If a parameter that must be unique appears multiple times
 */
function validateMessageParams(params: Parameters): void {
  for (const [key, values] of params) {
    if (UNIQUE_MESSAGE_PARAMS.has(key as bigint) && values.length > 1) {
      const name = MESSAGE_PARAM_NAMES.get(key as bigint) ?? `0x${(key as bigint).toString(16)}`;
      throw new Error(`Duplicate message parameter: ${name} may not appear multiple times`);
    }
  }
}

/**
 * Check if a message has message parameters (vs setup parameters).
 * Setup params are validated in the session layer with different rules.
 */
function hasMessageParams(msg: ControlMessage): msg is ControlMessage & { parameters: Parameters } {
  return msg.type !== 'CLIENT_SETUP' && msg.type !== 'SERVER_SETUP' && 'parameters' in msg;
}

/**
 * Validate namespace fields in a message before encoding.
 * @throws {Error} If any namespace constraint is violated per §2.4.1
 */
function validateMessageNamespaces(msg: ControlMessage): void {
  switch (msg.type) {
    case 'SUBSCRIBE':
    case 'TRACK_STATUS':
    case 'PUBLISH':
      validateFullTrackName(msg.trackNamespace, msg.trackName);
      break;

    case 'FETCH':
      if (msg.fetch.fetchType === 0x1) {
        validateFullTrackName(msg.fetch.trackNamespace, msg.fetch.trackName);
      }
      break;

    case 'PUBLISH_NAMESPACE':
      validateTrackNamespace(msg.trackNamespace);
      break;

    case 'NAMESPACE':
    case 'NAMESPACE_DONE':
      // Validate suffix: ≤32 fields, each ≥1 byte, total ≤4096 bytes
      validateTrackNamespaceSuffix(msg.trackNamespaceSuffix);
      break;

    case 'SUBSCRIBE_NAMESPACE':
      validateTrackNamespacePrefix(msg.trackNamespacePrefix);
      break;

    // Messages without namespaces - no validation needed
    default:
      break;
  }
}

/**
 * Encode a control message to its wire representation.
 * Returns a complete framed message (type + length + payload).
 */
export function encodeControlMessage(msg: ControlMessage): Uint8Array {
  // Validate namespace constraints before encoding
  validateMessageNamespaces(msg);

  // Validate message params for duplicates (setup params handled by session layer)
  if (hasMessageParams(msg)) {
    validateMessageParams(msg.parameters);
  }

  const typeCode = messageTypeCode(msg.type);
  const payloadLen = payloadLength(msg);
  if (payloadLen > 0xffff) {
    throw new RangeError(
      `Control message payload length ${payloadLen} exceeds maximum 65535 (uint16)`,
    );
  }
  const typeLen = varintEncodingLength(typeCode);
  const totalLen = typeLen + 2 + payloadLen; // type + uint16 length + payload

  const buf = new Uint8Array(totalLen);
  let pos = 0;

  // Type (varint)
  pos += writeVarint(typeCode, buf, pos);

  // Length (uint16 big-endian)
  buf[pos++] = (payloadLen >> 8) & 0xff;
  buf[pos++] = payloadLen & 0xff;

  // Payload
  pos += writePayload(msg, buf, pos);

  return buf;
}

function messageTypeCode(type: ControlMessage['type']): Varint {
  switch (type) {
    case 'CLIENT_SETUP': return MessageType.CLIENT_SETUP;
    case 'SERVER_SETUP': return MessageType.SERVER_SETUP;
    case 'SETUP':
      throw new Error('SETUP is a draft-18 message; the draft-14/16 codec uses CLIENT_SETUP/SERVER_SETUP');
    case 'GOAWAY': return MessageType.GOAWAY;
    case 'MAX_REQUEST_ID': return MessageType.MAX_REQUEST_ID;
    case 'REQUESTS_BLOCKED': return MessageType.REQUESTS_BLOCKED;
    case 'REQUEST_OK': return MessageType.REQUEST_OK;
    case 'REQUEST_ERROR': return MessageType.REQUEST_ERROR;
    case 'SUBSCRIBE': return MessageType.SUBSCRIBE;
    case 'SUBSCRIBE_OK': return MessageType.SUBSCRIBE_OK;
    case 'REQUEST_UPDATE': return MessageType.REQUEST_UPDATE;
    case 'UNSUBSCRIBE': return MessageType.UNSUBSCRIBE;
    case 'PUBLISH': return MessageType.PUBLISH;
    case 'PUBLISH_OK': return MessageType.PUBLISH_OK;
    case 'PUBLISH_DONE': return MessageType.PUBLISH_DONE;
    case 'FETCH': return MessageType.FETCH;
    case 'FETCH_OK': return MessageType.FETCH_OK;
    case 'FETCH_CANCEL': return MessageType.FETCH_CANCEL;
    case 'TRACK_STATUS': return MessageType.TRACK_STATUS;
    case 'PUBLISH_NAMESPACE': return MessageType.PUBLISH_NAMESPACE;
    case 'NAMESPACE': return MessageType.NAMESPACE;
    case 'PUBLISH_NAMESPACE_DONE': return MessageType.PUBLISH_NAMESPACE_DONE;
    case 'NAMESPACE_DONE': return MessageType.NAMESPACE_DONE;
    case 'PUBLISH_NAMESPACE_CANCEL': return MessageType.PUBLISH_NAMESPACE_CANCEL;
    case 'SUBSCRIBE_NAMESPACE': return MessageType.SUBSCRIBE_NAMESPACE;
    // Draft-14-only types — not valid in draft-16 encoder
    case 'UNSUBSCRIBE_NAMESPACE':
    case 'PUBLISH_NAMESPACE_OK':
    case 'PUBLISH_NAMESPACE_ERROR':
    case 'PUBLISH_ERROR':
      throw new Error(`Cannot encode draft-14-only message type "${type}" with draft-16 encoder`);
    // Draft-18-only types — not valid in the draft-14/16 encoder
    case 'SUBSCRIBE_TRACKS':
    case 'PUBLISH_BLOCKED':
      throw new Error(`Cannot encode draft-18-only message type "${type}" with draft-16 encoder`);
  }
}

/** Calculate parameters encoding length: varint(count) + KVP data. */
function paramsLength(params: Parameters): number {
  const kvp = toKvpParams(params);
  const count = kvpListEntryCount(kvp);
  return varintEncodingLength(varint(count)) + kvpListEncodingLength(kvp);
}

/** Write parameters: varint(count) + KVP data. Returns bytes written. */
function writeParams(params: Parameters, buf: Uint8Array, offset: number): number {
  let pos = offset;
  const kvp = toKvpParams(params);
  const count = kvpListEntryCount(kvp);
  pos += writeVarint(varint(count), buf, pos);
  pos += writeKvpList(kvp, buf, pos);
  return pos - offset;
}

// draft-14/16 Track Extensions are QUIC-range KVP; the shared TrackProperties type
// is now vi64-wide (full uint64), so cast at this draft-16 boundary — the KVP
// writer still range-validates each value via writeVarint().
const asKvp = (ext: TrackExtensions): Map<bigint, KvpValue[]> => ext as unknown as Map<bigint, KvpValue[]>;

/** Calculate track extensions encoding length. Extensions consume remaining bytes, no count prefix. */
function extensionsLength(ext: TrackExtensions): number {
  if (ext.size === 0) return 0;
  // Extensions are written as KVP entries without a count prefix
  return kvpListEncodingLength(asKvp(ext));
}

/** Write track extensions (no count prefix). */
function writeExtensions(ext: TrackExtensions, buf: Uint8Array, offset: number): number {
  if (ext.size === 0) return 0;
  return writeKvpList(asKvp(ext), buf, offset);
}

/** Track name: varint length + bytes. */
function trackNameLength(name: Uint8Array): number {
  return lengthPrefixedBytesEncodingLength(name);
}

function writeTrackName(name: Uint8Array, buf: Uint8Array, offset: number): number {
  return writeLengthPrefixedBytes(name, buf, offset);
}

function payloadLength(msg: ControlMessage): number {
  switch (msg.type) {
    case 'CLIENT_SETUP':
    case 'SERVER_SETUP':
      return paramsLength(msg.parameters);

    case 'SETUP':
      throw new Error('SETUP is a draft-18 message; not supported by the draft-14/16 codec');

    case 'GOAWAY': {
      const encoded = new TextEncoder().encode(msg.newSessionUri);
      if (encoded.length > 8192) {
        throw new RangeError(
          `GOAWAY URI length ${encoded.length} exceeds maximum 8192 bytes`,
        );
      }
      return varintEncodingLength(varint(encoded.length)) + encoded.length;
    }

    case 'MAX_REQUEST_ID':
      return varintEncodingLength(msg.maxRequestId);

    case 'REQUESTS_BLOCKED':
      return varintEncodingLength(msg.maximumRequestId);

    case 'REQUEST_OK':
      return varintEncodingLength(msg.requestId) + paramsLength(msg.parameters);

    case 'REQUEST_ERROR':
      return (
        varintEncodingLength(msg.requestId) +
        varintEncodingLength(msg.errorCode) +
        varintEncodingLength(msg.retryInterval) +
        reasonPhraseEncodingLength(msg.errorReason)
      );

    case 'SUBSCRIBE':
    case 'TRACK_STATUS':
      return (
        varintEncodingLength(msg.requestId) +
        tupleEncodingLength(msg.trackNamespace) +
        trackNameLength(msg.trackName) +
        paramsLength(msg.parameters)
      );

    case 'SUBSCRIBE_OK':
      return (
        varintEncodingLength(msg.requestId) +
        varintEncodingLength(msg.trackAlias) +
        paramsLength(msg.parameters) +
        extensionsLength(msg.trackProperties ?? msg.trackExtensions ?? new Map())
      );

    case 'REQUEST_UPDATE':
      return (
        varintEncodingLength(msg.requestId) +
        varintEncodingLength(msg.existingRequestId) +
        paramsLength(msg.parameters)
      );

    case 'UNSUBSCRIBE':
      return varintEncodingLength(msg.requestId);

    case 'PUBLISH':
      return (
        varintEncodingLength(msg.requestId) +
        tupleEncodingLength(msg.trackNamespace) +
        trackNameLength(msg.trackName) +
        varintEncodingLength(msg.trackAlias) +
        paramsLength(msg.parameters) +
        extensionsLength(msg.trackProperties ?? msg.trackExtensions ?? new Map())
      );

    case 'PUBLISH_OK':
      return (
        varintEncodingLength(msg.requestId) +
        paramsLength(msg.parameters)
      );

    case 'PUBLISH_DONE':
      return (
        varintEncodingLength(msg.requestId) +
        varintEncodingLength(msg.statusCode) +
        varintEncodingLength(msg.streamCount) +
        reasonPhraseEncodingLength(msg.errorReason)
      );

    case 'FETCH': {
      let len = varintEncodingLength(msg.requestId) + varintEncodingLength(varint(msg.fetch.fetchType));
      if (msg.fetch.fetchType === 0x1) {
        len +=
          tupleEncodingLength(msg.fetch.trackNamespace) +
          trackNameLength(msg.fetch.trackName) +
          locationEncodingLength(msg.fetch.startLocation) +
          locationEncodingLength(msg.fetch.endLocation);
      } else {
        len +=
          varintEncodingLength(msg.fetch.joiningRequestId) +
          varintEncodingLength(msg.fetch.joiningStart);
      }
      len += paramsLength(msg.parameters);
      return len;
    }

    case 'FETCH_OK':
      return (
        varintEncodingLength(msg.requestId) +
        1 + // End Of Track (uint8)
        locationEncodingLength(msg.endLocation) +
        paramsLength(msg.parameters) +
        extensionsLength(msg.trackProperties ?? msg.trackExtensions ?? new Map())
      );

    case 'FETCH_CANCEL':
      return varintEncodingLength(msg.requestId);

    case 'PUBLISH_NAMESPACE':
      return (
        varintEncodingLength(msg.requestId) +
        tupleEncodingLength(msg.trackNamespace) +
        paramsLength(msg.parameters)
      );

    case 'NAMESPACE':
      return tupleEncodingLength(msg.trackNamespaceSuffix);

    case 'PUBLISH_NAMESPACE_DONE':
      return varintEncodingLength(msg.requestId!);

    case 'NAMESPACE_DONE':
      return tupleEncodingLength(msg.trackNamespaceSuffix);

    case 'PUBLISH_NAMESPACE_CANCEL':
      return (
        varintEncodingLength(msg.requestId!) +
        varintEncodingLength(msg.errorCode) +
        reasonPhraseEncodingLength(msg.errorReason)
      );

    case 'SUBSCRIBE_NAMESPACE':
      return (
        varintEncodingLength(msg.requestId) +
        tupleEncodingLength(msg.trackNamespacePrefix) +
        varintEncodingLength(msg.subscribeOptions!) +
        paramsLength(msg.parameters)
      );

    // Draft-14-only types — unreachable (messageTypeCode throws first)
    case 'UNSUBSCRIBE_NAMESPACE':
    case 'PUBLISH_NAMESPACE_OK':
    case 'PUBLISH_NAMESPACE_ERROR':
    case 'PUBLISH_ERROR':
      throw new Error(`Cannot encode draft-14-only message type "${msg.type}" with draft-16 encoder`);
    // Draft-18-only types — unreachable (messageTypeCode throws first)
    case 'SUBSCRIBE_TRACKS':
    case 'PUBLISH_BLOCKED':
      throw new Error(`Cannot encode draft-18-only message type "${msg.type}" with draft-16 encoder`);
  }
}

function writePayload(msg: ControlMessage, buf: Uint8Array, offset: number): number {
  let pos = offset;

  switch (msg.type) {
    case 'CLIENT_SETUP':
    case 'SERVER_SETUP':
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'GOAWAY': {
      const encoded = new TextEncoder().encode(msg.newSessionUri);
      pos += writeVarint(varint(encoded.length), buf, pos);
      buf.set(encoded, pos);
      pos += encoded.length;
      break;
    }

    case 'MAX_REQUEST_ID':
      pos += writeVarint(msg.maxRequestId, buf, pos);
      break;

    case 'REQUESTS_BLOCKED':
      pos += writeVarint(msg.maximumRequestId, buf, pos);
      break;

    case 'REQUEST_OK':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'REQUEST_ERROR':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeVarint(msg.errorCode, buf, pos);
      pos += writeVarint(msg.retryInterval, buf, pos);
      pos += writeReasonPhrase(msg.errorReason, buf, pos);
      break;

    case 'SUBSCRIBE':
    case 'TRACK_STATUS':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeTuple(msg.trackNamespace, buf, pos);
      pos += writeTrackName(msg.trackName, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'SUBSCRIBE_OK':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeVarint(msg.trackAlias, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      pos += writeExtensions(msg.trackProperties ?? msg.trackExtensions ?? new Map(), buf, pos);
      break;

    case 'REQUEST_UPDATE':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeVarint(msg.existingRequestId, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'UNSUBSCRIBE':
      pos += writeVarint(msg.requestId, buf, pos);
      break;

    case 'PUBLISH':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeTuple(msg.trackNamespace, buf, pos);
      pos += writeTrackName(msg.trackName, buf, pos);
      pos += writeVarint(msg.trackAlias, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      pos += writeExtensions(msg.trackProperties ?? msg.trackExtensions ?? new Map(), buf, pos);
      break;

    case 'PUBLISH_OK':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'PUBLISH_DONE':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeVarint(msg.statusCode, buf, pos);
      pos += writeVarint(msg.streamCount, buf, pos);
      pos += writeReasonPhrase(msg.errorReason, buf, pos);
      break;

    case 'FETCH':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeVarint(varint(msg.fetch.fetchType), buf, pos);
      if (msg.fetch.fetchType === 0x1) {
        pos += writeTuple(msg.fetch.trackNamespace, buf, pos);
        pos += writeTrackName(msg.fetch.trackName, buf, pos);
        pos += writeLocation(msg.fetch.startLocation, buf, pos);
        pos += writeLocation(msg.fetch.endLocation, buf, pos);
      } else {
        pos += writeVarint(msg.fetch.joiningRequestId, buf, pos);
        pos += writeVarint(msg.fetch.joiningStart, buf, pos);
      }
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'FETCH_OK':
      pos += writeVarint(msg.requestId, buf, pos);
      buf[pos++] = msg.endOfTrack & 0xff;
      pos += writeLocation(msg.endLocation, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      pos += writeExtensions(msg.trackProperties ?? msg.trackExtensions ?? new Map(), buf, pos);
      break;

    case 'FETCH_CANCEL':
      pos += writeVarint(msg.requestId, buf, pos);
      break;

    case 'PUBLISH_NAMESPACE':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeTuple(msg.trackNamespace, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      break;

    case 'NAMESPACE':
      pos += writeTuple(msg.trackNamespaceSuffix, buf, pos);
      break;

    case 'PUBLISH_NAMESPACE_DONE':
      pos += writeVarint(msg.requestId!, buf, pos);
      break;

    case 'NAMESPACE_DONE':
      pos += writeTuple(msg.trackNamespaceSuffix, buf, pos);
      break;

    case 'PUBLISH_NAMESPACE_CANCEL':
      pos += writeVarint(msg.requestId!, buf, pos);
      pos += writeVarint(msg.errorCode, buf, pos);
      pos += writeReasonPhrase(msg.errorReason, buf, pos);
      break;

    case 'SUBSCRIBE_NAMESPACE':
      pos += writeVarint(msg.requestId, buf, pos);
      pos += writeTuple(msg.trackNamespacePrefix, buf, pos);
      pos += writeVarint(msg.subscribeOptions!, buf, pos);
      pos += writeParams(msg.parameters, buf, pos);
      break;

    // Draft-14-only types — unreachable (messageTypeCode throws first)
    case 'UNSUBSCRIBE_NAMESPACE':
    case 'PUBLISH_NAMESPACE_OK':
    case 'PUBLISH_NAMESPACE_ERROR':
    case 'PUBLISH_ERROR':
      throw new Error(`Cannot encode draft-14-only message type "${msg.type}" with draft-16 encoder`);
    // Draft-18-only types — unreachable (messageTypeCode throws first)
    case 'SUBSCRIBE_TRACKS':
    case 'PUBLISH_BLOCKED':
      throw new Error(`Cannot encode draft-18-only message type "${msg.type}" with draft-16 encoder`);
  }

  return pos - offset;
}
