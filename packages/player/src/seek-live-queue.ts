import type { MoqtObject } from '@openmoq/transport';
import type { DataStreamTerminal } from '@openmoq/webtransport';

export interface SeekLiveStreamLease {
  push(object: MoqtObject): Promise<void>;
  close(terminal: DataStreamTerminal): void;
}
interface Options {
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly isCurrent: () => boolean;
  readonly capture?: (object: MoqtObject) => object | undefined;
  readonly onDiscard: (input: object) => void | Promise<void>;
  readonly consumePrefix: (object: MoqtObject, input: object | undefined, stillAdmitted: () => boolean) => Promise<void>;
  readonly consumeLive: Options['consumePrefix'];
  readonly onPrefixDrained: () => void | Promise<void>;
  readonly onTrackEnded: () => void | Promise<void>;
  readonly onError: (error: Error) => void | Promise<void>;
}

interface Stream {
  readonly lane: 'prefix' | 'live';
  fin: boolean;
  revoked: boolean;
  pending: number;
}
interface Entry {
  readonly stream: Stream;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  object: MoqtObject | undefined;
  input: object | undefined;
  ready: boolean;
  invoked: boolean;
  done: boolean;
}
const abortError = () => Object.assign(new Error('Seek live queue retired'), { name: 'AbortError' });
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

function copyBytes(view: Uint8Array, length: number): Uint8Array {
  const copy = new Uint8Array(length);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, length));
  return copy;
}

/**
 * Local intake/work ownership only; all protocol proof belongs to the caller.
 * A push reserves bounded credit before capture/copy and settles after its work.
 * Retirement discards unconsumed captured inputs; invoked consumers own theirs.
 */
export class SeekLiveQueue {
  private readonly streams = new Set<Stream>();
  private readonly entries = new Set<Entry>();
  private readonly interruption = new AbortController();
  private prefix: Stream | null = null;
  private prefixQueue: Entry[] = [];
  private liveQueue: Entry[] = [];
  private bytes = 0;
  private prefixAccepted = false;
  private prefixDraining = false;
  private prefixReady = false;
  private endRequested = false;
  private ending = false;
  private running = false;
  private closed = false;

