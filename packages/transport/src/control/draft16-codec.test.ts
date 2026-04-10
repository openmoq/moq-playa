/**
 * Draft16Codec tests.
 *
 * Verifies the Draft16Codec wrapper produces identical output to the
 * existing encodeControlMessage() and decodeControlMessage() functions.
 *
 * Also tests peekFrameSize() extracted from ControlStreamFramer.
 *
 * @see draft-ietf-moq-transport-16 §9
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import { encodeControlMessage } from './encoder.js';
import { decodeControlMessage } from './decoder.js';
import type { ControlMessage } from './messages.js';
import { varint } from '../primitives/varint.js';

describe('Draft16Codec', () => {
  const codec = createControlCodec(16);

  it('reports version 16', () => {
    expect(codec.version).toBe(16);
  });

  it('createControlCodec() defaults to version 16', () => {
    const defaultCodec = createControlCodec();
    expect(defaultCodec.version).toBe(16);
  });

  it('encode produces identical bytes to encodeControlMessage()', () => {
    const msg: ControlMessage = {
      type: 'GOAWAY',
      newSessionUri: 'https://example.com/new',
    };
    const direct = encodeControlMessage(msg);
    const viaCodec = codec.encode(msg);
    expect(viaCodec).toEqual(direct);
  });

  it('decode produces identical message to decodeControlMessage()', () => {
    const msg: ControlMessage = {
      type: 'MAX_REQUEST_ID',
      maxRequestId: varint(42),
    };
    const bytes = encodeControlMessage(msg);
    const directResult = decodeControlMessage(bytes, 0);
    const codecResult = codec.decode(bytes, 0);
    expect(codecResult.message).toEqual(directResult.message);
    expect(codecResult.bytesRead).toBe(directResult.bytesRead);
  });

  it('round-trips a SUBSCRIBE message through encode/decode', () => {
    const enc = new TextEncoder();
    const msg: ControlMessage = {
      type: 'SUBSCRIBE',
      requestId: varint(1),
      trackNamespace: [enc.encode('live')],
      trackName: enc.encode('video'),
      parameters: new Map(),
    };
    const bytes = codec.encode(msg);
    const { message } = codec.decode(bytes, 0);
    expect(message).toEqual(msg);
  });
});

describe('Draft16Codec.peekFrameSize', () => {
  const codec = createControlCodec(16);

  it('returns undefined for empty buffer', () => {
    expect(codec.peekFrameSize(new Uint8Array(0))).toBeUndefined();
  });

  it('returns undefined when buffer is too short for header', () => {
    // 1-byte type varint + 2 bytes uint16 = 3 bytes minimum
    expect(codec.peekFrameSize(new Uint8Array([0x01]))).toBeUndefined();
    expect(codec.peekFrameSize(new Uint8Array([0x01, 0x00]))).toBeUndefined();
  });

  it('returns correct frame size for a complete message', () => {
    const msg: ControlMessage = {
      type: 'MAX_REQUEST_ID',
      maxRequestId: varint(42),
    };
    const bytes = encodeControlMessage(msg);
    const frameSize = codec.peekFrameSize(bytes);
    expect(frameSize).toBe(bytes.length);
  });

  it('returns correct frame size when buffer has trailing bytes', () => {
    const msg: ControlMessage = {
      type: 'MAX_REQUEST_ID',
      maxRequestId: varint(42),
    };
    const bytes = encodeControlMessage(msg);
    // Append extra trailing bytes
    const extended = new Uint8Array(bytes.length + 10);
    extended.set(bytes, 0);
    const frameSize = codec.peekFrameSize(extended);
    expect(frameSize).toBe(bytes.length);
  });

  it('handles 2-byte type varint', () => {
    // A type varint whose first byte has bits 6-7 = 01 → 2-byte varint
    // MessageType values like SUBSCRIBE_NAMESPACE (0x11) have first byte 0x40|0x11 = 0x4011
    // Actually, varint 0x11 encodes as [0x11] (1-byte, top bits = 00)
    // For a 2-byte varint, we need value >= 64 (0x40)
    // Let's use a real encode: SUBSCRIBE_NAMESPACE is 0x11 which is 1-byte.
    // For 2-byte test, let's manually construct a buffer:
    // 2-byte varint: first byte = 0x40 | high6, second byte = low8
    // Value = (high6 << 8) | low8
    const buf = new Uint8Array([
      0x40, 0x80, // 2-byte varint type = 128
      0x00, 0x05, // uint16 length = 5
      0x00, 0x00, 0x00, 0x00, 0x00, // 5 payload bytes
    ]);
    expect(codec.peekFrameSize(buf)).toBe(2 + 2 + 5); // type(2) + length(2) + payload(5)
  });
});
