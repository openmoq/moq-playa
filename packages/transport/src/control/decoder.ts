/**
 * Control message decoder.
 * Deserializes Uint8Array → ControlMessage.
 *
 * Wire format: Type (varint) + Length (uint16) + Payload
 *
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import type {
  ControlMessage,
  Parameters,
  TrackExtensions,
  StandaloneFetch,
  JoiningFetch,
} from './messages.js';
import { MessageType } from './codes.js';
import { readVarint, varint, type Varint } from '../primitives/varint.js';
import {
  readUint8,
  readLengthPrefixedBytes,
  readTuple,
  validateTrackNamespace,
  validateTrackNamespacePrefix,
  validateTrackNamespaceSuffix,
  validateFullTrackName,
} from '../primitives/bytes.js';
import { readKvpList, type KvpValue } from '../primitives/kvp.js';
import { readLocation } from '../primitives/location.js';
import { readReasonPhrase } from '../primitives/reason.js';
import { ProtocolViolationError } from '../errors.js';

/**
 * Decode a control message from its wire representation.
 * @param buf Buffer containing at least one complete framed message.
 * @param offset Starting position in the buffer (default 0).
 * @returns The decoded message and total bytes consumed (type + length + payload).
 */
export function decodeControlMessage(
  buf: Uint8Array,
  offset: number = 0,
): { message: ControlMessage; bytesRead: number } {
  let pos = offset;

  // Read message type (varint)
  const { value: msgType, bytesRead: typeBytes } = readVarint(buf, pos);
  pos += typeBytes;

  // Read message length (uint16 big-endian)
  if (pos + 2 > buf.length) {
    throw new RangeError('Buffer too short for message length field');
  }
  const payloadLen = (buf[pos]! << 8) | buf[pos + 1]!;
  pos += 2;

  const payloadStart = pos;
  const payloadEnd = payloadStart + payloadLen;

  if (payloadEnd > buf.length) {
    throw new RangeError(
      `Buffer too short for message payload: need ${payloadLen} bytes, have ${buf.length - pos}`,
    );
  }

  const message = decodePayload(msgType, buf, pos, payloadEnd);
  const totalBytesRead = typeBytes + 2 + payloadLen;

  return { message, bytesRead: totalBytesRead };
}

/** Read parameters: varint(count) + KVP data. */
function readParams(
  buf: Uint8Array,
  offset: number,
): { value: Parameters; bytesRead: number } {
  let pos = offset;
  const { value: count, bytesRead: countBytes } = readVarint(buf, pos);
  pos += countBytes;
  const { value, bytesRead: kvpBytes } = readKvpList(buf, pos, Number(count));
  pos += kvpBytes;
  return { value, bytesRead: pos - offset };
}

/**
 * Read track extensions from remaining bytes.
 * Extensions are KVP entries with no count prefix — we read one at a time until end.
 */
function readExtensions(
  buf: Uint8Array,
  offset: number,
  end: number,
): { value: TrackExtensions; bytesRead: number } {
  const remaining = end - offset;
  if (remaining <= 0) {
    return { value: new Map<Varint, KvpValue[]>(), bytesRead: 0 };
  }
  // Count how many KVP entries fit by reading them
  const result = new Map<Varint, KvpValue[]>();
  let pos = offset;
  let prevType = 0n;

  while (pos < end) {
    const { value: delta, bytesRead: deltaBytes } = readVarint(buf, pos);
    pos += deltaBytes;
    const absType = prevType + delta;
    prevType = absType;
    const key = varint(absType);

    let val: KvpValue;
    if (absType % 2n === 0n) {
      const { value: v, bytesRead: valBytes } = readVarint(buf, pos);
      pos += valBytes;
      val = v;
    } else {
      const { value: v, bytesRead: valBytes } = readLengthPrefixedBytes(buf, pos);
      // §1.4.2: "The maximum length of a value is 2^16-1 bytes"
      if (v.length > 0xffff) {
        throw new RangeError(
          `Track extension byte value length ${v.length} exceeds maximum 65535 (2^16-1)`,
        );
      }
      pos += valBytes;
      val = v;
    }

    // Collect into array (supports duplicates)
    const existing = result.get(key);
    if (existing) {
      existing.push(val);
    } else {
      result.set(key, [val]);
    }
  }

  return { value: result, bytesRead: pos - offset };
}

