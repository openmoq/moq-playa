/**
 * Control stream framer tests.
 *
 * Verifies the push-based byte accumulator correctly extracts complete framed
 * control messages from arbitrary byte chunks.
 *
 * Wire format: Type (varint) + Length (uint16 BE) + Payload
 *
 * @see draft-ietf-moq-transport-16 §9
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ControlStreamFramer } from './framer.js';
import { encodeControlMessage } from '@moqt/transport';
import { varint } from '@moqt/transport';
import type { ClientSetup, Goaway, Subscribe, MaxRequestId } from '@moqt/transport';
import { SetupParam } from '@moqt/transport';

describe('ControlStreamFramer', () => {
  let framer: ControlStreamFramer;

  beforeEach(() => {
    framer = new ControlStreamFramer();
  });

  // ─── Helper: encode a control message to wire bytes ─────────────────

  function encodeMessage(msg: any): Uint8Array {
    return encodeControlMessage(msg);
  }

  // ─── Basic framing ──────────────────────────────────────────────────

  it('yields nothing when no data pushed', () => {
    const messages = framer.drain();
    expect(messages.length).toBe(0);
  });

  it('extracts a complete CLIENT_SETUP from a single push', () => {
    const setup: ClientSetup = {
      type: 'CLIENT_SETUP',
      parameters: new Map([
        [varint(0x02), [varint(10)]],
      ]),
    };
    const bytes = encodeMessage(setup);

    framer.push(bytes);
    const messages = framer.drain();

    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('CLIENT_SETUP');
  });

  it('extracts a complete GOAWAY from a single push', () => {
    const goaway: Goaway = {
      type: 'GOAWAY',
      newSessionUri: '',
    };
    const bytes = encodeMessage(goaway);

    framer.push(bytes);
    const messages = framer.drain();

    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('GOAWAY');
  });

  // ─── Chunked delivery ──────────────────────────────────────────────

  it('handles message split into single-byte chunks', () => {
    const setup: ClientSetup = {
      type: 'CLIENT_SETUP',
      parameters: new Map([
        [varint(0x02), [varint(10)]],
      ]),
    };
    const bytes = encodeMessage(setup);

    // Push one byte at a time
    for (let i = 0; i < bytes.length; i++) {
      framer.push(bytes.subarray(i, i + 1));
    }

    const messages = framer.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('CLIENT_SETUP');
  });

  it('handles message split at type/length boundary', () => {
    const goaway: Goaway = {
      type: 'GOAWAY',
      newSessionUri: '',
    };
    const bytes = encodeMessage(goaway);

    // Split after the type varint (1 byte for type 0x10 = GOAWAY)
    // Type 0x10 is a 1-byte varint (value < 64)
    framer.push(bytes.subarray(0, 1));

    let messages = framer.drain();
    expect(messages.length).toBe(0); // Not enough bytes yet

    framer.push(bytes.subarray(1));
    messages = framer.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('GOAWAY');
  });

  it('handles message split in the middle of payload', () => {
    const setup: ClientSetup = {
      type: 'CLIENT_SETUP',
      parameters: new Map([
        [varint(0x02), [varint(10)]],
      ]),
    };
    const bytes = encodeMessage(setup);

    // Split roughly in the middle
    const mid = Math.floor(bytes.length / 2);
    framer.push(bytes.subarray(0, mid));

    let messages = framer.drain();
    expect(messages.length).toBe(0);

    framer.push(bytes.subarray(mid));
    messages = framer.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('CLIENT_SETUP');
  });

  // ─── Multiple messages ──────────────────────────────────────────────

  it('extracts multiple messages from a single push', () => {
    const setup: ClientSetup = {
      type: 'CLIENT_SETUP',
      parameters: new Map([
        [varint(0x02), [varint(10)]],
      ]),
    };
    const goaway: Goaway = {
      type: 'GOAWAY',
      newSessionUri: '',
    };

    const setupBytes = encodeMessage(setup);
    const goawayBytes = encodeMessage(goaway);

    // Concatenate both messages
    const combined = new Uint8Array(setupBytes.length + goawayBytes.length);
    combined.set(setupBytes, 0);
    combined.set(goawayBytes, setupBytes.length);

    framer.push(combined);
    const messages = framer.drain();

    expect(messages.length).toBe(2);
    expect(messages[0]!.message.type).toBe('CLIENT_SETUP');
    expect(messages[1]!.message.type).toBe('GOAWAY');
  });

  it('extracts first message and buffers remainder', () => {
    const setup: ClientSetup = {
      type: 'CLIENT_SETUP',
      parameters: new Map([
        [varint(0x02), [varint(10)]],
      ]),
    };
    const goaway: Goaway = {
      type: 'GOAWAY',
      newSessionUri: '',
    };

    const setupBytes = encodeMessage(setup);
    const goawayBytes = encodeMessage(goaway);

    // Push setup + partial goaway
    const partial = new Uint8Array(setupBytes.length + 2);
    partial.set(setupBytes, 0);
    partial.set(goawayBytes.subarray(0, 2), setupBytes.length);

    framer.push(partial);
    let messages = framer.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('CLIENT_SETUP');

    // Push remainder of goaway
    framer.push(goawayBytes.subarray(2));
    messages = framer.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('GOAWAY');
  });

  // ─── Empty payload ──────────────────────────────────────────────────

  it('handles message with empty payload (length=0)', () => {
    // MAX_REQUEST_ID has a minimal payload
    const maxReqId: MaxRequestId = {
      type: 'MAX_REQUEST_ID',
      maxRequestId: varint(0),
    };
    const bytes = encodeMessage(maxReqId);

    framer.push(bytes);
    const messages = framer.drain();

    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('MAX_REQUEST_ID');
  });

  // ─── drain() clears buffer ─────────────────────────────────────────

  it('drain() clears extracted messages', () => {
    const goaway: Goaway = {
      type: 'GOAWAY',
      newSessionUri: '',
    };
    const bytes = encodeMessage(goaway);

    framer.push(bytes);
    const first = framer.drain();
    expect(first.length).toBe(1);

    const second = framer.drain();
    expect(second.length).toBe(0);
  });

  // ─── bytesRead tracking ────────────────────────────────────────────

  it('reports bytesRead for each decoded message', () => {
    const goaway: Goaway = {
      type: 'GOAWAY',
      newSessionUri: '',
    };
    const bytes = encodeMessage(goaway);

    framer.push(bytes);
    const messages = framer.drain();

    expect(messages.length).toBe(1);
    expect(messages[0]!.bytesRead).toBe(bytes.length);
  });

  // ─── Incremental drain ─────────────────────────────────────────────

  it('yields messages as they become complete across multiple push/drain cycles', () => {
    const goaway1: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const goaway2: Goaway = { type: 'GOAWAY', newSessionUri: 'https://new.example.com' };

    const bytes1 = encodeMessage(goaway1);
    const bytes2 = encodeMessage(goaway2);

    // Push first complete message
    framer.push(bytes1);
    let messages = framer.drain();
    expect(messages.length).toBe(1);

    // Push second complete message
    framer.push(bytes2);
    messages = framer.drain();
    expect(messages.length).toBe(1);
    expect((messages[0]!.message as Goaway).newSessionUri).toBe('https://new.example.com');
  });

  // ─── Decode error handling (§9 — MUST close on malformed frames) ──

  it('throws on unknown message type (§9)', () => {
    // §9: "An endpoint that receives an unknown message type MUST close
    //       the session."
    // Type 0x3E (62) is not a known message type. 1-byte varint (top 2 bits = 00).
    // Frame: type=0x3E, length=0x0002, payload=0xDEAD
    const malformed = new Uint8Array([0x3E, 0x00, 0x02, 0xDE, 0xAD]);

    framer.push(malformed);
    expect(() => framer.drain()).toThrow(/unknown message type/i);
  });

  it('throws on payload length mismatch (§9)', () => {
    // §9: "If the length does not match the length of the Message Payload,
    //       the receiver MUST close the session with a PROTOCOL_VIOLATION."
    // Encode a valid GOAWAY, then corrupt by extending the declared length
    // so the payload is shorter than declared.
    const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const bytes = encodeMessage(goaway);

    // The payload for GOAWAY with empty URI is just varint(0) = 1 byte.
    // Corrupt the length field to claim 10 bytes of payload instead.
    const corrupted = new Uint8Array(bytes);
    // Length field is at offset 1 (after 1-byte type varint), uint16 BE
    corrupted[1] = 0x00;
    corrupted[2] = 0x0A; // claim 10 bytes of payload

    // Pad with extra bytes so peekFrameSize doesn't reject for insufficient data
    const padded = new Uint8Array(corrupted.length + 10);
    padded.set(corrupted, 0);

    framer.push(padded);
    expect(() => framer.drain()).toThrow();
  });

  it('skips bad frame bytes so subsequent drain is not stalled', () => {
    // After a decode error, the bad bytes must be consumed (not left in buffer).
    // A subsequent valid message pushed after the error should decode fine.
    const malformed = new Uint8Array([0x3E, 0x00, 0x02, 0xDE, 0xAD]);
    const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
    const validBytes = encodeMessage(goaway);

    framer.push(malformed);
    expect(() => framer.drain()).toThrow(/unknown message type/i);

    // Push a valid message after the error
    framer.push(validBytes);
    const messages = framer.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.message.type).toBe('GOAWAY');
  });
});
