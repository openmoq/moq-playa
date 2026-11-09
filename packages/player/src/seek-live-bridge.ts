import { MAX_VARINT, MAX_VI64, varint, type ControlMessage, type DataStreamHeader, type MoqtObject, type ObjectDatagram, type TrackPropertyValue } from '@openmoq/transport';
import type { DataStreamTerminal, MoqtConnection, TrackSubscription } from '@openmoq/webtransport';
import { SeekFetchRequests, type SeekFetchResponse } from './seek-fetch-requests.js';
import { SeekLiveQueue } from './seek-live-queue.js';

interface Location { readonly groupId: bigint; readonly objectId: bigint; }
export interface SeekLiveBoundary {
  readonly kind: 'joining-fetch' | 'fill';
  /** The initial SUBSCRIBE_OK observation, never the subscription's moving head. */
  readonly head: Location;
  readonly endOfTrack: boolean;
  readonly subscription: TrackSubscription;
  readonly prefixTrackProperties: ReadonlyMap<bigint, readonly TrackPropertyValue[]>;
  readonly liveTrackProperties: ReadonlyMap<bigint, readonly TrackPropertyValue[]>;
}
type Boundary = Omit<SeekLiveBoundary, 'prefixTrackProperties'> & {
  readonly prefixTrackProperties: SeekLiveBoundary['prefixTrackProperties'] | undefined;
};
function copyProperties(properties: ReadonlyMap<bigint, readonly TrackPropertyValue[]> | undefined): Map<bigint, TrackPropertyValue[]> {
  const copy = new Map<bigint, TrackPropertyValue[]>();
  if (properties) for (const [type, values] of properties) {
    copy.set(type, Array.from(values, value => typeof value === 'bigint' ? value : new Uint8Array(value)));
  }
  return copy;
}
function copyBoundary(boundary: Boundary): SeekLiveBoundary {
  if (boundary.prefixTrackProperties === undefined) throw new Error('Seek live prefix response properties are unavailable');
  return Object.freeze({ ...boundary, head: Object.freeze({ ...boundary.head }),
    prefixTrackProperties: copyProperties(boundary.prefixTrackProperties), liveTrackProperties: copyProperties(boundary.liveTrackProperties) });
}
interface Options {
  readonly track: { readonly namespace: readonly string[]; readonly name: string };
  readonly start: Location;
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly isCurrent: () => boolean;
  /** The engine bounds preparation, including authorization and head admission. */
  readonly signal: AbortSignal;
  /** Validated timeline policy, not a Location-to-time guess or a cache claim. */
  readonly admitHead: (head: Location, signal: AbortSignal) => Promise<boolean>;
  readonly capture?: (object: MoqtObject | ObjectDatagram) => object | undefined;
  readonly onDiscard: (input: object) => void | Promise<void>;
  readonly consumePrefix: (object: MoqtObject, input: object | undefined, stillAdmitted: () => boolean) => Promise<void>;
  readonly consumeLive: Options['consumePrefix'];
  readonly onPrefixAccepted: (boundary: SeekLiveBoundary) => void;
  /** Installs the retained consumer's live lease before queued live work resumes. */
  readonly onPrefixDrained: (boundary: SeekLiveBoundary) => Promise<void>;
  readonly onTrackEnded: () => Promise<void>;
  readonly onDeferred: () => void;
  readonly onError: (error: Error) => void;
}
const compare = (a: Location, b: Location): number => a.groupId === b.groupId
  ? a.objectId === b.objectId ? 0 : a.objectId < b.objectId ? -1 : 1
  : a.groupId < b.groupId ? -1 : 1;
const location = (object: MoqtObject): Location => ({ groupId: BigInt(object.groupId), objectId: BigInt(object.objectId) });
const aborted = () => Object.assign(new Error('Seek live bridge retired'), { name: 'AbortError' });

/**
 * A single track's finite-prefix/live boundary. d14/16 §9.16.2 and d18
 * §10.12.2 join the saved subscription Location; d22 §3.4 fills it on the
 * SUBSCRIBE's own FETCH stream.
 * The SDK owns request/alias validation. This class owns bounded application
 * work, and never treats subgroup FIN or an isolated EOT as a drained track.
 * It installs no connection callbacks: the engine routes its global events here.
 */
export class SeekLiveBridge {
  private readonly interruption = new AbortController();
  private readonly requests: SeekFetchRequests;
  private readonly queue: SeekLiveQueue;
  private readonly prefix;
  private readonly live;
  private readonly interrupt = () => this.cancel();
  private readonly datagramInputs: WeakMap<MoqtObject, ObjectDatagram> | null;
  private readonly maxLocationId: bigint;
  private requestId: bigint | null = null;
  private alias: bigint | null = null;
  private boundary: Boundary | null = null;
  private fillStream: bigint | null = null;
  private registering = false;
  private started = false;
  private closed = false;
  private done = false;
  private drained = false;
  private prefixDrained = false;
  private unsubscribeSent = false;

