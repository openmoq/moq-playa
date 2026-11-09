import type { MoqtObject, ObjectDatagram } from '@openmoq/transport';

declare const receiptIdentity: unique symbol;

/** Opaque identity of one observed receipt, not a wire location or a media unit. */
export interface ObjectReceipt {
  readonly [receiptIdentity]: true;
}

interface ObjectReceiptFields {
  readonly receipt: ObjectReceipt;
  readonly groupId: bigint;
  readonly subgroupId: bigint | null;
  readonly objectId: bigint;
  readonly objectStatus: bigint;
  readonly payloadBytes: number;
}

type AliasReceiptOrigin = 'subgroup' | 'datagram' | 'group-end';
export type ObjectReceiptObservation = ObjectReceiptFields & (
  | {
      /** group-end is a bound derived from a flagged subgroup's graceful FIN. */
      readonly origin: AliasReceiptOrigin;
      /** Actual last parsed Object ID for a FIN-derived bound; null for other origins. */
      readonly lastObjectId: bigint | null;
      readonly trackAlias: bigint;
    }
  | {
      /** FETCH stream identity, including Joining FETCH and draft-22 FILL. */
      readonly origin: 'fetch';
      readonly lastObjectId: null;
      readonly trackAlias: null;
      readonly requestId: bigint;
      readonly streamId: bigint;
    }
);

export interface ObjectReceiptDiscard {
  readonly receipt: ObjectReceipt;
  readonly reason: 'subscription policy' | 'late';
}
type DiscardListener = (event: ObjectReceiptDiscard) => void | Promise<void>;

type Listener = (event: ObjectReceiptObservation) => void | Promise<void>;

/** Allocated only by an explicit observer; neither the token nor its metadata retains media. */
export class ObjectReceiptObservers {
  private readonly listeners = new Set<Listener>();
  private readonly receipts = new WeakMap<object, ObjectReceipt>();
  private readonly discarded = new WeakSet<object>();
  private readonly discardListeners = new Set<DiscardListener>();

  get empty(): boolean { return this.listeners.size === 0 && this.discardListeners.size === 0; }

  observe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  observeDiscards(listener: DiscardListener): () => void {
    this.discardListeners.add(listener);
    return () => { this.discardListeners.delete(listener); };
  }

  discard(object: object, reason: ObjectReceiptDiscard['reason']): void {
    const receipt = this.receipts.get(object);
    if (!receipt || this.discarded.has(object)) return;
    this.discarded.add(object);
    for (const listener of [...this.discardListeners]) {
      if (!this.discardListeners.has(listener)) continue;
      try {
        const result = listener({ receipt, reason });
        if (result) void Promise.resolve(result).catch(() => {});
      } catch { /* Optional outcomes cannot change protocol delivery. */ }
    }
  }

  receiptFor(object: object): ObjectReceipt | undefined { return this.receipts.get(object); }

  private register(object: object): ObjectReceipt | undefined {
    if (this.empty || this.receipts.has(object)) return;
    const receipt = Object.freeze({}) as ObjectReceipt;
    this.receipts.set(object, receipt);
    return receipt;
  }

  receive(object: MoqtObject | ObjectDatagram, origin: AliasReceiptOrigin, lastObjectId: bigint | null = null): void {
    const receipt = this.register(object);
    if (!receipt) return;
    const observation: ObjectReceiptObservation = {
      receipt, origin, lastObjectId: origin === 'group-end' ? lastObjectId : null, trackAlias: object.trackAlias, groupId: object.groupId, objectId: object.objectId,
      subgroupId: 'subgroupId' in object ? object.subgroupId : null,
      objectStatus: 'kind' in object ? object.kind === 'gap' ? object.status : 0n : object.status ?? 0n,
      payloadBytes: 'kind' in object && object.kind === 'gap' ? 0 : object.payload.byteLength,
    };
    this.publish(observation);
  }

  receiveFetch(object: MoqtObject, requestId: bigint, streamId: bigint): void {
    const receipt = this.register(object);
    if (!receipt) return;
    this.publish({
      receipt, origin: 'fetch', lastObjectId: null, trackAlias: null, requestId, streamId,
      groupId: object.groupId, objectId: object.objectId, subgroupId: object.subgroupId,
      objectStatus: object.kind === 'gap' ? object.status : 0n,
      payloadBytes: object.kind === 'gap' ? 0 : object.payload.byteLength,
    });
  }

  private publish(observation: ObjectReceiptObservation): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        const result = listener({ ...observation });
        if (result) void Promise.resolve(result).catch(() => {});
      } catch { /* Optional observations cannot change protocol delivery. */ }
    }
  }
}