  constructor(private readonly options: Options) {
    if (![options.maxObjects, options.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError('Seek live queue budgets must be positive safe integers');
    }
  }

  openPrefix(): SeekLiveStreamLease {
    this.assertCurrent();
    if (this.prefix) {
      const error = new Error('Seek live queue has exactly one prefix'); this.fail(error); throw error;
    }
    return this.open('prefix');
  }
  openLiveStream(): SeekLiveStreamLease { return this.open('live'); }
  acceptPrefix(): void {
    if (!this.ensureCurrent()) return;
    this.prefixAccepted = true; this.schedule();
  }
  endTrack(): void {
    if (!this.ensureCurrent() || this.endRequested) return;
    this.endRequested = true;
    for (const stream of this.streams) this.releaseStream(stream);
    this.schedule();
  }
  cancel(): void { this.retire(abortError()); }

  private ownerCurrent(): boolean {
    try { return this.options.isCurrent(); } catch { return false; }
  }
  private ensureCurrent(): boolean {
    if (this.closed) return false;
    const current = this.ownerCurrent();
    if (!current && !this.closed) this.cancel();
    return current && !this.closed;
  }
  private assertCurrent(): void { if (!this.ensureCurrent()) throw abortError(); }

  private open(lane: Stream['lane']): SeekLiveStreamLease {
    this.assertCurrent();
    if (this.endRequested) throw new Error('Seek live intake has ended');
    if (this.streams.size >= this.options.maxObjects) {
      const error = new Error('Seek live stream budget exceeded'); this.fail(error); throw error;
    }
    const stream: Stream = { lane, fin: false, revoked: false, pending: 0 };
    this.streams.add(stream);
    if (lane === 'prefix') this.prefix = stream;
    return { push: object => this.push(stream, object), close: terminal => this.close(stream, terminal) };
  }

  private push(stream: Stream, raw: MoqtObject): Promise<void> {
    let resolve!: () => void, reject!: (error: Error) => void;
    const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // SUB/FILL dispatch may ignore the returned Promise. Awaiting callers still
    // receive its original rejection; the class owns every ignored rejection.
    void result.catch(() => {});
    if (!this.ensureCurrent()) { reject(abortError()); return result; }
    if (stream.revoked || stream.fin || this.endRequested) {
      const error = new Error('Seek live stream intake is closed'); this.fail(error); reject(error); return result;
    }
    let entry: Entry | undefined;
    try {
      // Snapshot the byte views charged to this admission before an external
      // capture callback can reenter. Copying happens only after capture.
      const kind = raw.kind;
      const payload = kind === 'data' ? raw.payload : undefined;
      const properties = kind === 'data' ? raw.properties : undefined;
      const extensions = kind === 'data' ? raw.extensions : undefined;
      const trackAlias = raw.trackAlias, groupId = raw.groupId, subgroupId = raw.subgroupId, objectId = raw.objectId;
      const subgroupContainsEndOfGroup = raw.subgroupContainsEndOfGroup, isFirstObjectInSubgroup = raw.isFirstObjectInSubgroup;
      const publisherPriority = kind === 'data' ? raw.publisherPriority : undefined;
      const status = kind === 'gap' ? raw.status : undefined;
      const payloadLength = payload?.byteLength ?? 0, propertiesLength = properties?.byteLength ?? 0;
      const extensionsLength = extensions?.byteLength ?? 0;
      const bytes = payloadLength + propertiesLength + (extensions === properties ? 0 : extensionsLength);
      if (!this.ensureCurrent()) { reject(abortError()); return result; }
      if (this.entries.size >= this.options.maxObjects || bytes > this.options.maxBytes - this.bytes) {
        throw new Error('Seek live Object/byte budget exceeded');
      }
      entry = { stream, bytes, resolve, reject, object: undefined, input: undefined, ready: false, invoked: false, done: false };
      this.entries.add(entry); this.bytes += bytes; stream.pending++;
      (stream.lane === 'prefix' ? this.prefixQueue : this.liveQueue).push(entry);
      const input = this.options.capture?.(raw);
      // A Promise is also an object in TypeScript. Tokens are synchronous;
      // contain an accidentally async observer before transferring ownership.
      if (input && typeof Reflect.get(input, 'then') === 'function') {
        void Promise.resolve(input).catch(() => {});
        throw new TypeError('Seek live capture must be synchronous');
      }
      if (entry.done || !this.ensureCurrent()) {
        // Capture may return its input only after reentrant cancellation.
        this.discard(input); return result;
      }
      entry.input = input;
      // Project the actual MoqtObject fields; capture cannot add uncharged
      // buffers, and a gap cannot retain an extraneous data payload.
      const common = { trackAlias, groupId, subgroupId, objectId,
        ...(subgroupContainsEndOfGroup === undefined ? {} : { subgroupContainsEndOfGroup }),
        ...(isFirstObjectInSubgroup === undefined ? {} : { isFirstObjectInSubgroup }) };
      if (payload) {
        const copiedProperties = properties === undefined ? undefined : copyBytes(properties, propertiesLength);
        const copiedExtensions = extensions === properties ? copiedProperties
          : extensions === undefined ? undefined : copyBytes(extensions, extensionsLength);
        entry.object = { kind: 'data', ...common, publisherPriority, payload: copyBytes(payload, payloadLength),
          ...(copiedProperties === undefined ? {} : { properties: copiedProperties }),
          ...(copiedExtensions === undefined ? {} : { extensions: copiedExtensions }) };
      } else entry.object = { kind: 'gap', ...common, status: status! };
      entry.ready = true; this.schedule();
    } catch (reason) {
      const error = asError(reason); this.fail(error);
      if (!entry) reject(error);
    }
    return result;
  }

  private close(stream: Stream, terminal: DataStreamTerminal): void {
    if (!this.ensureCurrent()) return;
    if (terminal !== 'fin') {
      stream.revoked = true; this.fail(new Error(`Seek live stream ended with ${terminal}`)); return;
    }
    stream.fin = true; this.releaseStream(stream); this.schedule();
  }
  private releaseStream(stream: Stream): void {
    if (stream.pending === 0 && (stream.fin || this.endRequested)) this.streams.delete(stream);
  }

  private schedule(): void {
    if (this.closed || this.running) return;
    this.running = true;
    queueMicrotask(() => { void this.run(); });
  }
  private runnable(): boolean {
    if (this.closed) return false;
    if (!this.prefixReady) return this.prefixAccepted && (this.prefixQueue[0]?.ready === true
      || !!this.prefix?.fin && this.prefix.pending === 0 && !this.prefixDraining);
    return this.liveQueue[0]?.ready === true
      || this.endRequested && !this.ending && this.entries.size === 0;
  }
  private async run(): Promise<void> {
    try {
      while (this.ensureCurrent()) {
        if (!this.prefixReady) {
          if (!this.prefixAccepted) return;
          if (this.prefixQueue.length) {
            if (!this.prefixQueue[0]!.ready) return;
            await this.consume(this.prefixQueue.shift()!); continue;
          }
          if (!this.prefix?.fin || this.prefix.pending !== 0 || this.prefixDraining) return;
          this.prefixDraining = true;
          await this.wait(Promise.resolve(this.options.onPrefixDrained()));
          if (!this.ensureCurrent()) return;
          this.prefixReady = true; continue;
        }
        if (this.liveQueue.length) {
          if (!this.liveQueue[0]!.ready) return;
          await this.consume(this.liveQueue.shift()!); continue;
        }
        if (this.endRequested && !this.ending && this.entries.size === 0) {
          this.ending = true;
          await this.wait(Promise.resolve(this.options.onTrackEnded()));
          this.ensureCurrent();
        }
        return;
      }
    } catch (error) { if (!this.closed) { if (this.ownerCurrent()) this.fail(asError(error)); else this.cancel(); } }
    finally { this.running = false; if (this.runnable()) this.schedule(); }
  }

  private async consume(entry: Entry): Promise<void> {
    if (!this.ensureCurrent()) return;
    entry.invoked = true;
    const consume = entry.stream.lane === 'prefix' ? this.options.consumePrefix : this.options.consumeLive;
    const stillAdmitted = () => !this.closed && !entry.stream.revoked && this.ownerCurrent() && !this.closed;
    await this.wait(Promise.resolve(consume(entry.object!, entry.input, stillAdmitted)));
    if (!this.ensureCurrent() || entry.done) return;
    entry.done = true; this.entries.delete(entry); this.bytes -= entry.bytes; entry.stream.pending--;
    entry.object = undefined; entry.input = undefined; this.releaseStream(entry.stream); entry.resolve();
  }

  /** Removable cancellation listeners: no per-Object reactions on a lifetime Promise. */
  private wait(work: Promise<void>): Promise<void> {
    const signal = this.interruption.signal;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, failed: boolean) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', interrupted);
        if (failed) reject(error); else resolve();
      };
      const interrupted = () => { finish(signal.reason, true); };
      void work.then(() => { finish(undefined, false); }, error => { finish(error, true); });
      if (signal.aborted) interrupted(); else signal.addEventListener('abort', interrupted, { once: true });
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    const report = this.ownerCurrent();
    if (this.closed) return;
    this.retire(error);
    if (report && this.ownerCurrent()) {
      try { void Promise.resolve(this.options.onError(error)).catch(() => {}); } catch { /* Error observers cannot strand cleanup. */ }
    }
  }
  private retire(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.entries], discarded: object[] = [];
    this.entries.clear(); this.prefixQueue = []; this.liveQueue = []; this.bytes = 0;
    for (const stream of this.streams) stream.revoked = true;
    this.streams.clear();
    for (const entry of entries) {
      entry.done = true; entry.stream.pending--;
      if (!entry.invoked && entry.input !== undefined) discarded.push(entry.input);
      entry.object = undefined; entry.input = undefined; entry.reject(error);
    }
    this.interruption.abort(error);
    // Fixed retirement outcomes are cleanup, not delivery into the next owner.
    for (const input of discarded) this.discard(input);
  }
  private discard(input: object | undefined): void {
    if (input === undefined) return;
    try { void Promise.resolve(this.options.onDiscard(input)).catch(() => {}); }
    catch { /* Retirement outcomes cannot change media ownership or its error. */ }
  }
}
