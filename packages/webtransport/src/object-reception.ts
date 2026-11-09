import type { ObjectHeaderLayout, ObjectDatagram } from '@openmoq/transport';

declare const receptionIdentity: unique symbol;

/**
 * Opaque identity of one physical receive attempt: one Object instance on one
 * received carrier. Not a wire location, not a logical Object across the
 * session, and not an application callback invocation.
 */
export interface ObjectReception {
  readonly [receptionIdentity]: true;
}

export type ObjectReceptionOrigin = 'subgroup' | 'fetch' | 'fill' | 'datagram';

/** Why a stream attempt ended before its payload completed. */
export type ObjectReceptionInterruption =
  | 'reset'
  | 'local-discard'
  | 'error'
  | 'protocol-violation'
  | 'connection-closed';

/** Why `properties` is null on an event that could carry them. */
export type ObjectReceptionPropertiesOmission = 'not-requested' | 'exceeds-limit';

/** Property bytes above this size are omitted from observations, never truncated. An observation limit, not a protocol limit. */
export const OBSERVED_PROPERTIES_LIMIT = 64 * 1024;

interface ObjectReceptionIdentity {
  readonly reception: ObjectReception;
  readonly origin: ObjectReceptionOrigin;
  /** Local data-stream id; null for datagrams. */
  readonly streamId: bigint | null;
  /** Wire Track Alias of a subgroup stream or datagram; null on FETCH/FILL streams, which carry none. */
  readonly trackAlias: bigint | null;
  /** Request ID from a FETCH_HEADER (FETCH or FILL); null otherwise. */
  readonly requestId: bigint | null;
  readonly groupId: bigint;
  /** Null where the framing carries no Subgroup ID. */
  readonly subgroupId: bigint | null;
  readonly objectId: bigint;
}

interface ObjectReceptionHeaderFields {
  /** Declared Object Payload Length, exact. */
  readonly payloadLength: bigint;
  /** Object Status where the framing carries one; distinguishes zero-byte data from status Objects. */
  readonly objectStatus: bigint | null;
  readonly publisherPriority: number | null;
  /** Byte length of the Object's properties (extension headers); 0 when there are none. */
  readonly propertiesLength: number;
  /** An isolated copy of the property bytes, when requested and within {@link OBSERVED_PROPERTIES_LIMIT}. */
  readonly properties: Uint8Array | null;
  readonly propertiesOmitted: ObjectReceptionPropertiesOmission | null;
}

/** The complete Object header of a stream Object, before waiting for its payload. */
export interface ObjectReceptionHeader extends ObjectReceptionIdentity, ObjectReceptionHeaderFields {
  readonly type: 'header';
  readonly origin: Exclude<ObjectReceptionOrigin, 'datagram'>;
  /** Observation time of the read that carried the Object's first byte. */
  readonly firstObjectByteObservedAt: number;
  /** Observation time of the read that carried the header's last byte. Not callback time. */
  readonly headerAvailableAt: number;
}

/** Cumulative payload bytes received for a stream attempt, at most once per read. */
export interface ObjectReceptionProgress {
  readonly type: 'progress';
  readonly reception: ObjectReception;
  readonly payloadReceived: bigint;
  /** Observation time of the read that carried these bytes. */
  readonly observedAt: number;
}

interface ObjectReceptionEndFields {
  readonly type: 'end';
  readonly payloadReceived: bigint;
  /** Null when no payload byte was received. */
  readonly firstPayloadByteObservedAt: number | null;
  readonly lastPayloadByteObservedAt: number | null;
  /** For completion, the read that completed the Object; for interruption, when termination was observed. */
  readonly observedAt: number;
}

/** The one receive terminal of a stream attempt. */
export type ObjectReceptionEnd = ObjectReceptionIdentity & ObjectReceptionEndFields & {
  readonly origin: Exclude<ObjectReceptionOrigin, 'datagram'>;
  readonly payloadLength: bigint;
  /** As on the header: Object Status where the framing carries one. */
  readonly objectStatus: bigint | null;
} & (
  | { readonly outcome: 'complete'; readonly reason: null; readonly resetCode: null }
  | { readonly outcome: 'interrupted'; readonly reason: ObjectReceptionInterruption; readonly resetCode: number | null }
);

