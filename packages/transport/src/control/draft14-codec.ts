/**
 * Draft-14 control message codec.
 *
 * Encodes outbound ControlMessages to draft-14 wire format and decodes
 * inbound draft-14 wire bytes, normalizing most messages to draft-16
 * ControlMessage types at decode time.
 *
 * Key differences from draft-16:
 * - KVP uses absolute type values (not delta-encoded) — §1.4.2
 * - CLIENT_SETUP prepends version list before params — §9.3
 * - SERVER_SETUP prepends selected version before params — §9.3
 * - SUBSCRIBE/SUBSCRIBE_OK have inline fields → normalized to params — §9.7, §9.8
 * - SUBSCRIBE_ERROR/FETCH_ERROR → normalized to RequestError — §9.9, §9.18
 * - TRACK_STATUS_OK/ERROR → normalized to RequestOk/RequestError — §9.21, §9.22
 * - SUBSCRIBE_NAMESPACE_OK/ERROR → normalized to RequestOk/RequestError — §9.29, §9.30
 * - PUBLISH_NAMESPACE_DONE/CANCEL use namespace tuples (not requestIds) — §9.26, §9.27
 * - SUBSCRIBE_NAMESPACE has no subscribeOptions field — §9.28
 * - PUBLISH/PUBLISH_OK use varint length instead of uint16 — §9.13, §9.14
 * - FETCH has inline Priority/GroupOrder — §9.16
 * - FETCH_OK has inline GroupOrder — §9.17
 *
 * @see draft-ietf-moq-transport-14
 * @module
 */

import type { ControlCodec } from './codec.js';
import type {
  ControlMessage,
  Parameters,
  Subscribe,
  SubscribeOk,
  ClientSetup,
  ServerSetup,
  RequestErrorMsg,
  RequestErrorKind,
  Fetch,
  RequestUpdate,
  TrackExtensions,
  PublishOk,
  PublishError,
  PublishDone,
} from './messages.js';
import type { Varint } from '../primitives/varint.js';
import type { Location } from '../primitives/location.js';
import { varint, readVarint, writeVarint, varintEncodingLength } from '../primitives/varint.js';
import {
  readLengthPrefixedBytes, writeLengthPrefixedBytes, lengthPrefixedBytesEncodingLength,
  readTuple, writeTuple, tupleEncodingLength,
  readUint8,
  validateTrackNamespace,
  validateTrackNamespacePrefix,
} from '../primitives/bytes.js';
import {
  readKvpListAbsolute, writeKvpListAbsolute,
  kvpListAbsoluteEncodingLength, kvpListEntryCount,
} from '../primitives/kvp.js';
import { readLocation, writeLocation, locationEncodingLength } from '../primitives/location.js';
import { readReasonPhrase, writeReasonPhrase, reasonPhraseEncodingLength } from '../primitives/reason.js';
import { MessageParam } from './parameters.js';
import { toKvpParams } from './kvp-params.js';
import { ProtocolViolationError } from '../errors.js';

// ─── Draft-14 Wire Codes ─────────────────────────────────────────────
// @see draft-ietf-moq-transport-14 §9

const D14 = {
  // Outbound (subscriber sends)
  CLIENT_SETUP:              0x20,
  SUBSCRIBE:                 0x03,
  SUBSCRIBE_UPDATE:          0x02,
  SUBSCRIBE_NAMESPACE:       0x11,
  UNSUBSCRIBE_NAMESPACE:     0x14,
  UNSUBSCRIBE:               0x0a,
  FETCH:                     0x16,
  FETCH_CANCEL:              0x17,
  TRACK_STATUS:              0x0d,
  PUBLISH_NAMESPACE_OK:      0x07,
  PUBLISH_NAMESPACE_ERROR:   0x08,

  // Inbound (subscriber receives)
  SERVER_SETUP:              0x21,
  SUBSCRIBE_OK:              0x04,
  SUBSCRIBE_ERROR:           0x05,
  FETCH_OK:                  0x18,
  FETCH_ERROR:               0x19,
  TRACK_STATUS_OK:           0x0e,
  TRACK_STATUS_ERROR:        0x0f,
  SUBSCRIBE_NAMESPACE_OK:    0x12,
  SUBSCRIBE_NAMESPACE_ERROR: 0x13,
  PUBLISH_NAMESPACE:         0x06,
  PUBLISH_NAMESPACE_DONE:    0x09,
  PUBLISH_NAMESPACE_CANCEL:  0x0c,
  PUBLISH_DONE:              0x0b,
  GOAWAY:                    0x10,
  MAX_REQUEST_ID:            0x15,
  REQUESTS_BLOCKED:          0x1a,

  // Varint-length messages
  PUBLISH:                   0x1d,
  PUBLISH_OK:                0x1e,
  PUBLISH_ERROR:             0x1f,
} as const;

/** Messages that use varint length instead of uint16. */
const VARINT_LENGTH_TYPES: Set<number> = new Set([D14.PUBLISH, D14.PUBLISH_OK, D14.PUBLISH_ERROR]);

// ─── Draft-14 Codec Implementation ──────────────────────────────────

export class Draft14Codec implements ControlCodec {
  readonly version = 14 as const;

  // ─── encode ───────────────────────────────────────────────────────

  encode(msg: ControlMessage): Uint8Array {
    switch (msg.type) {
      case 'CLIENT_SETUP': return this.encodeClientSetup(msg);
      case 'SERVER_SETUP': return this.encodeServerSetup(msg);
      case 'SUBSCRIBE': return this.encodeSubscribe(msg);
      case 'REQUEST_UPDATE': return this.encodeSubscribeUpdate(msg);
      case 'SUBSCRIBE_NAMESPACE': return this.encodeSubscribeNamespace(msg);
      case 'UNSUBSCRIBE_NAMESPACE': return this.encodeUnsubscribeNamespace(msg);
      case 'UNSUBSCRIBE': return this.encodeSimpleRequestId(D14.UNSUBSCRIBE, msg.requestId);
      case 'FETCH': return this.encodeFetch(msg);
      case 'FETCH_CANCEL': return this.encodeSimpleRequestId(D14.FETCH_CANCEL, msg.requestId);
      case 'TRACK_STATUS': return this.encodeTrackStatus(msg);
      case 'PUBLISH_NAMESPACE': return this.encodePublishNamespace(msg);
      case 'PUBLISH_NAMESPACE_OK': return this.encodeSimpleRequestId(D14.PUBLISH_NAMESPACE_OK, msg.requestId);
      case 'PUBLISH_NAMESPACE_ERROR': return this.encodePublishNamespaceError(msg);
      case 'PUBLISH_OK': return this.encodePublishOk(msg);
      case 'PUBLISH_ERROR': return this.encodePublishError(msg);
      case 'SUBSCRIBE_OK': return this.encodeSubscribeOk(msg);
      case 'PUBLISH_DONE': return this.encodePublishDone(msg);
      case 'PUBLISH_NAMESPACE_DONE': return this.encodeNamespaceTuple(D14.PUBLISH_NAMESPACE_DONE, msg.trackNamespace!);
      case 'REQUEST_ERROR': return this.encodeRequestError(msg);
      case 'REQUEST_OK':
        throw new Error('Draft-14 does not have generic REQUEST_OK — use specific OK types');
      default:
        throw new Error(`Draft14Codec cannot encode message type "${msg.type}"`);
    }
  }

  // ─── decode ───────────────────────────────────────────────────────

