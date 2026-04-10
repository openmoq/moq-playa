/**
 * MoqtConnectionError tests.
 *
 * Verifies typed error classification for adapter-level errors.
 * Error source and fatality rules are grounded in the spec:
 *
 * - Control stream errors are fatal (§3.2: control stream MUST NOT close)
 * - Data stream resets are non-fatal (§10.4: publisher MAY reset streams)
 * - Datagram decode errors are non-fatal (datagrams are unreliable)
 * - Transport-level errors are fatal (connection lost)
 *
 * @see draft-ietf-moq-transport-16 §3.2, §10.4, §13.4
 */

import { describe, it, expect } from 'vitest';
import { MoqtConnectionError } from './adapter-error.js';

describe('MoqtConnectionError', () => {
  it('is an Error subclass', () => {
    const err = new MoqtConnectionError('test', { errorSource: 'control' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MoqtConnectionError);
    expect(err.name).toBe('MoqtConnectionError');
    expect(err.message).toBe('test');
  });

  // ─── Default fatality by source ──────────────────────────────

  it('control source errors are fatal by default (§3.2)', () => {
    const err = new MoqtConnectionError('control stream closed', { errorSource: 'control' });
    expect(err.isFatal).toBe(true);
    expect(err.errorSource).toBe('control');
  });

  it('data source errors are non-fatal by default (§10.4)', () => {
    const err = new MoqtConnectionError('stream reset', { errorSource: 'data' });
    expect(err.isFatal).toBe(false);
    expect(err.errorSource).toBe('data');
  });

  it('datagram source errors are non-fatal by default', () => {
    const err = new MoqtConnectionError('decode failed', { errorSource: 'datagram' });
    expect(err.isFatal).toBe(false);
    expect(err.errorSource).toBe('datagram');
  });

  it('transport source errors are fatal by default', () => {
    const err = new MoqtConnectionError('connection lost', { errorSource: 'transport' });
    expect(err.isFatal).toBe(true);
    expect(err.errorSource).toBe('transport');
  });

  // ─── Explicit override ──────────────────────────────────────

  it('isFatal can be explicitly overridden to false for control', () => {
    const err = new MoqtConnectionError('non-fatal control', {
      errorSource: 'control',
      isFatal: false,
    });
    expect(err.isFatal).toBe(false);
  });

  it('isFatal can be explicitly overridden to true for data', () => {
    const err = new MoqtConnectionError('fatal data', {
      errorSource: 'data',
      isFatal: true,
    });
    expect(err.isFatal).toBe(true);
  });

  // ─── Context preservation ────────────────────────────────────

  it('preserves protocolCode (§13.4 IANA error codes)', () => {
    const err = new MoqtConnectionError('protocol violation', {
      errorSource: 'control',
      protocolCode: 0x3, // PROTOCOL_VIOLATION
    });
    expect(err.protocolCode).toBe(0x3);
  });

  it('preserves streamId for data stream errors', () => {
    const err = new MoqtConnectionError('stream reset', {
      errorSource: 'data',
      streamId: 42n,
    });
    expect(err.streamId).toBe(42n);
  });

  it('chains cause via Error.cause', () => {
    const cause = new Error('underlying WebTransport error');
    const err = new MoqtConnectionError('wrapped', {
      errorSource: 'transport',
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('protocolCode and streamId default to undefined', () => {
    const err = new MoqtConnectionError('simple', { errorSource: 'data' });
    expect(err.protocolCode).toBeUndefined();
    expect(err.streamId).toBeUndefined();
  });
});