  constructor(private readonly connection: MoqtConnection, private readonly options: Options) {
    const draft = connection.draftVersion;
    if (draft !== 14 && draft !== 16 && draft !== 18 && draft !== 22) {
      throw new RangeError('Seek live bridge requires draft 14, 16, 18 or 22');
    }
    this.maxLocationId = draft < 18 ? MAX_VARINT : MAX_VI64;
    for (const value of [options.start.groupId, options.start.objectId]) {
      if (typeof value !== 'bigint' || value < 0n || value > this.maxLocationId) throw new RangeError('Invalid seek live start Location');
    }
    this.datagramInputs = options.capture ? new WeakMap() : null;
    this.requests = new SeekFetchRequests(connection, { isCurrent: () => this.current(), onError: error => this.fail(error) });
    this.queue = new SeekLiveQueue({
      maxObjects: options.maxObjects, maxBytes: options.maxBytes, isCurrent: () => this.current(),
      ...(options.capture ? { capture: (object: MoqtObject) => options.capture!(this.datagramInputs?.get(object) ?? object) } : {}),
      onDiscard: options.onDiscard,
      consumePrefix: async (object, input, current) => {
        if (compare(location(object), options.start) < 0) { await this.discard(input); return; }
        await options.consumePrefix(object, input, current);
      },
      consumeLive: async (object, input, current) => {
        if (!this.boundary || compare(location(object), this.boundary.head) <= 0) { await this.discard(input); return; }
        await options.consumeLive(object, input, current);
      },
      onPrefixDrained: async () => {
        if (!this.boundary) throw new Error('Seek live prefix drained without an accepted boundary');
        await options.onPrefixDrained(copyBoundary(this.boundary));
        if (!this.current()) return;
        if (this.boundary.endOfTrack) this.cancel();
        else { this.prefixDrained = true; this.maybeEnd(); }
      },
      onTrackEnded: () => options.onTrackEnded(), onError: error => this.fail(error),
    });
    this.prefix = this.queue.openPrefix();
    this.live = this.queue.openLiveStream();
    options.signal.addEventListener('abort', this.interrupt, { once: true });
    if (options.signal.aborted) this.cancel();
  }

  start(): void {
    if (this.started || !this.current()) return;
    this.started = true;
    void this.subscribe().catch(error => { if (this.current()) this.fail(error); });
  }

  handleControl(message: ControlMessage): boolean {
    if (this.requests.handleControl(message)) return true;
    if (message.type !== 'PUBLISH_DONE' || message.requestId !== this.requestId) return false;
    if (this.current()) {
      if (message.statusCode !== 2n) this.fail(new Error(`Seek live subscription ended with status ${message.statusCode}`));
      else { this.done = true; this.maybeEnd(); }
    }
    return true;
  }

  handleStreamOpen(id: bigint, header: DataStreamHeader): boolean {
    if (this.requests.handleStreamOpen(id, header)) return true;
    if (header.type !== 'fetch' || !header.fill || header.header.requestId !== this.requestId) return false;
    if (this.fillStream !== null && this.fillStream !== id) this.fail(new Error('A seek live initial fill opened more than once'));
    else this.fillStream = id;
    return true;
  }
  handleObject(id: bigint, object: MoqtObject): boolean {
    if (id !== this.fillStream) return false;
    if (this.current()) void this.prefix.push(object);
    return true;
  }
  /** Datagram routing still needs the SDK-validated alias of our own request. */
  handleDatagram(object: ObjectDatagram): boolean {
    const alias = this.alias ?? (this.requestId === null ? undefined
      : this.connection.session.getSubscription(this.requestId)?.trackAlias);
    if (alias === undefined || alias === null || object.trackAlias !== alias) return false;
    if (!this.current()) return true;
    const common = { trackAlias: object.trackAlias, groupId: object.groupId, subgroupId: 0n, objectId: object.objectId };
    const normalized: MoqtObject = object.status === undefined
      ? { kind: 'data', ...common, publisherPriority: object.publisherPriority, payload: object.payload,
        properties: object.extensions, extensions: object.extensions }
      : { kind: 'gap', ...common, status: object.status };
    this.datagramInputs?.set(normalized, object);
    try { void this.live.push(normalized); }
    finally { this.datagramInputs?.delete(normalized); }
    return true;
  }
  handleStreamClose(id: bigint, terminal: DataStreamTerminal): boolean {
    if (this.requests.handleStreamClose(id)) return true;
    if (id !== this.fillStream) return false;
    this.fillStream = null;
    if (this.current()) this.prefix.close(terminal);
    return true;
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.signal.removeEventListener('abort', this.interrupt);
    this.interruption.abort(aborted());
    this.queue.cancel(); this.requests.dispose();
    // During onRequestId, throwing back into the SDK rolls back an unsent
    // request. Sending UNSUBSCRIBE there would refer to a request never sent.
    if (!this.registering) this.unsubscribe();
  }