  decode(buf: Uint8Array, offset: number): { message: ControlMessage; bytesRead: number } {
    let pos = offset;

    const { value: msgType, bytesRead: typeBytes } = readVarint(buf, pos);
    pos += typeBytes;

    const typeNum = Number(msgType);
    const isVarintLen = VARINT_LENGTH_TYPES.has(typeNum);

    let payloadLen: number;
    let headerOverhead: number;

    if (isVarintLen) {
      const { value: lenVal, bytesRead: lenBytes } = readVarint(buf, pos);
      pos += lenBytes;
      payloadLen = Number(lenVal);
      headerOverhead = typeBytes + lenBytes;
    } else {
      if (pos + 2 > buf.length) throw new RangeError('Buffer too short for message length field');
      payloadLen = (buf[pos]! << 8) | buf[pos + 1]!;
      pos += 2;
      headerOverhead = typeBytes + 2;
    }

    const payloadEnd = pos + payloadLen;
    if (payloadEnd > buf.length) {
      throw new RangeError(`Buffer too short: need ${payloadLen} bytes, have ${buf.length - pos}`);
    }

    const message = this.decodePayload(typeNum, buf, pos, payloadEnd);
    return { message, bytesRead: headerOverhead + payloadLen };
  }

  // ─── peekFrameSize ────────────────────────────────────────────────

  peekFrameSize(buf: Uint8Array): number | undefined {
    if (buf.length === 0) return undefined;

    // Determine type varint length from first byte
    const first = buf[0]!;
    const lengthFlag = first >> 6;
    const typeVarintLen = (1 << lengthFlag) as 1 | 2 | 4 | 8;

    if (buf.length < typeVarintLen) return undefined;

    // Read the actual type value to check if it uses varint length
    const { value: msgType } = readVarint(buf, 0);
    const typeNum = Number(msgType);

    if (VARINT_LENGTH_TYPES.has(typeNum)) {
      // Varint length
      if (buf.length < typeVarintLen + 1) return undefined;
      const lenFirst = buf[typeVarintLen]!;
      const lenFlag = lenFirst >> 6;
      const lenVarintLen = (1 << lenFlag) as 1 | 2 | 4 | 8;
      if (buf.length < typeVarintLen + lenVarintLen) return undefined;
      const { value: payloadLen } = readVarint(buf, typeVarintLen);
      return typeVarintLen + lenVarintLen + Number(payloadLen);
    } else {
      // uint16 length
      const headerLen = typeVarintLen + 2;
      if (buf.length < headerLen) return undefined;
      const payloadLen = (buf[typeVarintLen]! << 8) | buf[typeVarintLen + 1]!;
      return headerLen + payloadLen;
    }
  }

  // ─── Encode Helpers ───────────────────────────────────────────────

  private frame16(typeCode: number, payload: Uint8Array): Uint8Array {
    const typeVarint = varint(typeCode);
    const typeLen = varintEncodingLength(typeVarint);
    const total = typeLen + 2 + payload.length;
    const buf = new Uint8Array(total);
    let pos = 0;
    pos += writeVarint(typeVarint, buf, pos);
    buf[pos++] = (payload.length >> 8) & 0xff;
    buf[pos++] = payload.length & 0xff;
    buf.set(payload, pos);
    return buf;
  }

  private writeParams(params: Parameters, buf: Uint8Array, offset: number): number {
    let pos = offset;
    const kvp = toKvpParams(params);
    const count = kvpListEntryCount(kvp);
    pos += writeVarint(varint(count), buf, pos);
    pos += writeKvpListAbsolute(kvp, buf, pos);
    return pos - offset;
  }

  private paramsLength(params: Parameters): number {
    const kvp = toKvpParams(params);
    const count = kvpListEntryCount(kvp);
    return varintEncodingLength(varint(count)) + kvpListAbsoluteEncodingLength(kvp);
  }

