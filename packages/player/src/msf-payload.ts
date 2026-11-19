import { locWireProfileForDraft } from '@openmoq/loc';
import { decodePropertyBlock, type TrackPropertyValue } from '@openmoq/transport';

/** MSF-02 §13.7: cap each expanded JSON object at 8 MiB. */
const MAX_EXPANDED = 8 * 1024 * 1024;
export type MsfProperties = ReadonlyMap<bigint, readonly TrackPropertyValue[]>;
export function compressionFormat(payload: Uint8Array): boolean | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload));
    if (value?.streamingFormat !== undefined || typeof value?.version === 'number') return false;
    if (value?.version !== undefined) return ['1', 'draft-01', 'draft-02'].includes(value.version);
  } catch { /* Compressed or invalid bytes: the owning parser decides after preparation. */ }
  return undefined;
}

async function gunzip(payload: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(payload.slice()); controller.close(); } });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EXPANDED) throw new Error('expanded payload exceeds 8 MiB');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new Error(`MSF_COMPRESSION 1: ${error instanceof Error ? error.message : String(error)}`);
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Track properties govern when a publisher incorrectly signals both mechanisms (§12.1). */
export function prepareMsfPayload(payload: Uint8Array, properties: Uint8Array | undefined, track: MsfProperties,
  draft: number, supported: boolean | undefined, catalog = false): Uint8Array | Promise<Uint8Array> {
  const enabled = catalog ? compressionFormat(payload) ?? supported : supported;
  if (enabled === false) return payload;
  const profile = locWireProfileForDraft(draft);
  const value = track.get(0x78n)?.[0] ?? (properties ? decodePropertyBlock(properties, 0, { profile }).entries.find(p => p.id === 0x78n)?.value : undefined) ?? 0n;
  if (value === 0n) return payload;
  if (value !== 1n) throw new Error(`MSF_COMPRESSION ${String(value)} is unsupported`);
  return gunzip(payload).then(bytes => catalog && compressionFormat(bytes) === false ? payload : bytes);
}

/** One owner's bounded preparation queue, including its terminal barriers. */
export class MsfPayloadQueue {
  private tasks: (() => void)[] = [];
  private busy = false;
  private replaying = false;
  private count = 0;
  private pumping = false;
  defer(action: () => void): boolean {
    if (this.replaying || !this.busy && !this.tasks.length) return false;
    this.tasks.push(() => { this.replaying = true; try { action(); } finally { this.replaying = false; } });
    return true;
  }
  run(prepare: () => Uint8Array | Promise<Uint8Array>, consume: (bytes: Uint8Array) => void,
    failure: (error: Error) => void, current: () => boolean): void {
    // Retain input by reference; only expanded output has a byte limit (§13.7).
    if (this.count >= 256) {
      failure(new Error('MSF_COMPRESSION preparation queue exceeded its bound')); return;
    }
    this.count++;
    const finish = (bytes?: Uint8Array, error?: unknown) => {
      this.count--; this.busy = true;
      try {
        if (current()) {
          if (error !== undefined) failure(error instanceof Error ? error : new Error(String(error)));
          else {
            this.replaying = true;
            try { consume(bytes!); } catch (cause) { if (current()) failure(cause instanceof Error ? cause : new Error(String(cause))); }
            finally { this.replaying = false; }
          }
        }
      } finally { this.busy = false; this.pump(); }
    };
    this.tasks.push(() => {
      if (!current()) { finish(); return; }
      let result: Uint8Array | Promise<Uint8Array>;
      try { result = prepare(); } catch (error) { finish(undefined, error); return; }
      if (result instanceof Promise) { this.busy = true; void result.then(b => finish(b), e => finish(undefined, e)); }
      else finish(result);
    });
    this.pump();
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try { while (!this.busy && this.tasks.length) this.tasks.shift()!(); } finally { this.pumping = false; }
  }
}

