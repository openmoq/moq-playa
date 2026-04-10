/**
 * ControlCodec interface — version-aware control message encoding/decoding.
 *
 * Abstracts the wire format differences between draft versions (14, 16, etc.)
 * so the session state machine and framer can remain version-agnostic.
 *
 * Both drafts share the same framing structure:
 *   MOQT Control Message { Message Type (i), Message Length (16), Message Payload (..) }
 *
 * @see draft-ietf-moq-transport-16 §9
 * @see draft-ietf-moq-transport-14 §9
 * @module
 */

import type { ControlMessage } from './messages.js';

export type DraftVersion = 14 | 16;

export interface ControlCodec {
  readonly version: DraftVersion;

  /** Encode a ControlMessage to its framed wire representation. */
  encode(msg: ControlMessage): Uint8Array;

  /** Decode a framed wire message starting at offset. */
  decode(buf: Uint8Array, offset: number): { message: ControlMessage; bytesRead: number };

  /**
   * Peek at the buffer to determine the total frame size, or undefined
   * if not enough bytes are available.
   *
   * Frame: Message Type (varint) + Message Length (uint16 BE) + Payload
   */
  peekFrameSize(buf: Uint8Array): number | undefined;
}

/**
 * Create a ControlCodec for the given draft version.
 * @param version Draft version (default: 16)
 */
export function createControlCodec(version: DraftVersion = 16): ControlCodec {
  switch (version) {
    case 16:
      return new Draft16Codec();
    case 14:
      return new Draft14Codec();
  }
}

// ─── Draft16Codec ──────────────────────────────────────────────────────

import { encodeControlMessage } from './encoder.js';
import { decodeControlMessage } from './decoder.js';
import { Draft14Codec } from './draft14-codec.js';

/**
 * Draft-16 codec — thin wrapper around existing encode/decode functions.
 *
 * @see draft-ietf-moq-transport-16 §9
 */
class Draft16Codec implements ControlCodec {
  readonly version = 16 as const;

  encode(msg: ControlMessage): Uint8Array {
    return encodeControlMessage(msg);
  }

  decode(buf: Uint8Array, offset: number): { message: ControlMessage; bytesRead: number } {
    return decodeControlMessage(buf, offset);
  }

  /**
   * Peek at the buffer to determine total frame size.
   *
   * Draft-16 §9: Message Type (i) + Message Length (16) + Payload
   * The uint16 length field tells us the payload size.
   */
  peekFrameSize(buf: Uint8Array): number | undefined {
    if (buf.length === 0) return undefined;

    // Determine varint length from first byte's top 2 bits (RFC 9000 §16)
    const first = buf[0]!;
    const lengthFlag = first >> 6;
    const typeVarintLen = (1 << lengthFlag) as 1 | 2 | 4 | 8;

    // Need type varint + 2 bytes for uint16 length
    const headerLen = typeVarintLen + 2;
    if (buf.length < headerLen) return undefined;

    // Read uint16 length (big-endian) after the type varint
    const payloadLen = (buf[typeVarintLen]! << 8) | buf[typeVarintLen + 1]!;

    return headerLen + payloadLen;
  }
}
