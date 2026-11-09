/**
 * Shared fixtures for object reception tests: simulator connections for every
 * draft, wire builders for subgroup objects, and a compact event summary.
 * Reads are delivered one `push` at a time at a test-controlled
 * `performance.now`, which the caller mocks.
 */
import { expect } from 'vitest';
import {
  createControlCodec,
  encodeSubgroupHeader,
  encodeSubgroupObject,
  encodeSubgroupHeader18,
  encodeSubgroupObject18,
  varint,
} from '@openmoq/transport';
import type { SubgroupHeader } from '@openmoq/transport';
import { MoqtConnection } from '../adapter.js';
import type { ObjectReceptionEvent, ObjectReceptionOptions } from '../object-reception.js';
import { TransportSim, flush, type SimStream } from './stream-sim.js';

export type Draft = 14 | 16 | 18 | 22;
export const drafts = [14, 16, 18, 22] as const;
export const legacy = (d: Draft): d is 14 | 16 => d === 14 || d === 16;
export const ALIAS = 77n, GROUP = 5n, SUBGROUP = 2n, PRIORITY = 128;

/** The controlled observation clock the tests mock `performance.now` with. */
export const clock = { now: 0 };

export async function connect(draft: Draft, transport = new TransportSim()): Promise<{ connection: MoqtConnection; transport: TransportSim }> {
  const connection = new MoqtConnection(draft);
  if (legacy(draft)) {
    const pending = connection.connect(transport); await flush(100);
    transport.bidi[0]!.push(createControlCodec(draft).encode({ type: 'SERVER_SETUP', parameters: new Map([[2n, [100n]]]) }));
    await pending;
  } else {
    transport.openIncomingUni().push(createControlCodec(draft).encode({ type: 'SETUP', setupOptions: new Map() }));
    await connection.connect(transport);
  }
  return { connection, transport };
}

export interface StreamHeaderOptions {
  readonly properties?: boolean;
  /** Subgroup ID mode: explicit (default) or taken from the first Object (FIRST_OBJECT, mode 0b01). */
  readonly subgroupFromFirstObject?: boolean;
  readonly groupId?: bigint;
  readonly trackAlias?: bigint;
}

/** Subgroup header with a Publisher Priority and, by default, an explicit Subgroup ID. */
export function streamHeader(draft: Draft, options: StreamHeaderOptions = {}): Uint8Array {
  const mode = options.subgroupFromFirstObject ? 0x02 : 0x04;
  const header: SubgroupHeader = {
    typeByte: (legacy(draft) ? 0x10 : 0x50) | mode | (options.properties ? 0x01 : 0),
    trackAlias: options.trackAlias ?? ALIAS, groupId: options.groupId ?? GROUP,
    subgroupId: options.subgroupFromFirstObject ? 0n : SUBGROUP, publisherPriority: PRIORITY,
    hasExtensions: options.properties === true, isEndOfGroup: false, isFirstObjectInSubgroup: true,
  };
  return legacy(draft) ? encodeSubgroupHeader(header) : encodeSubgroupHeader18(header);
}

export function object(draft: Draft, objectId: bigint, payload: Uint8Array, previous: bigint | null,
  options: { status?: bigint; properties?: Uint8Array | true } = {}): Uint8Array {
  const hasProperties = options.properties !== undefined;
  const extensions = options.properties === true ? new Uint8Array(0) : options.properties;
  const value = { objectId, payload, status: options.status, extensions };
  return legacy(draft)
    ? encodeSubgroupObject(value, hasProperties, varint(previous ?? 0n), previous === null)
    : encodeSubgroupObject18(value, hasProperties, previous ?? 0n, previous === null);
}

export const payloadOf = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Deliver one browser read at a controlled observation time. */
export async function read(stream: SimStream, at: number, bytes: Uint8Array): Promise<void> {
  clock.now = at; stream.push(bytes); await flush(100);
}

/** Compact, order-preserving view of what one listener saw. */
export function summary(events: readonly ObjectReceptionEvent[]): unknown[] {
  return events.map(e => {
    if (e.type === 'header') return ['header', e.objectId, e.firstObjectByteObservedAt, e.headerAvailableAt, e.payloadLength, e.objectStatus];
    if (e.type === 'progress') return ['progress', e.payloadReceived, e.observedAt];
    return ['end', e.objectId, e.outcome, e.reason, e.payloadReceived, e.firstPayloadByteObservedAt, e.lastPayloadByteObservedAt, e.observedAt];
  });
}

export function observe(connection: MoqtConnection, options?: ObjectReceptionOptions) {
  const events: ObjectReceptionEvent[] = [];
  const detach = connection.observeObjectReception(event => { events.push(event); }, options);
  return { events, detach };
}

/** Every attempt that announced a header ended exactly once, and nothing ended without a header (streams). */
export function expectExactlyOneTerminalPerAttempt(events: readonly ObjectReceptionEvent[]): void {
  const headers = events.filter(e => e.type === 'header').map(e => e.reception);
  const ends = events.filter(e => e.type === 'end' && e.origin !== 'datagram').map(e => e.reception);
  expect(new Set(headers).size).toBe(headers.length);
  expect(ends).toEqual(headers);
}
