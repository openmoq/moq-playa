import type { AttachmentTarget, Batch, Snapshot } from './model.js';

/** Context/port binding is the host's responsibility; tab numbers are not owner identities. */
export function sameTarget(left: AttachmentTarget, right: AttachmentTarget): boolean {
  return left.ownerId === right.ownerId && left.sourceId === right.sourceId
    && left.runId === right.runId && left.attachmentId === right.attachmentId;
}

export interface StreamCursor {
  readonly target: AttachmentTarget;
  readonly watermark: string;
  readonly clocks: readonly string[];
}
export type CursorResult =
  | { readonly kind: 'accept'; readonly cursor: StreamCursor; readonly lost: boolean }
  | { readonly kind: 'ignore'; readonly reason: 'different-target' | 'already-applied' }
  | { readonly kind: 'resnapshot'; readonly reason: 'sequence-gap' | 'sequence-overlap' | 'unknown-clock' };

export type SnapshotDecision =
  | { readonly kind: 'accept'; readonly cursor: StreamCursor }
  | { readonly kind: 'ignore'; readonly reason: 'different-target' | 'stale-snapshot' | 'scoped-snapshot' };

/** Refresh a bound stream only after the host has correlated the snapshot reply. */
export function refreshCursor(cursor: StreamCursor, snapshot: Snapshot): SnapshotDecision {
  if (!sameTarget(cursor.target, snapshot.target)) return { kind: 'ignore', reason: 'different-target' };
  if (snapshot.scope.kind !== 'source') return { kind: 'ignore', reason: 'scoped-snapshot' };
  if (BigInt(snapshot.watermark) < BigInt(cursor.watermark)) return { kind: 'ignore', reason: 'stale-snapshot' };
  return { kind: 'accept', cursor: cursorFromSnapshot(snapshot) };
}

export function cursorFromSnapshot(snapshot: Snapshot): StreamCursor {
  if (snapshot.scope.kind !== 'source') throw new Error('A stream cursor requires a source snapshot');
  return { target: { ...snapshot.target }, watermark: snapshot.watermark, clocks: snapshot.clocks.map(clock => clock.id) };
}

/** Call only with decoded messages. The host applies accepted events and retains loss notices. */
export function advanceCursor(cursor: StreamCursor, batch: Batch): CursorResult {
  if (!sameTarget(cursor.target, batch.target)) return { kind: 'ignore', reason: 'different-target' };
  const watermark = BigInt(cursor.watermark);
  const from = BigInt(batch.fromSeq), to = BigInt(batch.toSeq);
  if (to <= watermark) return { kind: 'ignore', reason: 'already-applied' };
  if (from <= watermark) return { kind: 'resnapshot', reason: 'sequence-overlap' };
  if (from !== watermark + 1n) return { kind: 'resnapshot', reason: 'sequence-gap' };
  if (batch.events.some(event => !cursor.clocks.includes(event.clockId))) {
    return { kind: 'resnapshot', reason: 'unknown-clock' };
  }
  return { kind: 'accept', cursor: { ...cursor, watermark: batch.toSeq },
    lost: batch.dropped.dense !== '0' || batch.dropped.sparse !== '0' };
}
