import type { AttachmentTarget, SnapshotScope, SourceDescriptor } from '@openmoq/devtools-protocol';

export type CaptureLane = 'dense' | 'sparse';

export interface CaptureLimits {
  readonly stateMaxEvents: number;
  readonly stateMaxBytes: number;
  readonly historyMaxEvents: number;
  readonly historyMaxBytes: number;
  readonly historyMaxAgeMs: number;
  readonly pendingMaxEvents: number;
  readonly pendingMaxBytes: number;
  readonly maxAttachments: number;
}

export interface CaptureOptions {
  readonly source: SourceDescriptor;
  readonly clock: { readonly id: string; readonly now: () => number };
  readonly limits?: Partial<CaptureLimits>;
  /** Permit read-only attachment to retained ended evidence. Never reactivates observers. */
  readonly allowEndedAttachments?: boolean;
  /**
   * Synchronously install/remove additive observers after the attachment map changes.
   * May emit baseline facts. Notifications can nest on reentry; exceptions are contained.
   * Returned promises are not awaited and cannot defer observer ownership.
   */
  readonly onActiveChange?: (active: boolean) => void;
}

/** The host binds each lease to its actual port/context. An ownerId is not authentication. */
export interface CaptureLease {
  /** A detached copy, never writable authority. */
  readonly target: AttachmentTarget;
  /** A contiguous batch including accounted drops, or null when drained/closed; no caller input to validate. */
  pull(): string | null;
  /**
   * Source: pending batch then snapshot. Detail: snapshot only, no cursor/queue change.
   * Throws on invalid requestId/scope or reentrant clock access. Works after source end.
   * A closed lease returns [] without validating the request.
   */
  refresh(requestId: string, scope?: SnapshotScope): readonly string[];
  /** Idempotently release this lease. Activity callback failures are contained. */
  close(): void;
}

export interface CaptureAttachment {
  readonly lease: CaptureLease;
  readonly snapshot: string;
}
