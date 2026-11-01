import { describe, expect, it } from 'vitest';
import { CARRIER_CHANNEL, CARRIER_VERSION, MAX_CARRIER_BYTES, decodeCarrierReply, decodeCarrierRequest,
  encodeCarrierReply, encodeCarrierRequest } from './carrier.js';
import type { CarrierReply, CarrierRequest } from './carrier.js';
import { MAX_MESSAGE_BYTES } from './limits.js';
import { decodeMessage, encodeMessage } from './index.js';
import { refreshFixtures, carrierRefreshFixture, carrierPollFixture, carrierEmptyFixture } from './fixtures.js';

const receipt = '1.0123456789abcdef0123456789abcdef';
const wire = (data: object): string => JSON.stringify({ channel: CARRIER_CHANNEL, version: CARRIER_VERSION, ...data });

describe('bounded local carrier envelopes', () => {
  it.each<CarrierRequest>([
    { kind: 'poll', receipt }, { kind: 'close' }, { kind: 'request', receipt, message: 'opaque protocol text' },
  ])('roundtrips reader packet $kind without interpreting the inner protocol', packet => {
    expect(decodeCarrierRequest(encodeCarrierRequest(packet))).toEqual({ ok: true, packet });
  });

  it.each<CarrierReply>([
    { kind: 'reply', receipt, frames: [] },
    { kind: 'reply', receipt, frames: ['first', 'second'] },
    { kind: 'closed', reason: 'idle-timeout', connectionReason: null },
    { kind: 'closed', reason: 'registry-closed', connectionReason: 'registry-disposed' },
  ])('roundtrips source packet $kind', packet => {
    expect(decodeCarrierReply(encodeCarrierReply(packet))).toEqual({ ok: true, packet });
  });

  it('carries drain-before-snapshot byte for byte as one exchange', () => {
    const frames = refreshFixtures.map(encodeMessage);
    const result = decodeCarrierReply(encodeCarrierReply({ kind: 'reply', receipt, frames }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.packet.kind !== 'reply') throw new Error('Expected reply');
    expect(result.packet.frames).toEqual(frames);
    expect(result.packet.frames.map(frame => {
      const decoded = decodeMessage(frame);
      if (!decoded.ok) throw new Error('Expected protocol frame');
      return decoded.message.kind;
    })).toEqual(['batch', 'snapshot']);
  });

  it('keeps the shared host fixtures executable through both carrier directions', () => {
    for (const packet of [carrierRefreshFixture, carrierEmptyFixture]) {
      expect(decodeCarrierReply(encodeCarrierReply(packet))).toEqual({ ok: true, packet });
    }
    expect(decodeCarrierRequest(encodeCarrierRequest(carrierPollFixture))).toEqual({ ok: true, packet: carrierPollFixture });
    expect(carrierPollFixture.receipt).toBe(carrierRefreshFixture.receipt);
    expect(carrierEmptyFixture.receipt).not.toBe(carrierPollFixture.receipt);
  });

  it('projects unknown outer fields while keeping inner strings opaque', () => {
    const result = decodeCarrierReply(wire({ kind: 'reply', receipt, frames: ['{"future":1}'], secret: 'not retained' }));
    expect(result).toEqual({ ok: true, packet: { kind: 'reply', receipt, frames: ['{"future":1}'] } });
    const input = { kind: 'close' as const, toJSON: () => { throw new Error('Must project first'); }, secret: 'not retained' };
    expect(encodeCarrierRequest(input)).toBe(wire({ kind: 'close' }));
  });

  it('rejects the opposite direction rather than forwarding a page command into the host', () => {
    expect(decodeCarrierRequest(encodeCarrierReply({ kind: 'reply', receipt, frames: [] })).ok).toBe(false);
    expect(decodeCarrierReply(encodeCarrierRequest({ kind: 'request', receipt, message: '{}' })).ok).toBe(false);
    expect(decodeCarrierReply(encodeCarrierRequest({ kind: 'close' })).ok).toBe(false);
  });

  it.each([undefined, null, {}, new Uint8Array(), 'not json', '[]'])('refuses non-JSON-envelope input %s without throwing', input => {
    expect(decodeCarrierRequest(input).ok).toBe(false);
    expect(decodeCarrierReply(input).ok).toBe(false);
  });

  it('checks channel and carrier version independently of the inner protocol', () => {
    expect(decodeCarrierReply(wire({ channel: 'other', kind: 'reply', receipt, frames: [] })).ok).toBe(false);
    expect(decodeCarrierReply(wire({ version: 2, kind: 'reply', receipt, frames: [] }))).toMatchObject({ ok: false, error: { code: 'incompatible-version' } });
  });

  it.each(['', '1', '01.' + 'a'.repeat(32), '1.' + 'a'.repeat(31), '1.' + 'A'.repeat(32),
    '18446744073709551616.' + 'a'.repeat(32)])('rejects malformed or overflowing receipt %s', bad => {
    expect(decodeCarrierRequest(wire({ kind: 'poll', receipt: bad })).ok).toBe(false);
    expect(decodeCarrierReply(wire({ kind: 'reply', receipt: bad, frames: [] })).ok).toBe(false);
  });

  it('refuses more than two frames, nonstrings and oversized inner frames in both directions', () => {
    for (const frames of [['a', 'b', 'c'], [null], ['x'.repeat(MAX_MESSAGE_BYTES + 1)]]) {
      expect(decodeCarrierReply(wire({ kind: 'reply', receipt, frames })).ok).toBe(false);
    }
    for (const message of [null, {}, 'x'.repeat(MAX_MESSAGE_BYTES + 1)]) {
      expect(decodeCarrierRequest(wire({ kind: 'request', receipt, message })).ok).toBe(false);
    }
  });

  it('measures UTF-8 and JSON escaping independently at each boundary', () => {
    const max = '🟡'.repeat(MAX_MESSAGE_BYTES / 4);
    expect(decodeCarrierReply(wire({ kind: 'reply', receipt, frames: [max] })).ok).toBe(true);
    expect(decodeCarrierReply(wire({ kind: 'reply', receipt, frames: [max + 'x'] })).ok).toBe(false);
    expect(decodeCarrierRequest(wire({ kind: 'request', receipt, message: max + 'x' })).ok).toBe(false);
    const escaped = '"'.repeat(MAX_MESSAGE_BYTES);
    const reply = encodeCarrierReply({ kind: 'reply', receipt, frames: [escaped, escaped] });
    expect(new TextEncoder().encode(reply).byteLength).toBeLessThanOrEqual(MAX_CARRIER_BYTES);
    expect(decodeCarrierReply(reply).ok).toBe(true);
    // Length alone would pass this oversized outer frame; UTF-8 does not.
    expect(decodeCarrierReply(wire({ kind: 'reply', receipt, frames: [], future: '🟡'.repeat(MAX_CARRIER_BYTES / 4) })))
      .toMatchObject({ ok: false, error: { code: 'too-large' } });
  });

  it('rejects oversized outer text before parsing and reports no input content', () => {
    const result = decodeCarrierReply('secret'.repeat(MAX_CARRIER_BYTES));
    expect(result).toMatchObject({ ok: false, error: { code: 'too-large' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(decodeCarrierReply(wire({ kind: 'secret', receipt })))).not.toContain('secret');
  });

  it('requires a registry close reason only for a registry closure', () => {
    for (const packet of [
      { kind: 'closed', reason: 'registry-closed', connectionReason: null },
      { kind: 'closed', reason: 'registry-closed', connectionReason: 'arbitrary secret' },
      { kind: 'closed', reason: 'idle-timeout', connectionReason: 'registry-disposed' },
      { kind: 'closed', reason: 'arbitrary secret', connectionReason: null },
    ]) expect(decodeCarrierReply(wire(packet)).ok).toBe(false);
  });
});
