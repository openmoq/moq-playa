import type { MoqtObject } from '../../packages/transport/src/index.js';
import type { MoqtConnection } from '../../packages/webtransport/src/index.js';
import type { MediaSourceLike, MediaDiagnosticsFactory, PlayerDiagnosticSource, PlayerDiagnosticSnapshot } from '../../packages/player/src/index.js';
export interface TailTiming { bmdt: string; duration: string; timescale: number; startSec: number; endSec: number; sha256?: string }
export interface TailCatalogIdentity { readonly namespace: readonly string[]; readonly name: 'catalog' }
interface CatalogRequest { seq: number; atMs: number; connection: number; requestId: string;
  kind: 'subscribe' | 'fetch' | 'joiningFetch'; joiningRequestId: string | null;
  identity: { namespace: string[]; name: string } | null; namespaceFields: number[][] | null; trackNameBytes: number[] | null;
  status: 'reserved' | 'issued' | 'failed' }
interface CatalogHeader { seq: number; atMs: number; connection: number; stream: string; requestId: string }
export interface TailCatalogFetch { expectedIdentity: { namespace: string[]; name: string } | null;
  receiptCapability: 'unavailable'; disclosure: string; unavailableReceiptCount: number;
  requests: CatalogRequest[]; headers: CatalogHeader[];
  deliveries: Array<{ seq: number; atMs: number; connection: number; stream: string; request: number; header: number;
    requestId: string; identity: { namespace: string[]; name: string } }> }
export interface TailReceipt { seq: number; atMs: number; connection: number; stream: string | null; alias: string; group: string; object: string;
  origin: 'subgroup' | 'datagram' | 'group-end'; subgroup: string | null; status: string; payloadBytes: number;
  identity: { namespace: string[]; name: string } | null }
export interface TailTarget extends TailReceipt { heldAtMs: number; releaseIssuedAtMs: number | null; returnedAtMs: number | null;
  cancelled: boolean; raw: TailTiming; fin?: { atMs: number; terminal: string; error: string | null; whilePending: boolean } }
export interface TailSubmission extends TailTiming { seq: number; atMs: number; mediaType: 'video' | 'audio'; trackName: string;
  group: string | null; fingerprint: string; unit: number | null; inputs: (number | null)[]; nativeOperation: number | null;
  outcome: { atMs: number; state: 'appended' | 'discarded'; reason: string | null; stage: number } | null }
export interface TailNativeOperation { seq: number; atMs: number; bufferId: number; mediaType: 'video' | 'audio'; fingerprint: string;
  submission: number | null; offset: number; updatingBefore: boolean; updateAtMs: number | null; updateendAtMs: number | null;
  error: string | null; ranges: number[][] | null; sha256?: string }
export interface GroupTailSnapshot { instrumentation: string; armed: boolean; mode: 'ordinary' | 'held' | null; target: TailTarget | null;
  catalogFetch: TailCatalogFetch;
  successor: (TailReceipt & { whileHeld: boolean }) | null; receipts: TailReceipt[]; submissions: TailSubmission[];
  stages: TailStage[]; diagnostics: TailDiagnostics[]; losses: Record<'overflow' | 'missingReceipt' | 'missingUnit' | 'missingToken' | 'changedInputs' | 'duplicateTerminal', number>;
  operations: TailNativeOperation[]; errors: string[]; closed: boolean }
export interface TailStage { seq: number; atMs: number; unit: number | null; inputs: (number | null)[];
  stage: 'reconstructed' | 'appended' | 'decoded' | 'scheduled' | 'presented' | 'discarded'; reason: string | null }
export type TailCheckpoint = 'baseline-settled' | 'observations-settled' | 'before-player-destroy' | 'after-player-destroy';
export interface TailDiagnostics { seq: number; atMs: number; lifetime: 'before-load-through-player-destroy';
  checkpoint: TailCheckpoint; destroyed: boolean | null; counters: PlayerDiagnosticSnapshot['mediaStages'] | null }
type ReceiptMetadata = Omit<Parameters<Parameters<MoqtConnection['observeObjectReceipts']>[0]>[0], 'receipt'> & { readonly receipt: object };
export interface TailConnection {
  subscribe: MoqtConnection['subscribe'];
  fetch: MoqtConnection['fetch'];
  joiningFetch: MoqtConnection['joiningFetch'];
  observeQlogEvents: MoqtConnection['observeQlogEvents'];
  observeObjectReceipts(listener: (event: ReceiptMetadata) => void | Promise<void>): () => void;
  objectReceiptFor(object: object): object | undefined;
  onMessage?: MoqtConnection['onMessage'];
  onObject?: MoqtConnection['onObject'];
  onStreamClosed?: MoqtConnection['onStreamClosed'];
}
export interface GroupTailProbe {
  observeDiagnostics(source: Pick<PlayerDiagnosticSource, 'observeMediaStages' | 'diagnosticSnapshot'>, createTracker: MediaDiagnosticsFactory): void;
  connection(connection: TailConnection): void;
  transform(object: MoqtObject): MoqtObject | null | Promise<MoqtObject | null>;
  arm(mode: 'ordinary' | 'held'): { atMs: number; mode: 'ordinary' | 'held' };
  wrapSource<T extends MediaSourceLike>(source: T): T;
  installNative(source?: typeof MediaSource, buffer?: typeof SourceBuffer): void;
  snapshot(): GroupTailSnapshot;
  boundarySettled(): boolean;
  settleHashes(): Promise<void>;
  settleObservations(checkpoint: TailCheckpoint): Promise<void>;
  cancel(): void;
  restore(): void;
}
export function createGroupTailProbe(options?: { now?: () => number; delayMs?: number;
  schedule?: (callback: () => void, ms: number) => unknown; unschedule?: (handle: unknown) => void;
  catalogIdentity?: TailCatalogIdentity }): GroupTailProbe;