/** Read Track Name (length-prefixed bytes). */
function readTrackName(
  buf: Uint8Array,
  offset: number,
): { value: Uint8Array; bytesRead: number } {
  return readLengthPrefixedBytes(buf, offset);
}


// Build a reverse lookup from code → type name
const codeToType = new Map<bigint, ControlMessage['type']>();
for (const [name, code] of Object.entries(MessageType)) {
  codeToType.set(code, name as ControlMessage['type']);
}

function decodePayload(
  msgType: Varint,
  buf: Uint8Array,
  offset: number,
  payloadEnd: number,
): ControlMessage {
  const typeName = codeToType.get(msgType);

  if (typeName === undefined) {
    throw new ProtocolViolationError(`Unknown message type: 0x${msgType.toString(16)}`);
  }

  const { message, finalPos } = decodePayloadFields(typeName, buf, offset, payloadEnd);

  if (finalPos !== payloadEnd) {
    throw new RangeError(
      `Payload not fully consumed for ${typeName}: consumed ${finalPos - offset} bytes, expected ${payloadEnd - offset}`,
    );
  }

  return message;
}

function decodePayloadFields(
  typeName: ControlMessage['type'],
  buf: Uint8Array,
  offset: number,
  payloadEnd: number,
): { message: ControlMessage; finalPos: number } {
  let pos = offset;

  switch (typeName) {
    case 'CLIENT_SETUP':
    case 'SERVER_SETUP': {
      const { value: parameters, bytesRead } = readParams(buf, pos);
      pos += bytesRead;
      return { message: { type: typeName, parameters }, finalPos: pos };
    }

    case 'SETUP':
      // draft-18-only; the draft-14/16 decoder never produces this typeName.
      throw new Error('SETUP is a draft-18 message; not produced by the draft-14/16 codec');

    case 'GOAWAY': {
      const { value: uriLen, bytesRead: uriLenBytes } = readVarint(buf, pos);
      pos += uriLenBytes;
      const numUriLen = Number(uriLen);
      if (numUriLen > 8192) {
        throw new RangeError(
          `GOAWAY URI length ${numUriLen} exceeds maximum 8192 bytes`,
        );
      }
      const uriBytes = buf.slice(pos, pos + numUriLen);
      pos += numUriLen;
      const newSessionUri = new TextDecoder().decode(uriBytes);
      return { message: { type: 'GOAWAY', newSessionUri }, finalPos: pos };
    }

    case 'MAX_REQUEST_ID': {
      const { value: maxRequestId, bytesRead } = readVarint(buf, pos);
      pos += bytesRead;
      return { message: { type: 'MAX_REQUEST_ID', maxRequestId }, finalPos: pos };
    }

    case 'REQUESTS_BLOCKED': {
      const { value: maximumRequestId, bytesRead } = readVarint(buf, pos);
      pos += bytesRead;
      return { message: { type: 'REQUESTS_BLOCKED', maximumRequestId }, finalPos: pos };
    }

    case 'REQUEST_OK': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: 'REQUEST_OK', requestId, parameters }, finalPos: pos };
    }

    case 'REQUEST_ERROR': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: errorCode, bytesRead: ecBytes } = readVarint(buf, pos);
      pos += ecBytes;
      const { value: retryInterval, bytesRead: riBytes } = readVarint(buf, pos);
      pos += riBytes;
      const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
      pos += erBytes;
      return { message: { type: 'REQUEST_ERROR', requestId, errorCode, retryInterval, errorReason }, finalPos: pos };
    }

    case 'SUBSCRIBE':
    case 'TRACK_STATUS': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
      pos += nsBytes;
      const { value: trackName, bytesRead: tnBytes } = readTrackName(buf, pos);
      pos += tnBytes;
      // Validate per §2.4.1
      validateFullTrackName(trackNamespace, trackName);
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: typeName, requestId, trackNamespace, trackName, parameters }, finalPos: pos };
    }

    case 'SUBSCRIBE_OK': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: trackAlias, bytesRead: taBytes } = readVarint(buf, pos);
      pos += taBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      const { value: trackExtensions, bytesRead: extBytes } = readExtensions(buf, pos, payloadEnd);
      pos += extBytes;
      return { message: { type: 'SUBSCRIBE_OK', requestId, trackAlias, parameters, trackExtensions }, finalPos: pos };
    }

    case 'REQUEST_UPDATE': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: existingRequestId, bytesRead: eridBytes } = readVarint(buf, pos);
      pos += eridBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: 'REQUEST_UPDATE', requestId, existingRequestId, parameters }, finalPos: pos };
    }

    case 'UNSUBSCRIBE': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      return { message: { type: 'UNSUBSCRIBE', requestId }, finalPos: pos };
    }

    case 'PUBLISH': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
      pos += nsBytes;
      const { value: trackName, bytesRead: tnBytes } = readTrackName(buf, pos);
      pos += tnBytes;
      // Validate per §2.4.1
      validateFullTrackName(trackNamespace, trackName);
      const { value: trackAlias, bytesRead: taBytes } = readVarint(buf, pos);
      pos += taBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      const { value: trackExtensions, bytesRead: extBytes } = readExtensions(buf, pos, payloadEnd);
      pos += extBytes;
      return { message: { type: 'PUBLISH', requestId, trackNamespace, trackName, trackAlias, parameters, trackExtensions }, finalPos: pos };
    }

    case 'PUBLISH_OK': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: 'PUBLISH_OK', requestId, parameters }, finalPos: pos };
    }

    case 'PUBLISH_DONE': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: statusCode, bytesRead: scBytes } = readVarint(buf, pos);
      pos += scBytes;
      const { value: streamCount, bytesRead: stBytes } = readVarint(buf, pos);
      pos += stBytes;
      const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
      pos += erBytes;
      return { message: { type: 'PUBLISH_DONE', requestId, statusCode, streamCount, errorReason }, finalPos: pos };
    }

    case 'FETCH': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: fetchTypeVal, bytesRead: ftBytes } = readVarint(buf, pos);
      pos += ftBytes;

      let fetch: StandaloneFetch | JoiningFetch;

      if (fetchTypeVal === 0x1n) {
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        const { value: trackName, bytesRead: tnBytes } = readTrackName(buf, pos);
        pos += tnBytes;
        // Validate per §2.4.1
        validateFullTrackName(trackNamespace, trackName);
        const { value: startLocation, bytesRead: slBytes } = readLocation(buf, pos);
        pos += slBytes;
        const { value: endLocation, bytesRead: elBytes } = readLocation(buf, pos);
        pos += elBytes;
        fetch = { fetchType: 0x1, trackNamespace, trackName, startLocation, endLocation };
      } else if (fetchTypeVal === 0x2n || fetchTypeVal === 0x3n) {
        const { value: joiningRequestId, bytesRead: jridBytes } = readVarint(buf, pos);
        pos += jridBytes;
        const { value: joiningStart, bytesRead: jsBytes } = readVarint(buf, pos);
        pos += jsBytes;
        fetch = { fetchType: Number(fetchTypeVal) as 0x2 | 0x3, joiningRequestId, joiningStart };
      } else {
        throw new ProtocolViolationError(`Invalid Fetch Type: 0x${fetchTypeVal.toString(16)}`);
      }

      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: 'FETCH', requestId, fetch, parameters }, finalPos: pos };
    }

    case 'FETCH_OK': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: endOfTrack } = readUint8(buf, pos);
      pos += 1;
      const { value: endLocation, bytesRead: elBytes } = readLocation(buf, pos);
      pos += elBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      const { value: trackExtensions, bytesRead: extBytes } = readExtensions(buf, pos, payloadEnd);
      pos += extBytes;
      return { message: { type: 'FETCH_OK', requestId, endOfTrack, endLocation, parameters, trackExtensions }, finalPos: pos };
    }

    case 'FETCH_CANCEL': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      return { message: { type: 'FETCH_CANCEL', requestId }, finalPos: pos };
    }

    case 'PUBLISH_NAMESPACE': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
      pos += nsBytes;
      // Validate per §2.4.1 (full namespace: 1-32 fields)
      validateTrackNamespace(trackNamespace);
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: 'PUBLISH_NAMESPACE', requestId, trackNamespace, parameters }, finalPos: pos };
    }

    case 'NAMESPACE': {
      const { value: trackNamespaceSuffix, bytesRead: nsBytes } = readTuple(buf, pos);
      pos += nsBytes;
      // Validate suffix: ≤32 fields, each ≥1 byte, total ≤4096 bytes
      validateTrackNamespaceSuffix(trackNamespaceSuffix);
      return { message: { type: 'NAMESPACE', trackNamespaceSuffix }, finalPos: pos };
    }

    case 'PUBLISH_NAMESPACE_DONE': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      return { message: { type: 'PUBLISH_NAMESPACE_DONE', requestId }, finalPos: pos };
    }

    case 'NAMESPACE_DONE': {
      const { value: trackNamespaceSuffix, bytesRead: nsBytes } = readTuple(buf, pos);
      pos += nsBytes;
      // Validate suffix: ≤32 fields, each ≥1 byte, total ≤4096 bytes
      validateTrackNamespaceSuffix(trackNamespaceSuffix);
      return { message: { type: 'NAMESPACE_DONE', trackNamespaceSuffix }, finalPos: pos };
    }

    case 'PUBLISH_NAMESPACE_CANCEL': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: errorCode, bytesRead: ecBytes } = readVarint(buf, pos);
      pos += ecBytes;
      const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
      pos += erBytes;
      return { message: { type: 'PUBLISH_NAMESPACE_CANCEL', requestId, errorCode, errorReason }, finalPos: pos };
    }

    case 'SUBSCRIBE_NAMESPACE': {
      const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
      pos += ridBytes;
      const { value: trackNamespacePrefix, bytesRead: nsBytes } = readTuple(buf, pos);
      pos += nsBytes;
      // Validate per §9.25 (prefix: 0-32 fields)
      validateTrackNamespacePrefix(trackNamespacePrefix);
      const { value: subscribeOptions, bytesRead: soBytes } = readVarint(buf, pos);
      pos += soBytes;
      const { value: parameters, bytesRead: pBytes } = readParams(buf, pos);
      pos += pBytes;
      return { message: { type: 'SUBSCRIBE_NAMESPACE', requestId, trackNamespacePrefix, subscribeOptions, parameters }, finalPos: pos };
    }

    // Draft-14-only types — not decodable by draft-16 decoder
    // (these wire codes map to different message types in draft-16)
    case 'UNSUBSCRIBE_NAMESPACE':
    case 'PUBLISH_NAMESPACE_OK':
    case 'PUBLISH_NAMESPACE_ERROR':
    case 'PUBLISH_ERROR':
      throw new ProtocolViolationError(`Draft-14-only message type "${typeName}" cannot be decoded by draft-16 decoder`);
    // Draft-18-only types — not decodable by the draft-14/16 decoder
    case 'SUBSCRIBE_TRACKS':
    case 'PUBLISH_BLOCKED':
      throw new ProtocolViolationError(`Draft-18-only message type "${typeName}" cannot be decoded by draft-16 decoder`);
  }
}
