export interface ScheduleStep { atMs: number; rateBps: number }
export interface LinkOptions {
  /** Bottleneck rate; omitted or Infinity leaves the direction unshaped. */
  rateBps?: number;
  delayMs?: number;
  jitterMs?: number;
  queueBytes?: number;
  lossPct?: number;
  /** Piecewise-constant capacity, relative to the link's first packet. */
  schedule?: readonly ScheduleStep[];
}
export interface LinkParams {
  shaped: boolean; rateBps: number | null; delayMs: number; jitterMs: number; lossPct: number;
  queueBytes: number | null; schedule: ScheduleStep[];
}
export interface PacketRecord {
  index: number; size: number; enqueuedMs: number; dropped?: 'loss' | 'tail'; queueBytes?: number;
  finishMs?: number; jitterMs?: number; intendedMs?: number; actualMs?: number; lateMs?: number;
}
export interface TimelineSample {
  tMs: number; queueBytes: number; queuePackets: number; inFlightPackets: number; deliveredBps: number; rateBps: number | null;
}
export interface LinkStats {
  params: LinkParams;
  firstPacketMs: number | null;
  offeredPackets: number; offeredBytes: number; deliveredPackets: number; deliveredBytes: number;
  lossPackets: number; lossBytes: number; tailPackets: number; tailBytes: number;
  deliveredBps: number | null;
  /** Actual minus intended send time. */
  lateness: { meanMs: number | null; p50Ms: number | null; p90Ms: number | null; p99Ms: number | null; maxMs: number };
  queue: { bytes: number; packets: number; maxBytes: number; maxPackets: number; inFlightPackets: number };
  timeline: TimelineSample[];
  packets?: PacketRecord[];
}
export interface LinkRuntime { seed?: number; recordPackets?: boolean; maxRecords?: number; sampleIntervalMs?: number; spinMs?: number }
export interface Link {
  readonly params: LinkParams;
  enqueue(packet: Buffer, deliver: (packet: Buffer) => void): void;
  stats(): LinkStats;
  close(): void;
}
export interface ShaperStats {
  startedAt: string; startedAtEpochMs: number; listen: { host: string; port: number }; upstream: { host: string; port: number };
  seed: number; clients: number; errors: string[]; down: LinkStats; up: LinkStats;
}
export interface ShaperOptions {
  listen?: number; listenHost?: string;
  upstream: string | { host?: string; port: number };
  down?: LinkOptions; up?: LinkOptions;
  seed?: number; recordPackets?: boolean;
  /** Written by close(). */
  statsFile?: string;
  socketBufferBytes?: number; spinMs?: number;
}
export interface Shaper { readonly port: number; stats(): ShaperStats; close(): Promise<ShaperStats> }

export function seededRandom(seed: number): () => number;
export function defaultQueueBytes(rateBps: number, delayMs?: number): number;
export function createLink(options?: LinkOptions, runtime?: LinkRuntime): Link;
export function createShaper(options: ShaperOptions): Promise<Shaper>;