/** A whole datagram: its only event, carrying the decoded metadata. */
export interface ObjectReceptionDatagram extends ObjectReceptionIdentity, ObjectReceptionHeaderFields, ObjectReceptionEndFields {
  readonly origin: 'datagram';
  readonly outcome: 'complete';
  readonly reason: null;
  readonly resetCode: null;
}

export type ObjectReceptionEvent =
  | ObjectReceptionHeader
  | ObjectReceptionProgress
  | ObjectReceptionEnd
  | ObjectReceptionDatagram;

export interface ObjectReceptionOptions {
  /** Copy each Object's property bytes into its header (or datagram) observation. Default false. */
  readonly includeProperties?: boolean;
}

type Listener = (event: ObjectReceptionEvent) => void | Promise<void>;

interface Registration {
  readonly listener: Listener;
  /** Attachment order. A listener sees an attempt only if attached when its first bytes were observed. */
  readonly seq: number;
  readonly includeProperties: boolean;
}

/** Identity a stream supplies to its Objects. Resolved by the reader, never inferred from ownership. */
export interface ReceptionCarrier {
  readonly origin: Exclude<ObjectReceptionOrigin, 'datagram'>;
  readonly streamId: bigint;
  readonly trackAlias: bigint | null;
  readonly requestId: bigint | null;
  /** Subgroup streams: the stream header's Group, Subgroup and Priority. FETCH/FILL: null (per Object). */
  readonly groupId: bigint | null;
  readonly subgroupId: bigint | null;
  readonly publisherPriority: number | null;
  /** FIRST_OBJECT subgroup-ID mode before its first Object resolved the Subgroup ID. */
  readonly subgroupFromFirstObject: boolean;
}

interface Attempt {
  readonly token: ObjectReception;
  readonly epoch: number;
  readonly identity: Omit<ObjectReceptionIdentity, 'reception'> & { readonly origin: ReceptionCarrier['origin'] };
  readonly headerBytes: number;
  readonly payloadLength: bigint;
  readonly objectStatus: bigint | null;
  received: bigint;
  firstPayloadAt: number | null;
  lastPayloadAt: number | null;
  /** The header observation not yet delivered: built when the attempt opens, delivered once. */
  header: { readonly event: Omit<ObjectReceptionHeader, 'properties' | 'propertiesOmitted'>; readonly bytes: Uint8Array | undefined;
    readonly offset: number; readonly length: number } | undefined;
}

/** Observation time and eligibility epoch of the read that carried an Object's first byte. */
interface FirstBytes {
  readonly at: number;
  readonly epoch: number;
}

/**
 * Constant per-reader state. `start` is the current Object's first-byte
 * provenance: 'pending' at a boundary with nothing buffered, 'unobserved' when
 * its first byte came from a read nobody observed. Unconsumed bytes after any
 * successful parse belong to the latest read, because every reader decodes
 * greedily before reading again; that is what makes one sample per read enough.
 */
class ReaderState {
  readAt: number | undefined;
  readEpoch = 0;
  carrier: ReceptionCarrier | undefined;
  start: FirstBytes | 'pending' | 'unobserved' | undefined;
  attempt: Attempt | undefined;
  /** The current item is an End-of-Range indicator: never an attempt. */
  range = false;
}

/**
 * Allocated only by an explicit observer; reads with nobody observing leave no
 * state here. `receptions` correlates delivered Objects to their arrival and
 * may outlive this component (the connection owns it), so an identity already
 * captured survives the last listener leaving.
 */