interface PropertiesCell { error?: Error; subscription?: boolean; closed?: boolean; refused?: boolean; request?: bigint; value?: MsfProperties; promise?: Promise<MsfProperties>; resolve?: (value: MsfProperties) => void; }
/** Per-connection property provenance; payloads retain their own FETCH response. */
export class MsfPayloadSource {
  private aliases = new Map<bigint, PropertiesCell>();
  private requests = new Map<bigint, PropertiesCell>();
  private streams = new Map<bigint, PropertiesCell>();
  private objects = new WeakMap<Uint8Array, PropertiesCell>();
  constructor(private readonly draft: number, private readonly refuse: (request: bigint, subscription: boolean) => void = () => {},
    private readonly connectionTimeoutMs = 5000) {}
  private cell(map: Map<bigint, PropertiesCell>, key: bigint): PropertiesCell {
    let cell = map.get(key);
    if (!cell) {
      if (map.size >= 4096) return { error: new Error('MSF_COMPRESSION property ownership exceeded 4096 entries') };
      cell = {}; map.set(key, cell);
    }
    return cell;
  }
  accept(request: bigint, properties: MsfProperties, alias?: bigint): void {
    for (const cell of [this.cell(this.requests, request), ...(alias === undefined ? [] : [this.cell(this.aliases, alias)])]) {
      cell.subscription = alias !== undefined; cell.request = request; cell.value = properties; cell.resolve?.(properties);
      if (cell.closed && !cell.subscription) this.requests.delete(request);
    }
  }
  isFetch(id: bigint): boolean { return this.streams.has(id); }
  stream(id: bigint, request: bigint): void { const cell = this.cell(this.requests, request); cell.request = request; this.streams.set(id, cell); }
  closeStream(id: bigint): void {
    const cell = this.streams.get(id); this.streams.delete(id);
    if (cell) { cell.closed = true; if (cell.value && !cell.subscription && cell.request !== undefined) this.requests.delete(cell.request); }
  }
  forget(request: bigint | null, alias: bigint | null): void {
    if (request !== null) this.requests.delete(request);
    if (alias !== null) this.aliases.delete(alias);
  }
  observe(payload: Uint8Array, alias: bigint, stream?: bigint): void {
    this.objects.set(payload, (stream === undefined ? undefined : this.streams.get(stream)) ?? this.cell(this.aliases, alias));
  }
  request(payload: Uint8Array): bigint | undefined { return this.objects.get(payload)?.request; }
  copy(from: Uint8Array, to: Uint8Array): void { const cell = this.objects.get(from); if (cell) this.objects.set(to, cell); }
  header(payload: Uint8Array): Uint8Array | undefined {
    const value = this.objects.get(payload)?.value?.get(0x7Bn)?.[0];
    return value instanceof Uint8Array ? value.slice() : undefined;
  }
  properties(payload: Uint8Array): MsfProperties | Promise<MsfProperties> {
    if (this.draft < 18) return new Map();
    const cell = this.objects.get(payload);
    if (!cell) return new Map();
    if (cell.error) throw cell.error;
    if (cell.value) return cell.value;
    if (!cell.promise) cell.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MSF_COMPRESSION track properties were not received within ${this.connectionTimeoutMs} ms`)), this.connectionTimeoutMs);
      cell.resolve = value => { clearTimeout(timer); resolve(value); };
    });
    return cell.promise;
  }
  read(payload: Uint8Array, properties: Uint8Array | undefined, supported: boolean | undefined, catalog: boolean): Uint8Array | Promise<Uint8Array> {
    if ((catalog ? compressionFormat(payload) ?? supported : supported) === false) return payload;
    const track = this.properties(payload);
    const prepare = (value: MsfProperties) => {
      const compression = value.get(0x78n)?.[0], cell = this.objects.get(payload);
      if (compression !== undefined && compression !== 0n && compression !== 1n && cell?.request !== undefined && !cell.refused) {
        cell.refused = true; this.refuse(cell.request, cell.subscription === true);
      }
      return prepareMsfPayload(payload, properties, value, this.draft, supported, catalog);
    };
    return track instanceof Promise ? track.then(prepare) : prepare(track);
  }
}