  /**
   * Assert a value fits in an 8-bit wire field.
   *
   * Draft-14 declares SUBSCRIBER_PRIORITY (§9.7), FORWARD (§9.7), GROUP_ORDER
   * (§9.2.2.4), and related fields as 8-bit inline integers. The internal
   * model carries them as Varint, so out-of-range input would silently
   * truncate on encode (e.g. varint(300) → 0x2C). Reject loudly at the
   * encode boundary so the peer never sees a corrupted wire value.
   *
   * Policy: validate-on-encode. Mirrors the validate-on-decode check in
   * session.ts (§9.2.2.3 SUBSCRIBER_PRIORITY range enforcement).
   */
  private assertUint8(value: number, field: string, msgType: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new ProtocolViolationError(
        `${msgType}: ${field} must be 0-255 for 8-bit wire encoding, got ${value}`,
      );
    }
  }

  private encodeSimpleRequestId(typeCode: number, requestId: bigint): Uint8Array {
    const payloadLen = varintEncodingLength(requestId);
    const payload = new Uint8Array(payloadLen);
    writeVarint(requestId, payload, 0);
    return this.frame16(typeCode, payload);
  }

  private encodeClientSetup(msg: ClientSetup): Uint8Array {
    // Draft-14 §9.3: Number of Versions (i), Versions (i)..., Params
    // We advertise draft-14 version: 0xff00000e
    const draftVersion = varint(0xff00000e);
    const payloadLen =
      varintEncodingLength(varint(1)) +               // Number of Supported Versions
      varintEncodingLength(draftVersion) +             // Version value
      this.paramsLength(msg.parameters);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(varint(1), payload, pos);       // 1 version
    pos += writeVarint(draftVersion, payload, pos);     // draft-14
    pos += this.writeParams(msg.parameters, payload, pos);

    return this.frame16(D14.CLIENT_SETUP, payload);
  }

  private encodeServerSetup(msg: ServerSetup): Uint8Array {
    // Draft-14 §9.3: Selected Version (i), Params. Unlike CLIENT_SETUP (which
    // advertises a version list), the server echoes the single negotiated
    // version. This mirrors the SERVER_SETUP decode path below and differs from
    // Playa's draft-16 codec, which frames both SETUPs as params-only.
    const selectedVersion = varint(0xff00000e); // draft-14
    const payloadLen =
      varintEncodingLength(selectedVersion) +          // Selected Version
      this.paramsLength(msg.parameters);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(selectedVersion, payload, pos);
    pos += this.writeParams(msg.parameters, payload, pos);

    return this.frame16(D14.SERVER_SETUP, payload);
  }

  /**
   * Encode a (normalized) REQUEST_ERROR back to its specific draft-14 wire type.
   *
   * Draft-14 has no generic REQUEST_ERROR; it splits into SUBSCRIBE_ERROR (§9.9),
   * FETCH_ERROR (§9.18), TRACK_STATUS_ERROR (§9.22), and SUBSCRIBE_NAMESPACE_ERROR
   * (§9.30) — all sharing the identical [Request ID, Error Code, Reason] payload
   * and differing only by type code. The session stamps `requestKind` so we
   * recover the type WITHOUT guessing from the Request ID. Without that context
   * we cannot disambiguate, so we throw (loudly) rather than mis-encode.
   */
  private encodeRequestError(msg: RequestErrorMsg): Uint8Array {
    const typeByKind: Record<RequestErrorKind, number> = {
      SUBSCRIBE: D14.SUBSCRIBE_ERROR,
      FETCH: D14.FETCH_ERROR,
      TRACK_STATUS: D14.TRACK_STATUS_ERROR,
      SUBSCRIBE_NAMESPACE: D14.SUBSCRIBE_NAMESPACE_ERROR,
    };
    if (msg.requestKind === undefined) {
      throw new Error('Draft-14 does not have generic REQUEST_ERROR — use specific error types');
    }
    const typeCode = typeByKind[msg.requestKind];

    const payloadLen =
      varintEncodingLength(msg.requestId) +
      varintEncodingLength(msg.errorCode) +
      reasonPhraseEncodingLength(msg.errorReason);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeVarint(msg.errorCode, payload, pos);
    pos += writeReasonPhrase(msg.errorReason, payload, pos);

    return this.frame16(typeCode, payload);
  }

  private encodeSubscribe(msg: Subscribe): Uint8Array {
    validateTrackNamespace(msg.trackNamespace);
    // Draft-14 §9.7: inline Priority, GroupOrder, Forward, FilterType, [StartLoc], [EndGroup]
    const priority = Number(this.extractParamVarint(msg.parameters, MessageParam.SUBSCRIBER_PRIORITY) ?? 128n);
    const groupOrder = Number(this.extractParamVarint(msg.parameters, MessageParam.GROUP_ORDER) ?? 0n);
    const forward = Number(this.extractParamVarint(msg.parameters, MessageParam.FORWARD) ?? 1n);
    this.assertUint8(priority, 'SUBSCRIBER_PRIORITY', 'SUBSCRIBE');
    this.assertUint8(groupOrder, 'GROUP_ORDER', 'SUBSCRIBE');
    this.assertUint8(forward, 'FORWARD', 'SUBSCRIBE');

    // SUBSCRIPTION_FILTER is a bytes parameter (type 0x21 is odd).
    // Parse the draft-16 filter structure: FilterType (i), [StartGroup (i), StartObject (i)], [EndGroup (i)]
    const filter = this.extractFilter(msg.parameters);

    // Build remaining params (without extracted inline fields)
    const remainingParams = this.cloneParamsWithout(msg.parameters, [
      MessageParam.SUBSCRIBER_PRIORITY,
      MessageParam.GROUP_ORDER,
      MessageParam.FORWARD,
      MessageParam.SUBSCRIPTION_FILTER,
    ]);

    // Calculate filter-specific fields length
    let filterFieldsLen = 0;
    if (filter.startLocation) {
      filterFieldsLen += locationEncodingLength(filter.startLocation);
    }
    if (filter.endGroup !== undefined) {
      filterFieldsLen += varintEncodingLength(filter.endGroup);
    }

    const payloadLen =
      varintEncodingLength(msg.requestId) +
      tupleEncodingLength(msg.trackNamespace) +
      lengthPrefixedBytesEncodingLength(msg.trackName) +
      1 + // Subscriber Priority (8)
      1 + // Group Order (8)
      1 + // Forward (8)
      varintEncodingLength(filter.filterType) +
      filterFieldsLen +
      this.paramsLength(remainingParams);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeTuple(msg.trackNamespace, payload, pos);
    pos += writeLengthPrefixedBytes(msg.trackName, payload, pos);
    payload[pos++] = priority & 0xff;
    payload[pos++] = groupOrder & 0xff;
    payload[pos++] = forward & 0xff;
    pos += writeVarint(filter.filterType, payload, pos);

    // Filter-specific fields (§9.7: Start Location, End Group)
    if (filter.startLocation) {
      pos += writeLocation(filter.startLocation, payload, pos);
    }
    if (filter.endGroup !== undefined) {
      pos += writeVarint(filter.endGroup, payload, pos);
    }

    pos += this.writeParams(remainingParams, payload, pos);

    return this.frame16(D14.SUBSCRIBE, payload);
  }

  private encodeFetch(msg: Fetch): Uint8Array {
    if (msg.fetch.fetchType === 0x1) {
      validateTrackNamespace(msg.fetch.trackNamespace);
    }
    // Draft-14 §9.16: inline Subscriber Priority (8), Group Order (8) before FetchType
    const priority = Number(this.extractParamVarint(msg.parameters, MessageParam.SUBSCRIBER_PRIORITY) ?? 128n);
    const groupOrder = Number(this.extractParamVarint(msg.parameters, MessageParam.GROUP_ORDER) ?? 0n);
    this.assertUint8(priority, 'SUBSCRIBER_PRIORITY', 'FETCH');
    this.assertUint8(groupOrder, 'GROUP_ORDER', 'FETCH');

    const remainingParams = this.cloneParamsWithout(msg.parameters, [
      MessageParam.SUBSCRIBER_PRIORITY,
      MessageParam.GROUP_ORDER,
    ]);

    let fetchFieldsLen = varintEncodingLength(varint(msg.fetch.fetchType));
    if (msg.fetch.fetchType === 0x1) {
      fetchFieldsLen +=
        tupleEncodingLength(msg.fetch.trackNamespace) +
        lengthPrefixedBytesEncodingLength(msg.fetch.trackName) +
        locationEncodingLength(msg.fetch.startLocation) +
        locationEncodingLength(msg.fetch.endLocation);
    } else {
      fetchFieldsLen +=
        varintEncodingLength(msg.fetch.joiningRequestId) +
        varintEncodingLength(msg.fetch.joiningStart);
    }

    const payloadLen =
      varintEncodingLength(msg.requestId) +
      1 + // Subscriber Priority (8)
      1 + // Group Order (8)
      fetchFieldsLen +
      this.paramsLength(remainingParams);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    payload[pos++] = priority & 0xff;
    payload[pos++] = groupOrder & 0xff;
    pos += writeVarint(varint(msg.fetch.fetchType), payload, pos);

    if (msg.fetch.fetchType === 0x1) {
      pos += writeTuple(msg.fetch.trackNamespace, payload, pos);
      pos += writeLengthPrefixedBytes(msg.fetch.trackName, payload, pos);
      pos += writeLocation(msg.fetch.startLocation, payload, pos);
      pos += writeLocation(msg.fetch.endLocation, payload, pos);
    } else {
      pos += writeVarint(msg.fetch.joiningRequestId, payload, pos);
      pos += writeVarint(msg.fetch.joiningStart, payload, pos);
    }

    pos += this.writeParams(remainingParams, payload, pos);

    return this.frame16(D14.FETCH, payload);
  }

  private encodeTrackStatus(msg: ControlMessage & { type: 'TRACK_STATUS' }): Uint8Array {
    validateTrackNamespace(msg.trackNamespace);
    // Same wire format as draft-16 but with absolute KVP
    const payloadLen =
      varintEncodingLength(msg.requestId) +
      tupleEncodingLength(msg.trackNamespace) +
      lengthPrefixedBytesEncodingLength(msg.trackName) +
      this.paramsLength(msg.parameters);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeTuple(msg.trackNamespace, payload, pos);
    pos += writeLengthPrefixedBytes(msg.trackName, payload, pos);
    pos += this.writeParams(msg.parameters, payload, pos);

    return this.frame16(D14.TRACK_STATUS, payload);
  }

  private encodeSubscribeNamespace(msg: ControlMessage & { type: 'SUBSCRIBE_NAMESPACE' }): Uint8Array {
    validateTrackNamespacePrefix(msg.trackNamespacePrefix);
    // Draft-14 §9.28: No subscribeOptions field
    const payloadLen =
      varintEncodingLength(msg.requestId) +
      tupleEncodingLength(msg.trackNamespacePrefix) +
      this.paramsLength(msg.parameters);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeTuple(msg.trackNamespacePrefix, payload, pos);
    pos += this.writeParams(msg.parameters, payload, pos);

    return this.frame16(D14.SUBSCRIBE_NAMESPACE, payload);
  }

  private encodeUnsubscribeNamespace(msg: ControlMessage & { type: 'UNSUBSCRIBE_NAMESPACE' }): Uint8Array {
    validateTrackNamespacePrefix(msg.trackNamespacePrefix);
    // Draft-14 §9.31: Track Namespace Prefix (tuple)
    const payloadLen = tupleEncodingLength(msg.trackNamespacePrefix);
    const payload = new Uint8Array(payloadLen);
    writeTuple(msg.trackNamespacePrefix, payload, 0);
    return this.frame16(D14.UNSUBSCRIBE_NAMESPACE, payload);
  }

  private encodePublishNamespace(msg: ControlMessage & { type: 'PUBLISH_NAMESPACE' }): Uint8Array {
    const payloadLen =
      varintEncodingLength(msg.requestId) +
      tupleEncodingLength(msg.trackNamespace) +
      this.paramsLength(msg.parameters);
    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeTuple(msg.trackNamespace, payload, pos);
    pos += this.writeParams(msg.parameters, payload, pos);
    return this.frame16(D14.PUBLISH_NAMESPACE, payload);
  }

  private encodeNamespaceTuple(type: number, namespace: Uint8Array[]): Uint8Array {
    const payloadLen = tupleEncodingLength(namespace);
    const payload = new Uint8Array(payloadLen);
    writeTuple(namespace, payload, 0);
    return this.frame16(type, payload);
  }

  private encodePublishNamespaceError(msg: ControlMessage & { type: 'PUBLISH_NAMESPACE_ERROR' }): Uint8Array {
    const payloadLen =
      varintEncodingLength(msg.requestId) +
      varintEncodingLength(msg.errorCode) +
      reasonPhraseEncodingLength(msg.errorReason);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeVarint(msg.errorCode, payload, pos);
    pos += writeReasonPhrase(msg.errorReason, payload, pos);

    return this.frame16(D14.PUBLISH_NAMESPACE_ERROR, payload);
  }

  // ─── Decode Helpers ───────────────────────────────────────────────

  private decodePayload(typeNum: number, buf: Uint8Array, offset: number, payloadEnd: number): ControlMessage {
    let pos = offset;

    switch (typeNum) {
      // ── Setup ──
      case D14.CLIENT_SETUP: {
        // Draft-14 §9.3: versions list then params
        const { value: numVersions, bytesRead: nvBytes } = readVarint(buf, pos);
        pos += nvBytes;
        for (let i = 0; i < Number(numVersions); i++) {
          const { bytesRead: vBytes } = readVarint(buf, pos);
          pos += vBytes;
        }
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;
        this.assertConsumed(pos, payloadEnd, 'CLIENT_SETUP');
        return { type: 'CLIENT_SETUP', parameters };
      }

      case D14.SERVER_SETUP: {
        // Draft-14 §9.3: selected version then params
        const { bytesRead: vBytes } = readVarint(buf, pos);
        pos += vBytes;
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;
        this.assertConsumed(pos, payloadEnd, 'SERVER_SETUP');
        return { type: 'SERVER_SETUP', parameters };
      }

      // ── Subscribe ──
      case D14.SUBSCRIBE: {
        // Draft-14 §9.7: inline fields
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        const { value: trackName, bytesRead: tnBytes } = readLengthPrefixedBytes(buf, pos);
        pos += tnBytes;
        const priority = buf[pos++]!;
        const groupOrder = buf[pos++]!;
        const forward = buf[pos++]!;
        const { value: filterType, bytesRead: ftBytes } = readVarint(buf, pos);
        pos += ftBytes;

        // Read filter-specific fields and encode as SUBSCRIPTION_FILTER bytes
        // (draft-16 format) so the session validator can structurally validate.
        let startLoc: Location | undefined;
        let endGroupVal: Varint | undefined;
        if (filterType === 0x3n || filterType === 0x4n) {
          const { value: sl, bytesRead: slBytes } = readLocation(buf, pos);
          pos += slBytes;
          startLoc = sl;
        }
        if (filterType === 0x4n) {
          const { value: eg, bytesRead: egBytes } = readVarint(buf, pos);
          pos += egBytes;
          endGroupVal = eg;
        }

        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;

        // Normalize inline fields → parameters
        parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [varint(priority)]);
        parameters.set(MessageParam.GROUP_ORDER, [varint(groupOrder)]);
        parameters.set(MessageParam.FORWARD, [varint(forward)]);

        // Encode filter as bytes (draft-16 SUBSCRIPTION_FILTER wire format)
        // so session structural validation works uniformly.
        const filterBytes = this.encodeFilterBytes(varint(filterType), startLoc, endGroupVal);
        parameters.set(MessageParam.SUBSCRIPTION_FILTER, [filterBytes]);

        this.assertConsumed(pos, payloadEnd, 'SUBSCRIBE');
        return { type: 'SUBSCRIBE', requestId, trackNamespace, trackName, parameters };
      }

      case D14.SUBSCRIBE_OK: {
        // Draft-14 §9.8: inline fields
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: trackAlias, bytesRead: taBytes } = readVarint(buf, pos);
        pos += taBytes;
        const { value: expires, bytesRead: exBytes } = readVarint(buf, pos);
        pos += exBytes;
        const groupOrder = buf[pos++]!;
        const contentExists = buf[pos++]!;

        // §9.8: "Any other value is a protocol error and MUST terminate
        // the session with a PROTOCOL_VIOLATION"
        if (contentExists !== 0 && contentExists !== 1) {
          throw new ProtocolViolationError(
            `SUBSCRIBE_OK Content Exists has invalid value ${contentExists} (must be 0 or 1)`,
          );
        }

        let largestLocation: Location | undefined;
        if (contentExists === 1) {
          const { value: ll, bytesRead: llBytes } = readLocation(buf, pos);
          pos += llBytes;
          largestLocation = ll;
        }

        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;

        // Normalize inline fields → parameters
        parameters.set(MessageParam.EXPIRES, [expires]);
        parameters.set(MessageParam.GROUP_ORDER, [varint(groupOrder)]);
        if (largestLocation !== undefined) {
          // §9.2.2.7: LARGEST_OBJECT is a Location structure (group + object bytes).
          // Encode as bytes so session validateLargestObject() works correctly.
          const locBuf = new Uint8Array(locationEncodingLength(largestLocation));
          writeLocation(largestLocation, locBuf, 0);
          parameters.set(MessageParam.LARGEST_OBJECT, [locBuf]);
        }

        this.assertConsumed(pos, payloadEnd, 'SUBSCRIBE_OK');
        // No trackExtensions in draft-14
        const trackExtensions: TrackExtensions = new Map();
        return { type: 'SUBSCRIBE_OK', requestId, trackAlias, parameters, trackExtensions };
      }

      // ── Error types normalized to REQUEST_ERROR ──
      case D14.SUBSCRIBE_ERROR:
      case D14.FETCH_ERROR:
      case D14.TRACK_STATUS_ERROR:
      case D14.SUBSCRIBE_NAMESPACE_ERROR: {
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: errorCode, bytesRead: ecBytes } = readVarint(buf, pos);
        pos += ecBytes;
        const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
        pos += erBytes;
        this.assertConsumed(pos, payloadEnd, 'ERROR');
        return {
          type: 'REQUEST_ERROR',
          requestId,
          errorCode,
          retryInterval: varint(0),
          errorReason,
        };
      }

      // ── OK types normalized to REQUEST_OK ──
      case D14.TRACK_STATUS_OK: {
        // Same wire format as SUBSCRIBE_OK but normalized to REQUEST_OK
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { bytesRead: taBytes } = readVarint(buf, pos); // Track Alias (always 0)
        pos += taBytes;
        const { value: expires, bytesRead: exBytes } = readVarint(buf, pos);
        pos += exBytes;
        const groupOrder = buf[pos++]!;
        const tsContentExists = buf[pos++]!;
        if (tsContentExists !== 0 && tsContentExists !== 1) {
          throw new ProtocolViolationError(
            `TRACK_STATUS_OK Content Exists has invalid value ${tsContentExists} (must be 0 or 1)`,
          );
        }
        if (tsContentExists === 1) {
          const { bytesRead: llBytes } = readLocation(buf, pos);
          pos += llBytes;
        }
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;
        parameters.set(MessageParam.EXPIRES, [expires]);
        parameters.set(MessageParam.GROUP_ORDER, [varint(groupOrder)]);
        this.assertConsumed(pos, payloadEnd, 'TRACK_STATUS_OK');
        return { type: 'REQUEST_OK', requestId, parameters };
      }

      case D14.SUBSCRIBE_NAMESPACE_OK: {
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        this.assertConsumed(pos, payloadEnd, 'SUBSCRIBE_NAMESPACE_OK');
        return { type: 'REQUEST_OK', requestId, parameters: new Map() };
      }

      // ── Fetch ──
      case D14.FETCH: {
        // Draft-14 §9.16: inline Priority, GroupOrder before FetchType
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const priority = buf[pos++]!;
        const groupOrder = buf[pos++]!;
        const { value: fetchTypeVal, bytesRead: ftBytes } = readVarint(buf, pos);
        pos += ftBytes;

        let fetch: Fetch['fetch'];
        if (fetchTypeVal === 0x1n) {
          const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
          pos += nsBytes;
          const { value: trackName, bytesRead: tnBytes } = readLengthPrefixedBytes(buf, pos);
          pos += tnBytes;
          const { value: startLocation, bytesRead: slBytes } = readLocation(buf, pos);
          pos += slBytes;
          const { value: endLocation, bytesRead: elBytes } = readLocation(buf, pos);
          pos += elBytes;
          fetch = { fetchType: 0x1, trackNamespace, trackName, startLocation, endLocation };
        } else if (fetchTypeVal === 0x2n || fetchTypeVal === 0x3n) {
          const { value: joiningRequestId, bytesRead: jBytes } = readVarint(buf, pos);
          pos += jBytes;
          const { value: joiningStart, bytesRead: jsBytes } = readVarint(buf, pos);
          pos += jsBytes;
          fetch = { fetchType: Number(fetchTypeVal) as 0x2 | 0x3, joiningRequestId, joiningStart };
        } else {
          throw new ProtocolViolationError(`Invalid Fetch Type: 0x${fetchTypeVal.toString(16)}`);
        }

        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;

        // Normalize inline fields → parameters
        parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [varint(priority)]);
        parameters.set(MessageParam.GROUP_ORDER, [varint(groupOrder)]);

        this.assertConsumed(pos, payloadEnd, 'FETCH');
        return { type: 'FETCH', requestId, fetch, parameters };
      }

      case D14.FETCH_OK: {
        // Draft-14 §9.17: inline GroupOrder
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const groupOrder = buf[pos++]!;
        const { value: endOfTrack } = readUint8(buf, pos);
        pos += 1;
        const { value: endLocation, bytesRead: elBytes } = readLocation(buf, pos);
        pos += elBytes;
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;

        parameters.set(MessageParam.GROUP_ORDER, [varint(groupOrder)]);

        this.assertConsumed(pos, payloadEnd, 'FETCH_OK');
        // No trackExtensions in draft-14
        const trackExtensions: TrackExtensions = new Map();
        return { type: 'FETCH_OK', requestId, endOfTrack, endLocation, parameters, trackExtensions };
      }

      case D14.FETCH_CANCEL: {
        const { value: requestId, bytesRead } = readVarint(buf, pos);
        pos += bytesRead;
        this.assertConsumed(pos, payloadEnd, 'FETCH_CANCEL');
        return { type: 'FETCH_CANCEL', requestId };
      }

      // ── Namespace ──
      case D14.PUBLISH_NAMESPACE: {
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        validateTrackNamespace(trackNamespace);
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_NAMESPACE');
        return { type: 'PUBLISH_NAMESPACE', requestId, trackNamespace, parameters };
      }

      case D14.PUBLISH_NAMESPACE_OK: {
        const { value: requestId, bytesRead } = readVarint(buf, pos);
        pos += bytesRead;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_NAMESPACE_OK');
        return { type: 'PUBLISH_NAMESPACE_OK', requestId };
      }

      case D14.PUBLISH_NAMESPACE_ERROR: {
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: errorCode, bytesRead: ecBytes } = readVarint(buf, pos);
        pos += ecBytes;
        const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
        pos += erBytes;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_NAMESPACE_ERROR');
        return { type: 'PUBLISH_NAMESPACE_ERROR', requestId, errorCode, errorReason };
      }

      case D14.PUBLISH_NAMESPACE_DONE: {
        // Draft-14 §9.26: Track Namespace (tuple), NOT requestId
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_NAMESPACE_DONE');
        return { type: 'PUBLISH_NAMESPACE_DONE', trackNamespace };
      }

      case D14.PUBLISH_NAMESPACE_CANCEL: {
        // Draft-14 §9.27: Track Namespace (tuple), Error Code, Error Reason
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        const { value: errorCode, bytesRead: ecBytes } = readVarint(buf, pos);
        pos += ecBytes;
        const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
        pos += erBytes;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_NAMESPACE_CANCEL');
        return { type: 'PUBLISH_NAMESPACE_CANCEL', trackNamespace, errorCode, errorReason };
      }

      case D14.SUBSCRIBE_NAMESPACE: {
        // Draft-14 §9.28: no subscribeOptions
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: trackNamespacePrefix, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        validateTrackNamespacePrefix(trackNamespacePrefix);
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;
        this.assertConsumed(pos, payloadEnd, 'SUBSCRIBE_NAMESPACE');
        return { type: 'SUBSCRIBE_NAMESPACE', requestId, trackNamespacePrefix, parameters };
      }

      case D14.UNSUBSCRIBE_NAMESPACE: {
        const { value: trackNamespacePrefix, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        this.assertConsumed(pos, payloadEnd, 'UNSUBSCRIBE_NAMESPACE');
        return { type: 'UNSUBSCRIBE_NAMESPACE', trackNamespacePrefix };
      }

      // ── Track Status ──
      case D14.TRACK_STATUS: {
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        const { value: trackName, bytesRead: tnBytes } = readLengthPrefixedBytes(buf, pos);
        pos += tnBytes;
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;
        this.assertConsumed(pos, payloadEnd, 'TRACK_STATUS');
        return { type: 'TRACK_STATUS', requestId, trackNamespace, trackName, parameters };
      }

      // ── Session messages ──
      case D14.PUBLISH_DONE: {
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: statusCode, bytesRead: scBytes } = readVarint(buf, pos);
        pos += scBytes;
        const { value: streamCount, bytesRead: stBytes } = readVarint(buf, pos);
        pos += stBytes;
        const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
        pos += erBytes;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_DONE');
        return { type: 'PUBLISH_DONE', requestId, statusCode, streamCount, errorReason };
      }

      case D14.GOAWAY: {
        const { value: uriLen, bytesRead: ulBytes } = readVarint(buf, pos);
        pos += ulBytes;
        const uriBytes = buf.slice(pos, pos + Number(uriLen));
        pos += Number(uriLen);
        const newSessionUri = new TextDecoder().decode(uriBytes);
        this.assertConsumed(pos, payloadEnd, 'GOAWAY');
        return { type: 'GOAWAY', newSessionUri };
      }

      case D14.MAX_REQUEST_ID: {
        const { value: maxRequestId, bytesRead } = readVarint(buf, pos);
        pos += bytesRead;
        this.assertConsumed(pos, payloadEnd, 'MAX_REQUEST_ID');
        return { type: 'MAX_REQUEST_ID', maxRequestId };
      }

      case D14.REQUESTS_BLOCKED: {
        const { value: maximumRequestId, bytesRead } = readVarint(buf, pos);
        pos += bytesRead;
        this.assertConsumed(pos, payloadEnd, 'REQUESTS_BLOCKED');
        return { type: 'REQUESTS_BLOCKED', maximumRequestId };
      }

      case D14.UNSUBSCRIBE: {
        const { value: requestId, bytesRead } = readVarint(buf, pos);
        pos += bytesRead;
        this.assertConsumed(pos, payloadEnd, 'UNSUBSCRIBE');
        return { type: 'UNSUBSCRIBE', requestId };
      }

      // ── Publish (subscriber receives from publisher) ──
      case D14.PUBLISH: {
        // Draft-14 §9.13: PUBLISH { Request ID, Track Namespace, Track Name,
        //   Track Alias, Group Order (8), Content Exists (8), [Largest Location],
        //   Forward (8), Parameters }
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: trackNamespace, bytesRead: nsBytes } = readTuple(buf, pos);
        pos += nsBytes;
        const { value: trackName, bytesRead: tnBytes } = readLengthPrefixedBytes(buf, pos);
        pos += tnBytes;
        const { value: trackAlias, bytesRead: taBytes } = readVarint(buf, pos);
        pos += taBytes;
        const pubGroupOrder = buf[pos++]!;
        const contentExists = buf[pos++]!;
        if (contentExists !== 0 && contentExists !== 1) {
          throw new ProtocolViolationError(
            `PUBLISH Content Exists must be 0 or 1, got ${contentExists}`,
          );
        }
        if (contentExists === 1) {
          const { bytesRead: llBytes } = readLocation(buf, pos);
          pos += llBytes;
        }
        const pubForward = buf[pos++]!;
        const { value: pubParams, bytesRead: ppBytes } = this.readParams(buf, pos);
        pos += ppBytes;

        pubParams.set(MessageParam.GROUP_ORDER, [varint(pubGroupOrder)]);
        pubParams.set(MessageParam.FORWARD, [varint(pubForward)]);

        this.assertConsumed(pos, payloadEnd, 'PUBLISH');
        // No trackExtensions in draft-14
        const pubTrackExtensions: TrackExtensions = new Map();
        return {
          type: 'PUBLISH', requestId, trackNamespace, trackName,
          trackAlias, parameters: pubParams, trackExtensions: pubTrackExtensions,
        };
      }

      case D14.PUBLISH_ERROR: {
        // Draft-14 §9.15: PUBLISH_ERROR { Request ID, Error Code, Error Reason }
        // Normalized to REQUEST_ERROR
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: errorCode, bytesRead: ecBytes } = readVarint(buf, pos);
        pos += ecBytes;
        const { value: errorReason, bytesRead: erBytes } = readReasonPhrase(buf, pos);
        pos += erBytes;
        this.assertConsumed(pos, payloadEnd, 'PUBLISH_ERROR');
        return {
          type: 'REQUEST_ERROR',
          requestId,
          errorCode,
          retryInterval: varint(0),
          errorReason,
        };
      }

      case D14.SUBSCRIBE_UPDATE: {
        // Draft-14 §9.10: SUBSCRIBE_UPDATE → normalized to REQUEST_UPDATE
        const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
        pos += ridBytes;
        const { value: existingRequestId, bytesRead: sridBytes } = readVarint(buf, pos);
        pos += sridBytes;
        const { value: startLoc, bytesRead: slBytes } = readLocation(buf, pos);
        pos += slBytes;
        const { value: endGroupVal, bytesRead: egBytes } = readVarint(buf, pos);
        pos += egBytes;
        const subPriority = buf[pos++]!;
        const subForward = buf[pos++]!;
        const { value: parameters, bytesRead: pBytes } = this.readParams(buf, pos);
        pos += pBytes;

        // Normalize inline fields → parameters
        parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [varint(subPriority)]);
        parameters.set(MessageParam.FORWARD, [varint(subForward)]);

        // Draft-14 §9.10: "End Group: The end Group ID, plus 1.
        // A value of 0 means the subscription is open-ended."
        // Normalize wire value → logical: logical = wire - 1 (wire > 0)
        const logicalEndGroup = endGroupVal > 0n ? varint((endGroupVal as bigint) - 1n) : varint(0);

        // Encode filter as SUBSCRIPTION_FILTER bytes (draft-16 format)
        // so the session state machine sees a uniform parameter
        if (endGroupVal > 0n) {
          // AbsoluteRange: start + end
          const filterBuf = new Uint8Array(
            varintEncodingLength(varint(0x4)) +
            locationEncodingLength(startLoc) +
            varintEncodingLength(logicalEndGroup),
          );
          let fPos = writeVarint(varint(0x4), filterBuf, 0);
          fPos += writeLocation(startLoc, filterBuf, fPos);
          writeVarint(logicalEndGroup, filterBuf, fPos);
          parameters.set(MessageParam.SUBSCRIPTION_FILTER, [filterBuf]);
        } else if (startLoc.group > 0n || startLoc.object > 0n) {
          // AbsoluteStart: start only
          const filterBuf = new Uint8Array(
            varintEncodingLength(varint(0x3)) +
            locationEncodingLength(startLoc),
          );
          let fPos = writeVarint(varint(0x3), filterBuf, 0);
          writeLocation(startLoc, filterBuf, fPos);
          parameters.set(MessageParam.SUBSCRIPTION_FILTER, [filterBuf]);
        }
        // If start=0,0 and endGroup=0, no filter needed (open-ended)

        this.assertConsumed(pos, payloadEnd, 'SUBSCRIBE_UPDATE');
        return { type: 'REQUEST_UPDATE', requestId, existingRequestId, parameters };
      }

      // ── PUBLISH_OK (subscriber acknowledges a publisher's PUBLISH) ──
      case D14.PUBLISH_OK: {
        // Draft-14 §9.14: PUBLISH_OK {
        //   Request ID (i),
        //   Forward (8),
        //   Subscriber Priority (8),
        //   Group Order (8),
        //   Filter Type (i),
        //   [Start Location (Location)],
        //   [End Group (i)],
        //   Number of Parameters (i),
        //   Parameters (..) ...
        // }
        // Mirrors encodePublishOk — see there for the wire-format reference.
        const { value: pubOkRequestId, bytesRead: poRidBytes } = readVarint(buf, pos);
        pos += poRidBytes;
        const poForward = buf[pos++]!;
        const poPriority = buf[pos++]!;
        const poGroupOrder = buf[pos++]!;
        const { value: poFilterType, bytesRead: poFtBytes } = readVarint(buf, pos);
        pos += poFtBytes;

        let poStartLoc: Location | undefined;
        let poEndGroup: Varint | undefined;
        if (poFilterType === 0x3n || poFilterType === 0x4n) {
          const { value: sl, bytesRead: slBytes } = readLocation(buf, pos);
          pos += slBytes;
          poStartLoc = sl;
        }
        if (poFilterType === 0x4n) {
          const { value: eg, bytesRead: egBytes } = readVarint(buf, pos);
          pos += egBytes;
          poEndGroup = eg;
        }

        const { value: poParams, bytesRead: poPBytes } = this.readParams(buf, pos);
        pos += poPBytes;

        // Normalize inline fields → parameters (same shape as SUBSCRIBE_OK
        // / FETCH_OK produce on decode).
        poParams.set(MessageParam.FORWARD, [varint(poForward)]);
        poParams.set(MessageParam.SUBSCRIBER_PRIORITY, [varint(poPriority)]);
        poParams.set(MessageParam.GROUP_ORDER, [varint(poGroupOrder)]);
        const poFilterBytes = this.encodeFilterBytes(varint(poFilterType), poStartLoc, poEndGroup);
        poParams.set(MessageParam.SUBSCRIPTION_FILTER, [poFilterBytes]);

        this.assertConsumed(pos, payloadEnd, 'PUBLISH_OK');
        return { type: 'PUBLISH_OK', requestId: pubOkRequestId, parameters: poParams };
      }

      default:
        throw new ProtocolViolationError(`Unknown draft-14 message type: 0x${typeNum.toString(16)}`);
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────

  private readParams(buf: Uint8Array, offset: number): { value: Parameters; bytesRead: number } {
    let pos = offset;
    const { value: count, bytesRead: countBytes } = readVarint(buf, pos);
    pos += countBytes;
    const { value, bytesRead: kvpBytes } = readKvpListAbsolute(buf, pos, Number(count));
    pos += kvpBytes;
    return { value, bytesRead: pos - offset };
  }

  private assertConsumed(pos: number, payloadEnd: number, msgName: string): void {
    if (pos !== payloadEnd) {
      throw new RangeError(
        `Payload not fully consumed for ${msgName}: consumed ${pos} bytes, expected ${payloadEnd}`,
      );
    }
  }

  /** Extract a varint value from params, or return undefined if absent. */
  private extractParamVarint(params: Parameters, key: Varint): Varint | undefined {
    const values = params.get(key);
    if (!values || values.length === 0) return undefined;
    return values[0] as Varint;
  }

  /**
   * Encode filter fields as SUBSCRIPTION_FILTER bytes (draft-16 wire format).
   * FilterType (i), [StartGroup (i), StartObject (i)], [EndGroup (i)]
   */
  private encodeFilterBytes(
    filterType: Varint,
    startLocation?: Location,
    endGroup?: Varint,
  ): Uint8Array {
    let size = varintEncodingLength(filterType);
    if (startLocation) {
      size += locationEncodingLength(startLocation);
    }
    if (endGroup !== undefined) {
      size += varintEncodingLength(endGroup);
    }
    const buf = new Uint8Array(size);
    let off = writeVarint(filterType, buf, 0);
    if (startLocation) {
      off += writeLocation(startLocation, buf, off);
    }
    if (endGroup !== undefined) {
      writeVarint(endGroup, buf, off);
    }
    return buf;
  }

  /** Clone a parameters map, removing specified keys. */
  private cloneParamsWithout(params: Parameters, keysToRemove: Varint[]): Parameters {
    const result: Parameters = new Map();
    const removeSet = new Set(keysToRemove.map(k => k as bigint));
    for (const [key, values] of params) {
      if (!removeSet.has(key)) {
        result.set(key, values);
      }
    }
    return result;
  }

  /**
   * Extract and parse SUBSCRIPTION_FILTER from parameters.
   *
   * In draft-16, SUBSCRIPTION_FILTER (type 0x21, odd = bytes) carries:
   *   FilterType (i), [StartGroup (i), StartObject (i)], [EndGroup (i)]
   *
   * Returns parsed filter fields for inline encoding in draft-14 wire format.
   *
   * @see draft-ietf-moq-transport-16 §5.1.2, §9.2.2.5
   * @see draft-ietf-moq-transport-14 §9.7 (inline filter fields)
   */
  private extractFilter(params: Parameters): {
    filterType: Varint;
    startLocation?: Location;
    endGroup?: Varint;
  } {
    const values = params.get(MessageParam.SUBSCRIPTION_FILTER);
    if (!values || values.length === 0) {
      // Default: NextGroupStart (0x1) — no Start/End fields
      return { filterType: varint(0x1) };
    }

    const val = values[0]!;
    if (typeof val === 'bigint') {
      // Legacy: raw varint filter type (no location data)
      return { filterType: val as Varint };
    }

    // Parse bytes: FilterType (i), [StartGroup (i), StartObject (i)], [EndGroup (i)]
    const bytes = val as Uint8Array;
    let pos = 0;
    const { value: filterType, bytesRead: ftBytes } = readVarint(bytes, pos);
    pos += ftBytes;

    let startLocation: Location | undefined;
    let endGroup: Varint | undefined;

    if (filterType === 0x3n || filterType === 0x4n) {
      // AbsoluteStart or AbsoluteRange: read Start Location
      const { value: startLoc, bytesRead: slBytes } = readLocation(bytes, pos);
      pos += slBytes;
      startLocation = startLoc;
    }
    if (filterType === 0x4n) {
      // AbsoluteRange: read End Group
      const { value: eg, bytesRead: egBytes } = readVarint(bytes, pos);
      pos += egBytes;
      endGroup = eg;
    }

    const result: { filterType: Varint; startLocation?: Location; endGroup?: Varint } = {
      filterType: varint(filterType),
    };
    if (startLocation !== undefined) result.startLocation = startLocation;
    if (endGroup !== undefined) result.endGroup = endGroup;
    return result;
  }

  /**
   * Encode REQUEST_UPDATE as draft-14 SUBSCRIBE_UPDATE (type 0x2).
   *
   * Draft-14 §9.10:
   *   SUBSCRIBE_UPDATE {
   *     Type (i) = 0x2, Length (16),
   *     Request ID (i), Subscription Request ID (i),
   *     Start Location (Location), End Group (i),
   *     Subscriber Priority (8), Forward (8),
   *     Number of Parameters (i), Parameters (..) ...
   *   }
   *
   * @see draft-ietf-moq-transport-14 §9.10
   */
  private encodeSubscribeUpdate(msg: RequestUpdate): Uint8Array {
    const priority = Number(this.extractParamVarint(msg.parameters, MessageParam.SUBSCRIBER_PRIORITY) ?? 128n);
    const forward = Number(this.extractParamVarint(msg.parameters, MessageParam.FORWARD) ?? 1n);
    this.assertUint8(priority, 'SUBSCRIBER_PRIORITY', 'SUBSCRIBE_UPDATE');
    this.assertUint8(forward, 'FORWARD', 'SUBSCRIBE_UPDATE');
    const filter = this.extractFilter(msg.parameters);

    // Draft-14 §9.10: Start Location is always present (default to 0,0 if not specified)
    const startLocation: Location = filter.startLocation ?? { group: varint(0), object: varint(0) };
    // Draft-14 §9.10: "End Group: The end Group ID, plus 1.
    // A value of 0 means the subscription is open-ended."
    // Wire value = logical + 1 for non-zero, 0 for open-ended.
    const logicalEndGroup = filter.endGroup ?? varint(0);
    const wireEndGroup: Varint = logicalEndGroup === 0n
      ? varint(0)
      : varint((logicalEndGroup as bigint) + 1n);

    const remainingParams = this.cloneParamsWithout(msg.parameters, [
      MessageParam.SUBSCRIBER_PRIORITY,
      MessageParam.FORWARD,
      MessageParam.SUBSCRIPTION_FILTER,
    ]);

    const payloadLen =
      varintEncodingLength(msg.requestId) +
      varintEncodingLength(msg.existingRequestId) +
      locationEncodingLength(startLocation) +
      varintEncodingLength(wireEndGroup) +
      1 + // Subscriber Priority (8)
      1 + // Forward (8)
      this.paramsLength(remainingParams);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeVarint(msg.existingRequestId, payload, pos);
    pos += writeLocation(startLocation, payload, pos);
    pos += writeVarint(wireEndGroup, payload, pos);
    payload[pos++] = priority & 0xff;
    payload[pos++] = forward & 0xff;
    pos += this.writeParams(remainingParams, payload, pos);

    return this.frame16(D14.SUBSCRIBE_UPDATE, payload);
  }

  /**
   * Frame with varint length (for PUBLISH, PUBLISH_OK, PUBLISH_ERROR).
   * @see draft-ietf-moq-transport-14 §9.13, §9.14, §9.15
   */
  private frameVarint(typeCode: number, payload: Uint8Array): Uint8Array {
    const typeVarint = varint(typeCode);
    const typeLen = varintEncodingLength(typeVarint);
    const payloadLenVarint = varint(payload.length);
    const payloadLenLen = varintEncodingLength(payloadLenVarint);
    const total = typeLen + payloadLenLen + payload.length;
    const buf = new Uint8Array(total);
    let pos = 0;
    pos += writeVarint(typeVarint, buf, pos);
    pos += writeVarint(payloadLenVarint, buf, pos);
    buf.set(payload, pos);
    return buf;
  }

  /**
   * Encode PUBLISH_OK.
   *
   * Draft-14 §9.14:
   *   PUBLISH_OK {
   *     Type (i) = 0x1E,
   *     Length (i),
   *     Request ID (i),
   *     Forward (8),
   *     Subscriber Priority (8),
   *     Group Order (8),
   *     Filter Type (i),
   *     [Start Location (Location)],
   *     [End Group (i)],
   *     Number of Parameters (i),
   *     Parameters (..) ...
   *   }
   *
   * @see draft-ietf-moq-transport-14 §9.14
   */
  private encodePublishOk(msg: PublishOk): Uint8Array {
    const forward = Number(this.extractParamVarint(msg.parameters, MessageParam.FORWARD) ?? 1n);
    const subscriberPriority = Number(this.extractParamVarint(msg.parameters, MessageParam.SUBSCRIBER_PRIORITY) ?? 128n);
    // Draft-14 §9.14: GROUP_ORDER must be 0x1 (Ascending) or 0x2 (Descending); 0x0 is a protocol error.
    const groupOrder = Number(this.extractParamVarint(msg.parameters, MessageParam.GROUP_ORDER) ?? 1n);
    this.assertUint8(forward, 'FORWARD', 'PUBLISH_OK');
    this.assertUint8(subscriberPriority, 'SUBSCRIBER_PRIORITY', 'PUBLISH_OK');
    this.assertUint8(groupOrder, 'GROUP_ORDER', 'PUBLISH_OK');

    // Extract filter from parameters or default to NextGroupStart (0x1)
    const filterResult = this.extractFilter(msg.parameters);
    const filterType = filterResult.filterType;

    // Build remaining params (exclude inline fields)
    const remainingParams = new Map(msg.parameters);
    remainingParams.delete(varint(MessageParam.FORWARD));
    remainingParams.delete(varint(MessageParam.SUBSCRIBER_PRIORITY));
    remainingParams.delete(varint(MessageParam.GROUP_ORDER));
    remainingParams.delete(varint(MessageParam.SUBSCRIPTION_FILTER));

    // Calculate filter-dependent fields length
    let filterFieldsLen = varintEncodingLength(filterType); // Filter Type
    if (filterResult.startLocation) {
      filterFieldsLen += locationEncodingLength(filterResult.startLocation);
    }
    if (filterResult.endGroup !== undefined) {
      filterFieldsLen += varintEncodingLength(filterResult.endGroup);
    }

    const payloadLen =
      varintEncodingLength(msg.requestId) +
      1 + // Forward (8)
      1 + // Subscriber Priority (8)
      1 + // Group Order (8)
      filterFieldsLen +
      this.paramsLength(remainingParams);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    payload[pos++] = forward & 0xff;
    payload[pos++] = subscriberPriority & 0xff;
    payload[pos++] = groupOrder & 0xff;
    pos += writeVarint(filterType, payload, pos);
    if (filterResult.startLocation) {
      pos += writeLocation(filterResult.startLocation, payload, pos);
    }
    if (filterResult.endGroup !== undefined) {
      pos += writeVarint(filterResult.endGroup, payload, pos);
    }
    pos += this.writeParams(remainingParams, payload, pos);

    return this.frameVarint(D14.PUBLISH_OK, payload);
  }

  /**
   * Encode PUBLISH_ERROR.
   *
   * Draft-14 §9.15:
   *   PUBLISH_ERROR {
   *     Type (i) = 0x1F,
   *     Length (i),
   *     Request ID (i),
   *     Error Code (i),
   *     Error Reason (Reason Phrase)
   *   }
   *
   * @see draft-ietf-moq-transport-14 §9.15
   */
  private encodePublishError(msg: PublishError): Uint8Array {
    const payloadLen =
      varintEncodingLength(msg.requestId) +
      varintEncodingLength(msg.errorCode) +
      reasonPhraseEncodingLength(msg.errorReason);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeVarint(msg.errorCode, payload, pos);
    pos += writeReasonPhrase(msg.errorReason, payload, pos);

    return this.frameVarint(D14.PUBLISH_ERROR, payload);
  }

  /**
   * Encode SUBSCRIBE_OK.
   *
   * Draft-14 §9.8:
   *   SUBSCRIBE_OK {
   *     Type (i) = 0x04,
   *     Length (16),
   *     Request ID (i),
   *     Track Alias (i),
   *     Expires (i),
   *     Group Order (8),
   *     Content Exists (8),
   *     [Largest Location],
   *     Number of Parameters (i),
   *     Parameters (..) ...
   *   }
   *
   * @see draft-ietf-moq-transport-14 §9.8
   */
  private encodeSubscribeOk(msg: SubscribeOk): Uint8Array {
    // Extract inline fields from normalized parameters
    const groupOrder = Number(msg.parameters.get(MessageParam.GROUP_ORDER)?.[0] ?? 1n);
    const expiresRaw = msg.parameters.get(MessageParam.EXPIRES)?.[0];
    const expires = typeof expiresRaw === 'bigint' ? varint(expiresRaw) : varint(0n);
    const largestObjectBytes = msg.parameters.get(MessageParam.LARGEST_OBJECT)?.[0];
    const contentExists = largestObjectBytes !== undefined ? 1 : 0;

    // Build remaining params (strip inline fields)
    const remainingParams: Parameters = new Map();
    for (const [key, values] of msg.parameters) {
      if (
        key === MessageParam.GROUP_ORDER ||
        key === MessageParam.EXPIRES ||
        key === MessageParam.LARGEST_OBJECT
      ) continue;
      remainingParams.set(key, values);
    }

    // Calculate payload size
    let payloadLen =
      varintEncodingLength(msg.requestId) +
      varintEncodingLength(msg.trackAlias) +
      varintEncodingLength(expires) +
      1 + // Group Order (8)
      1;  // Content Exists (8)

    if (contentExists === 1 && largestObjectBytes instanceof Uint8Array) {
      payloadLen += largestObjectBytes.byteLength;
    }

    // Params size: count varint + each param
    const paramsCountLen = varintEncodingLength(varint(BigInt(remainingParams.size)));
    let paramsTotalLen = paramsCountLen;
    for (const [key, values] of remainingParams) {
      for (const val of values) {
        paramsTotalLen += varintEncodingLength(key);
        if (typeof val === 'bigint') {
          paramsTotalLen += varintEncodingLength(varint(varintEncodingLength(val)));
          paramsTotalLen += varintEncodingLength(val);
        } else if (val instanceof Uint8Array) {
          paramsTotalLen += varintEncodingLength(varint(BigInt(val.byteLength)));
          paramsTotalLen += val.byteLength;
        } else {
          throw new ProtocolViolationError(
            'Location-valued parameter cannot be encoded as draft-14 KVP',
          );
        }
      }
    }
    payloadLen += paramsTotalLen;

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeVarint(msg.trackAlias, payload, pos);
    pos += writeVarint(expires, payload, pos);
    payload[pos++] = groupOrder & 0xFF;
    payload[pos++] = contentExists;

    if (contentExists === 1 && largestObjectBytes instanceof Uint8Array) {
      payload.set(largestObjectBytes, pos);
      pos += largestObjectBytes.byteLength;
    }

    pos += this.writeParams(remainingParams, payload, pos);

    return this.frame16(D14.SUBSCRIBE_OK, payload);
  }

  /**
   * Encode PUBLISH_DONE.
   *
   * Draft-14 §9.11:
   *   PUBLISH_DONE {
   *     Type (i) = 0x0B,
   *     Length (16),
   *     Request ID (i),
   *     Status Code (i),
   *     Stream Count (i),
   *     Error Reason (Reason Phrase)
   *   }
   *
   * @see draft-ietf-moq-transport-14 §9.11
   */
  private encodePublishDone(msg: PublishDone): Uint8Array {
    const payloadLen =
      varintEncodingLength(msg.requestId) +
      varintEncodingLength(msg.statusCode) +
      varintEncodingLength(msg.streamCount) +
      reasonPhraseEncodingLength(msg.errorReason);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(msg.requestId, payload, pos);
    pos += writeVarint(msg.statusCode, payload, pos);
    pos += writeVarint(msg.streamCount, payload, pos);
    pos += writeReasonPhrase(msg.errorReason, payload, pos);

    return this.frame16(D14.PUBLISH_DONE, payload);
  }
}