export class ObjectReceptionObservers {
  private readonly listeners: Registration[] = [];
  private attachSeq = 0;
  private readonly readers = new WeakMap<object, ReaderState>();
  private readonly active = new Set<ReaderState>();
  /** Notifications raised by a listener while another notification is running. Synchronous and bounded by reentry depth. */
  private reentrant: Array<() => void> | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly receptions: WeakMap<object, ObjectReception> = new WeakMap(),
  ) {}

  get empty(): boolean { return this.listeners.length === 0; }

  observe(listener: Listener, options: ObjectReceptionOptions = {}): () => void {
    const registration: Registration = { listener, seq: ++this.attachSeq, includeProperties: options.includeProperties === true };
    this.listeners.push(registration);
    return () => {
      const i = this.listeners.indexOf(registration);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The attempt that delivered this exact Object instance, if its reception was observed. */
  receptionFor(object: object): ObjectReception | undefined { return this.receptions.get(object); }

  /** A read before the object phase (classifier or stream header) that delivered bytes. */
  streamRead(reader: object, bytes: number): void {
    if (bytes === 0) return;
    const state = this.stateFor(reader);
    this.sample(state);
  }

  /** The stream header has parsed; `leftover` bytes of the first Object came from the latest read. */
  objectsBegin(reader: object, leftover: number, carrier: () => ReceptionCarrier): void {
    const state = this.stateFor(reader);
    state.carrier = carrier();
    if (leftover === 0) state.start = 'pending';
    else state.start = state.readAt === undefined ? 'unobserved' : { at: state.readAt, epoch: state.readEpoch };
  }

  /** An object-phase read: `buffered` bytes of the current Object were held before these `bytes` arrived. */
  objectRead(reader: object, buffered: number, bytes: number, carrier: () => ReceptionCarrier): void {
    if (bytes === 0) return;
    let state = this.readers.get(reader);
    if (state === undefined) {
      state = this.stateFor(reader);
      state.start = buffered > 0 ? 'unobserved' : 'pending';
    } else if (state.start === undefined) {
      state.start = buffered > 0 ? 'unobserved' : 'pending';
    }
    state.carrier ??= carrier();
    this.sample(state);
    if (state.start === 'pending') state.start = { at: state.readAt!, epoch: state.readEpoch };
  }

  /**
   * The full decoder needs more bytes. `buf` starts at the current item. Announce
   * its header once it is complete, then cumulative payload progress.
   */
  pending(reader: object, buf: Uint8Array, peek: (buf: Uint8Array) => ObjectHeaderLayout, carrier: () => ReceptionCarrier): void {
    const state = this.readers.get(reader);
    if (state === undefined || state.readAt === undefined) return;
    const at = state.readAt;
    let attempt = state.attempt;
    if (attempt === undefined) {
      if (state.range || typeof state.start !== 'object') return;
      let layout: ObjectHeaderLayout;
      try { layout = peek(buf); } catch { return; } // incomplete header; the decoder owns every error
      if (layout.kind === 'range') { state.range = true; return; }
      state.carrier ??= carrier();
      attempt = this.open(state, state.start, layout, buf);
      state.attempt = attempt;
      this.active.add(state);
    }
    // Commit this read's receive accounting before any listener can run: a
    // listener's teardown ends the attempt with exactly what was received.
    const available = BigInt(buf.length - attempt.headerBytes);
    const received = available < attempt.payloadLength ? available : attempt.payloadLength;
    const grew = received > attempt.received;
    if (grew) {
      attempt.received = received;
      attempt.firstPayloadAt ??= at;
      attempt.lastPayloadAt = at;
    }
    this.announce(attempt);
    // A header listener may have ended the attempt; only a live one reports progress.
    if (grew && state.attempt === attempt) {
      this.emit(attempt, { type: 'progress', reception: attempt.token, payloadReceived: received, observedAt: at });
    }
  }

  /**
   * The authoritative decoder consumed the current Object, delivered as
   * `delivered`, using `layout` parsed from `bytes` (which start at the Object).
   * The outcome is settled here, before any listener runs: completion,
   * correlation and the next item's provenance are committed first, then the
   * header (if not yet announced) and the complete end are delivered in order.
   * A listener's teardown may stop later processing; it cannot make a received
   * Object incomplete.
   */
  complete(reader: object, delivered: object, leftover: number, layout: ObjectHeaderLayout, bytes: Uint8Array,
    carrier: () => ReceptionCarrier): void {
    const state = this.readers.get(reader);
    if (state === undefined) return;
    let attempt = state.attempt;
    if (attempt === undefined && typeof state.start === 'object' && state.readAt !== undefined) {
      state.carrier ??= carrier();
      attempt = this.open(state, state.start, layout, bytes); // settled at once: never in flight
    }
    let end: ObjectReceptionEnd | undefined;
    if (attempt !== undefined) {
      const at = state.readAt!;
      const payload = attempt.payloadLength > 0n;
      attempt.received = attempt.payloadLength;
      attempt.firstPayloadAt = payload ? attempt.firstPayloadAt ?? at : null;
      attempt.lastPayloadAt = payload ? at : null;
      this.receptions.set(delivered, attempt.token);
      if (state.attempt === attempt) state.attempt = undefined;
      this.active.delete(state);
      end = {
        ...attempt.identity, type: 'end', reception: attempt.token, outcome: 'complete', reason: null, resetCode: null,
        payloadLength: attempt.payloadLength, payloadReceived: attempt.payloadLength, objectStatus: attempt.objectStatus,
        firstPayloadByteObservedAt: attempt.firstPayloadAt, lastPayloadByteObservedAt: attempt.lastPayloadAt, observedAt: at,
      };
    }
    // FIRST_OBJECT mode resolves the Subgroup ID from the stream's first Object.
    if (state.carrier?.subgroupFromFirstObject) state.carrier = carrier();
    this.advance(state, leftover);
    if (attempt !== undefined) {
      this.announce(attempt);
      this.emit(attempt, end!);
    }
  }

  /** An End-of-Range indicator was consumed: no attempt; the next item starts after it. */
  skip(reader: object, leftover: number): void {
    const state = this.readers.get(reader);
    if (state !== undefined) this.advance(state, leftover);
  }

  /** The stream ended with the current attempt (if any) incomplete. */
  interrupt(reader: object, reason: ObjectReceptionInterruption, resetCode: number | null = null): void {
    const state = this.readers.get(reader);
    this.readers.delete(reader);
    if (state?.attempt === undefined) return;
    this.interruptAttempt(state, state.attempt, reason, resetCode);
  }

  /** Sample a datagram read. Nothing is retained. */
  datagramRead(): FirstBytes {
    return { at: this.now(), epoch: this.attachSeq };
  }

  /** A whole datagram decoded from the read `first`. */
  datagram(first: FirstBytes, datagram: ObjectDatagram): void {
    const token = Object.freeze({}) as ObjectReception;
    const payloadBytes = BigInt(datagram.payload.byteLength);
    const payloadAt = payloadBytes > 0n ? first.at : null;
    const properties = datagram.extensions;
    this.receptions.set(datagram, token);
    const base = {
      type: 'end' as const, reception: token, origin: 'datagram' as const, streamId: null, trackAlias: datagram.trackAlias,
      requestId: null, groupId: datagram.groupId, subgroupId: null, objectId: datagram.objectId,
      payloadLength: payloadBytes, payloadReceived: payloadBytes, objectStatus: datagram.status ?? null,
      publisherPriority: datagram.publisherPriority ?? null, propertiesLength: properties?.byteLength ?? 0,
      outcome: 'complete' as const, reason: null, resetCode: null,
      firstPayloadByteObservedAt: payloadAt, lastPayloadByteObservedAt: payloadAt, observedAt: first.at,
    };
    this.deliver(first.epoch, registration =>
      ({ ...base, ...this.propertiesFor(registration, properties, 0, properties?.byteLength ?? 0) }));
  }

  /** Connection teardown: every attempt still in flight ends here, first cause first. */
  closeAll(): void {
    const at = this.now();
    for (const state of [...this.active]) {
      if (state.attempt !== undefined) this.interruptAttempt(state, state.attempt, 'connection-closed', null, at);
    }
  }

  private stateFor(reader: object): ReaderState {
    let state = this.readers.get(reader);
    if (state === undefined) { state = new ReaderState(); this.readers.set(reader, state); }
    return state;
  }

  private sample(state: ReaderState): void {
    state.readAt = this.now();
    state.readEpoch = this.attachSeq;
  }

  private advance(state: ReaderState, leftover: number): void {
    state.attempt = undefined;
    state.range = false;
    if (leftover === 0) state.start = 'pending';
    else state.start = state.readAt === undefined ? 'unobserved' : { at: state.readAt, epoch: state.readEpoch };
  }

  /** Build an attempt and its header observation; nothing is delivered and nothing is registered here. */
  private open(state: ReaderState, first: FirstBytes, layout: ObjectHeaderLayout, bytes: Uint8Array): Attempt {
    const carrier = state.carrier!;
    const subgroupId = carrier.origin === 'subgroup'
      ? (carrier.subgroupFromFirstObject ? layout.objectId : carrier.subgroupId)
      : layout.isDatagram ? null : layout.subgroupId ?? null;
    const token = Object.freeze({}) as ObjectReception;
    const identity = {
      origin: carrier.origin, streamId: carrier.streamId, trackAlias: carrier.trackAlias, requestId: carrier.requestId,
      groupId: carrier.groupId ?? layout.groupId!, subgroupId, objectId: layout.objectId,
    };
    const objectStatus = layout.objectStatus ?? null;
    return {
      token, epoch: first.epoch, identity, headerBytes: layout.headerBytes, payloadLength: layout.payloadLength, objectStatus,
      received: 0n, firstPayloadAt: null, lastPayloadAt: null,
      header: {
        event: {
          ...identity, type: 'header', reception: token, payloadLength: layout.payloadLength, objectStatus,
          publisherPriority: carrier.origin === 'subgroup' ? carrier.publisherPriority : layout.publisherPriority ?? null,
          propertiesLength: layout.propertiesLength, firstObjectByteObservedAt: first.at, headerAvailableAt: state.readAt!,
        },
        bytes: layout.propertiesOffset === undefined ? undefined : bytes,
        offset: layout.propertiesOffset ?? 0,
        length: layout.propertiesLength,
      },
    };
  }

  /** Deliver an attempt's header observation once, with per-listener property copies. */
  private announce(attempt: Attempt): void {
    const header = attempt.header;
    if (header === undefined) return;
    attempt.header = undefined;
    this.deliver(attempt.epoch, registration =>
      ({ ...header.event, ...this.propertiesFor(registration, header.bytes, header.offset, header.length) }));
  }

  private propertiesFor(registration: Registration, bytes: Uint8Array | undefined, offset: number, length: number):
    { properties: Uint8Array | null; propertiesOmitted: ObjectReceptionPropertiesOmission | null } {
    if (!registration.includeProperties) return { properties: null, propertiesOmitted: 'not-requested' };
    if (length > OBSERVED_PROPERTIES_LIMIT) return { properties: null, propertiesOmitted: 'exceeds-limit' };
    return { properties: bytes === undefined ? new Uint8Array(0) : bytes.slice(offset, offset + length), propertiesOmitted: null };
  }

  private interruptAttempt(state: ReaderState, attempt: Attempt, reason: ObjectReceptionInterruption, resetCode: number | null,
    at: number = this.now()): void {
    this.finish(state, attempt, {
      ...attempt.identity, type: 'end', reception: attempt.token, outcome: 'interrupted', reason,
      resetCode: reason === 'reset' ? resetCode : null,
      payloadLength: attempt.payloadLength, payloadReceived: attempt.received, objectStatus: attempt.objectStatus,
      firstPayloadByteObservedAt: attempt.firstPayloadAt, lastPayloadByteObservedAt: attempt.lastPayloadAt, observedAt: at,
    });
  }

  /** Exactly one terminal: the attempt leaves the active set before anyone is notified. */
  private finish(state: ReaderState, attempt: Attempt, event: ObjectReceptionEnd): void {
    if (state.attempt === attempt) state.attempt = undefined;
    this.active.delete(state);
    this.announce(attempt); // header before end on every terminal path
    this.emit(attempt, event);
  }

  private emit(attempt: Attempt, event: ObjectReceptionProgress | ObjectReceptionEnd): void {
    this.deliver(attempt.epoch, () => ({ ...event }));
  }

  /**
   * Give each listener eligible for `epoch` its own event object. A listener's
   * reentrant teardown (e.g. closing the connection inside a header callback)
   * queues its notifications behind the current one, so every listener sees an
   * attempt's events in order.
   */
  private deliver(epoch: number, eventFor: (registration: Registration) => ObjectReceptionEvent): void {
    const run = () => {
      for (const registration of [...this.listeners]) {
        if (registration.seq > epoch || !this.listeners.includes(registration)) continue;
        this.notify(registration, eventFor(registration));
      }
    };
    if (this.reentrant !== undefined) { this.reentrant.push(run); return; }
    this.reentrant = [];
    try {
      run();
      while (this.reentrant.length > 0) this.reentrant.shift()!();
    } finally { this.reentrant = undefined; }
  }

  private notify(registration: Registration, event: ObjectReceptionEvent): void {
    try {
      const result = registration.listener(event);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch { /* Observation cannot change protocol processing. */ }
  }
}
