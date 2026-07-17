/**
 * Error taxonomy tests — createPlayerError factory and types.
 *
 * @see draft-ietf-moq-transport-16 §13.4 (Error Codes)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { createPlayerError, PlayerErrorCode, type PlayerError } from './errors.js';

describe('Error Taxonomy', () => {
  it('createPlayerError produces well-formed error', () => {
    const err = createPlayerError(
      'fatal', 'connection', PlayerErrorCode.CONTROL_STREAM_LOST,
      'Control stream lost',
    );

    expect(err.severity).toBe('fatal');
    expect(err.source).toBe('connection');
    expect(err.code).toBe(PlayerErrorCode.CONTROL_STREAM_LOST);
    expect(err.message).toBe('Control stream lost');
    expect(err.timestampMs).toBeGreaterThan(0);
    expect(err.cause).toBeUndefined();
    expect(err.context).toBeUndefined();
  });

  it('stamps timestampMs automatically', () => {
    const before = Date.now();
    const err = createPlayerError(
      'transient', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR, 'test',
    );
    const after = Date.now();

    expect(err.timestampMs).toBeGreaterThanOrEqual(before);
    expect(err.timestampMs).toBeLessThanOrEqual(after);
  });

  it('passes through cause error', () => {
    const original = new Error('WebCodecs decode failed');
    const err = createPlayerError(
      'degraded', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
      'Video decode error',
      { cause: original },
    );

    expect(err.cause).toBe(original);
  });

  it('passes through context object', () => {
    const err = createPlayerError(
      'degraded', 'connection', PlayerErrorCode.DATA_STREAM_RESET,
      'Stream reset',
      { context: { streamId: 42n, errorCode: 0x1 } },
    );

    expect(err.context).toEqual({ streamId: 42n, errorCode: 0x1 });
  });

  it('error codes are in 0x1000+ range (no IANA collision)', () => {
    for (const [, code] of Object.entries(PlayerErrorCode)) {
      expect(code).toBeGreaterThanOrEqual(0x1000);
    }
  });

  it('error codes are unique', () => {
    const codes = Object.values(PlayerErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('MEDIA_STARVED lives in the connection block', () => {
    expect(PlayerErrorCode.MEDIA_STARVED).toBe(0x1005);
  });

  it('MEDIA_ELEMENT_WEDGED lives in the decoder block', () => {
    expect(PlayerErrorCode.MEDIA_ELEMENT_WEDGED).toBe(0x1102);
  });

  it('CODEC_UNSUPPORTED lives in the decoder block', () => {
    expect(PlayerErrorCode.CODEC_UNSUPPORTED).toBe(0x1103);
  });

  it('CMAF bootstrap codes live in the catalog block', () => {
    expect(PlayerErrorCode.CMAF_INIT_INVALID).toBe(0x1202);
    expect(PlayerErrorCode.CMAF_INIT_TIMEOUT).toBe(0x1203);
  });

  it('all severity values are valid', () => {
    const severities = ['transient', 'degraded', 'fatal'] as const;
    for (const severity of severities) {
      const err = createPlayerError(
        severity, 'player', PlayerErrorCode.CONTROL_STREAM_LOST, 'test',
      );
      expect(err.severity).toBe(severity);
    }
  });

  it('all source values are valid', () => {
    const sources = ['connection', 'pipeline', 'decoder', 'catalog', 'player', 'subscription'] as const;
    for (const source of sources) {
      const err = createPlayerError(
        'transient', source, PlayerErrorCode.CONTROL_STREAM_LOST, 'test',
      );
      expect(err.source).toBe(source);
    }
  });
});