  private current(): boolean {
    if (this.closed || this.options.signal.aborted) return false;
    try { return this.options.isCurrent() && !this.closed && !this.options.signal.aborted; } catch { return false; }
  }
  private async subscribe(): Promise<void> {
    const encoder = new TextEncoder();
    const sub = await this.connection.subscribeTrack(this.options.track.namespace.map(field => encoder.encode(field)),
      encoder.encode(this.options.track.name), {
        filter: { type: 'LargestObject' }, groupOrder: varint(1n),
        ...(this.connection.draftVersion === 22 ? { fill: { filter: {
          type: 'AbsoluteStart' as const, startGroup: this.options.start.groupId, startObject: this.options.start.objectId,
        }, groupOrder: 'ascending' as const } } : {}),
        onRequestId: id => {
          this.registering = true;
          try { this.requestId = id; if (!this.current()) throw aborted(); }
          finally { this.registering = false; }
        },
        onObject: object => { if (this.current()) void this.live.push(object); },
        // Stream Count excludes datagrams. Keep the SDK's effective late-delivery
        // window instead of claiming that processed streams prove all intake ended.
        terminalDelivery: 'drain', terminalDeliveryStatuses: [varint(2n)],
        onDrained: () => { if (this.current()) { this.drained = true; this.maybeEnd(); } },
      });
    this.alias = sub.trackAlias;
    if (!this.current()) { this.unsubscribe(); return; }
    const properties = sub.initialTrackProperties;
    if (!this.current()) { this.unsubscribe(); return; }
    if (properties === undefined) throw new Error('Seek live initial SUBSCRIBE_OK properties are unavailable');
    const liveTrackProperties = copyProperties(properties);
    if (!this.current()) { this.unsubscribe(); return; }
    const initial = sub.initialLargestLocation;
    if (!this.current()) { this.unsubscribe(); return; }
    if (!initial || compare(initial, this.options.start) < 0) { this.defer(); return; }
    const head = Object.freeze({ ...initial });
    const admitted = await this.waitForHead(this.options.admitHead(head, this.interruption.signal));
    if (!this.current()) return;
    if (!admitted) { this.defer(); return; }
    const kind = this.connection.draftVersion === 22 ? 'fill' : 'joining-fetch';
    this.boundary = { kind, head, endOfTrack: false, subscription: sub, liveTrackProperties,
      prefixTrackProperties: kind === 'fill' ? copyProperties(liveTrackProperties) : undefined };
    if (kind === 'fill') this.accept(this.boundary);
    else this.requests.join(sub.requestId, this.options.start.groupId, {
      onObject: object => this.prefix.push(object),
      onClosed: terminal => { if (this.current()) this.prefix.close(terminal); },
    }, response => this.acceptJoin(response));
  }

  private acceptJoin(response: SeekFetchResponse): void {
    const boundary = this.boundary;
    if (!boundary || !this.current()) return;
    // d18 §10.12.2.1 uses the saved Joining Location inclusively. Zero is
    // the whole-group endpoint when the Object successor cannot be encoded.
    const expected = boundary.head.objectId === this.maxLocationId
      ? { group: boundary.head.groupId, object: 0n }
      : { group: boundary.head.groupId, object: boundary.head.objectId + 1n };
    if (response.endLocation.group !== expected.group || response.endLocation.object !== expected.object) {
      throw new Error('Joining FETCH does not end at the initial SUBSCRIBE_OK boundary');
    }
    this.boundary = { ...boundary, endOfTrack: response.endOfTrack, prefixTrackProperties: copyProperties(response.trackProperties) };
    this.accept(this.boundary);
  }
  private accept(boundary: Boundary): void {
    this.options.onPrefixAccepted(copyBoundary(boundary));
    if (this.current()) this.queue.acceptPrefix();
  }
  private maybeEnd(): void {
    // SDK drain owns SUB/FILL, not the separate Joining FETCH or our async
    // prefix work. Sealing intake before that barrier would lose later bytes.
    if (!this.done || !this.drained || !this.prefixDrained) return;
    this.live.close('fin'); this.queue.endTrack();
  }
  private waitForHead(work: Promise<boolean>): Promise<boolean> {
    const signal = this.interruption.signal;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean, failed: boolean, error?: unknown) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', interrupt);
        if (failed) reject(error); else resolve(value);
      };
      const interrupt = () => finish(false, true, aborted());
      void work.then(value => finish(value, false), error => finish(false, true, error));
      if (signal.aborted) interrupt(); else signal.addEventListener('abort', interrupt, { once: true });
    });
  }
  private unsubscribe(): void {
    if (this.unsubscribeSent || this.requestId === null) return;
    this.unsubscribeSent = true;
    try { void this.connection.unsubscribe(this.requestId).catch(() => {}); } catch { /* already closed */ }
  }
  private ownerCurrent(): boolean {
    try { return this.options.isCurrent(); } catch { return false; }
  }
  private async discard(input: object | undefined): Promise<void> {
    if (input !== undefined) await this.options.onDiscard(input);
  }
  private defer(): void {
    const report = this.current(); this.cancel();
    if (report && this.ownerCurrent()) { try { this.options.onDeferred(); } catch { /* observer only */ } }
  }
  private fail(cause: unknown): void {
    const report = this.current(); this.cancel();
    if (report && this.ownerCurrent()) {
      try { this.options.onError(cause instanceof Error ? cause : new Error(String(cause))); } catch { /* observer only */ }
    }
  }
}
