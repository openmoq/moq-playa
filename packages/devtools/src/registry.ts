import type { DiagnosticCapture } from './capture.js';
import type { CaptureLease } from './types.js';
import { TraceExport } from './trace-export.js';
import { decodeMessage, encodeMessage, MAX_MESSAGE_BYTES, projectSource, PROTOCOL_VERSION, sameTarget } from '@openmoq/devtools-protocol';
import type { AttachmentTarget, Message, SourceDescriptor, RegistryCloseReason } from '@openmoq/devtools-protocol';
export type { RegistryCloseReason } from '@openmoq/devtools-protocol';

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
const sourceKey = (sourceId: string, runId: string): string => JSON.stringify([sourceId, runId]);

export interface RegistryLimits {
  readonly maxSources: number;
  readonly maxDescriptorBytes: number;
  readonly maxConnections: number;
  /** Lifetime registration count, including retired identities. Exhaustion refuses new registrations. */
  readonly maxRegistrations: number;
}

/** Bind this handle to one actual host port/document, never look it up by a supplied ownerId. */
export interface DiagnosticHostConnection {
  readonly closed: boolean;
  readonly closedReason: RegistryCloseReason | null;
  /** Zero to two encoded replies. A queued withdrawal precedes the command reply. */
  request(encoded: unknown): readonly string[];
  /** One withdrawal notification or delivery batch, or null. Never a network action. */
  pull(): string | null;
  close(): void;
}

export interface DiagnosticRecorder {
  start(): void;
  stop(): void;
  dump(): string;
  dispose(): void;
}
export interface RecordingOptions {
  /** Create an independent recorder whose retained bytes obey this limit. */
  readonly createRecorder: (limits: { readonly maxBytes: number }) => DiagnosticRecorder;
}
interface Recording {
  id: string;
  token: string;
  target: AttachmentTarget;
  recorder: DiagnosticRecorder | null;
  active: boolean;
}
interface Binding {
  registration: Registration;
  lease: CaptureLease;
  requestId: string;
  recording: Recording | null;
}
interface Registration {
  readonly key: string;
  readonly capture: DiagnosticCapture;
  readonly descriptor: SourceDescriptor;
  readonly bytes: number;
  readonly options: RecordingOptions | undefined;
  readonly recordings: Set<Recording>;
  activeRecording: Recording | null;
  recordingBusy: boolean;
}

interface RegistryAccess {
  list(): readonly SourceDescriptor[];
  find(sourceId: string, runId: string): Registration | undefined;
  owns(registration: Registration): boolean;
  release(connection: HostConnection): void;
}

type Request = Extract<Message, { kind: 'discover' | 'attach' | 'snapshot.request' | 'detach'
  | 'record.start' | 'record.stop' | 'record.export' }>;
type ErrorCode = Extract<Message, { kind: 'error' }>['code'];

class HostConnection implements DiagnosticHostConnection {
  private reason: RegistryCloseReason | null = null;
  private busy = false;
  private binding: Binding | null = null;
  private exporting: TraceExport | null = null;
  private exportTurn = true;
  private withdrawal: string | null = null;

  constructor(private readonly ownerId: string, private readonly registry: RegistryAccess) {}

  get closed(): boolean { return this.reason !== null; }
  get closedReason(): RegistryCloseReason | null { return this.reason; }

  request(encoded: unknown): readonly string[] {
    if (this.closed) return [];
    if (this.busy) { this.terminate('reentrant-request'); return []; }
    this.busy = true;
    try {
      const result = decodeMessage(encoded);
      if (!result.ok) { this.terminate('invalid-message'); return []; }
      const message = result.message;
      switch (message.kind) {
        case 'discover': case 'attach': case 'snapshot.request': case 'detach':
        case 'record.start': case 'record.stop': case 'record.export':
          return this.dispatch(message);
        default: this.terminate('unexpected-message'); return [];
      }
    } finally { this.busy = false; }
  }

  pull(): string | null {
    if (this.closed) return null;
    if (this.busy) { this.terminate('reentrant-request'); return null; }
    const withdrawal = this.takeWithdrawal();
    if (withdrawal !== null) return withdrawal;
    const binding = this.binding;
    if (!binding || !this.registry.owns(binding.registration)) return null;
    if (this.exporting && this.exportTurn) {
      this.exportTurn = false;
      const frame = this.pullExport();
      if (frame !== null) return frame;
      this.exporting = null;
    }
    this.exportTurn = true;
    const batch = binding.lease.pull();
    if (batch !== null) return batch;
    const frame = this.pullExport();
    if (frame === null) this.exporting = null;
    return frame;
  }

  private pullExport(): string | null {
    const stream = this.exporting;
    if (!stream) return null;
    const frame = stream.next();
    if (stream.done) this.exporting = null;
    return frame;
  }

  close(): void { this.terminate('owner-closed'); }

  terminate(reason: RegistryCloseReason): void {
    if (this.closed) return;
    this.reason = reason;
    this.withdrawal = null;
    this.registry.release(this);
    const binding = this.binding;
    this.binding = null;
    if (binding) { this.releaseRecording(binding); binding.lease.close(); }
  }

  revoke(registration: Registration): void {
    if (this.binding?.registration !== registration) return;
    const binding = this.binding;
    this.binding = null;
    // The original attach remains a lifecycle correlation until its target is released.
    this.withdrawal = encodeMessage({ ...common, kind: 'error', requestId: binding.requestId,
      target: binding.lease.target, code: 'not-found', message: 'Diagnostic source was withdrawn' });
    this.releaseRecording(binding);
    binding.lease.close();
  }

  private takeWithdrawal(): string | null {
    const frame = this.withdrawal;
    this.withdrawal = null;
    return frame;
  }

  private error(request: Request, code: ErrorCode, message: string): readonly string[] {
    if (this.closed) return [];
    const target: AttachmentTarget | null = 'target' in request && 'attachmentId' in request.target ? request.target : null;
    return [encodeMessage({ ...common, kind: 'error', requestId: request.requestId, target, code, message })];
  }

  private dispatch(request: Request): readonly string[] {
    const ownerId = request.kind === 'discover' ? request.ownerId : request.target.ownerId;
    if (ownerId !== this.ownerId) return this.error(request, 'not-owner', 'Command does not belong to this connection');
    const withdrawal = this.takeWithdrawal();
    const frames = this.dispatchOwned(request);
    if (this.closed) return [];
    return withdrawal === null ? frames : [withdrawal, ...frames];
  }

  private dispatchOwned(request: Request): readonly string[] {
    if (request.kind === 'discover') {
      return [encodeMessage({ ...common, kind: 'hello', requestId: request.requestId,
        ownerId: this.ownerId, sources: this.registry.list() })];
    }
    if (request.kind === 'attach') {
      if (this.binding) return this.error(request, 'invalid-state', 'Detach the current source before attaching');
      const registration = this.registry.find(request.target.sourceId, request.target.runId);
      if (!registration) return this.error(request, 'not-found', 'Diagnostic source is not registered');
      let attached;
      try { attached = registration.capture.attach(this.ownerId, request.requestId); }
      catch { return this.error(request, 'invalid-state', 'Diagnostic source cannot be attached'); }
      // Activation can revoke registration, close this owner, or dispose the registry.
      if (this.closed || !this.registry.owns(registration)) {
        attached.lease.close();
        return this.error(request, 'not-found', 'Diagnostic source is no longer registered');
      }
      this.binding = { registration, lease: attached.lease, requestId: request.requestId, recording: null };
      return [attached.snapshot];
    }
    const binding = this.binding;
    if (!binding || !this.registry.owns(binding.registration) || !sameTarget(binding.lease.target, request.target)) {
      return this.error(request, 'not-found', 'Diagnostic attachment is not current');
    }
    if (request.kind === 'snapshot.request') {
      let frames;
      try { frames = binding.lease.refresh(request.requestId, request.scope); }
      catch { return this.error(request, 'invalid-state', 'Diagnostic snapshot is unavailable'); }
      if (this.closed || this.binding !== binding || !this.registry.owns(binding.registration)) {
        return this.error(request, 'not-found', 'Diagnostic attachment is no longer current');
      }
      return frames;
    }
    if (request.kind === 'detach') {
      this.binding = null;
      this.releaseRecording(binding);
      binding.lease.close();
      return this.closed ? [] : [encodeMessage({ ...common, kind: 'ack', requestId: request.requestId, target: request.target })];
    }
    return this.record(request, binding);
  }

  private current(binding: Binding): boolean {
    return !this.closed && this.binding === binding && this.registry.owns(binding.registration);
  }

  private publishRecording(reg: Registration, stopped: Recording): void {
    const active = reg.activeRecording;
    reg.capture.emit({ kind: 'recording', recordingId: active?.id ?? stopped.id,
      ownerAttachmentId: active?.target.attachmentId ?? stopped.target.attachmentId,
      state: active ? 'recording' : 'stopped' }, 'sparse');
  }

  private releaseRecording(binding: Binding): void {
    this.exporting?.close(); this.exporting = null;
    const session = binding.recording; binding.recording = null;
    if (!session) return;
    const reg = binding.registration, wasBusy = reg.recordingBusy;
    reg.recordingBusy = true;
    const active = session.active; session.active = false;
    if (reg.activeRecording === session) reg.activeRecording = null;
    reg.recordings.delete(session);
    const recorder = session.recorder; session.recorder = null;
    try {
      if (active) { try { recorder?.stop(); } catch { /* Keep releasing authority. */ } }
      try { recorder?.dispose(); } catch { /* Diagnostic cleanup cannot escape into playback. */ }
      this.publishRecording(reg, session);
    } finally { reg.recordingBusy = wasBusy; }
  }

  private record(request: Extract<Request, { kind: 'record.start' | 'record.stop' | 'record.export' }>, binding: Binding): readonly string[] {
    const reg = binding.registration;
    if (!reg.options) return this.error(request, 'unsupported', 'Recording commands are not available');
    if (reg.recordingBusy) return this.error(request, 'invalid-state', 'Recording operation is already in progress');
    reg.recordingBusy = true;
    try {
      if (request.kind === 'record.start') {
        if (!reg.capture.active) return this.error(request, 'invalid-state', 'Diagnostic source has ended');
        if (reg.activeRecording) return this.error(request, 'invalid-state', 'A recording is already active');
        if (!binding.recording && reg.recordings.size >= 8) return this.error(request, 'limit', 'Recording retention limit reached');
        this.releaseRecording(binding);
        if (!this.current(binding)) return this.error(request, 'not-found', 'Attachment is no longer current');
        const session: Recording = { id: crypto.randomUUID(), token: crypto.randomUUID(), target: binding.lease.target, recorder: null, active: true };
        binding.recording = session; reg.recordings.add(session); reg.activeRecording = session;
        const recorder = reg.options.createRecorder({ maxBytes: 8 * 1024 * 1024 });
        if (!this.current(binding)) {
          try { recorder.dispose(); } catch { /* Discard an unowned late factory result. */ }
          return this.error(request, 'not-found', 'Attachment is no longer current');
        }
        session.recorder = recorder; recorder.start();
        if (!this.current(binding)) return this.error(request, 'not-found', 'Attachment is no longer current');
        this.publishRecording(reg, session);
        return this.current(binding) ? [encodeMessage({ ...common, kind: 'record.started', requestId: request.requestId,
          target: session.target, recordingId: session.id, token: session.token })] : this.error(request, 'not-found', 'Attachment is no longer current');
      }
      const session = binding.recording;
      if (!session || session.id !== request.recordingId || session.token !== request.token) return this.error(request, 'not-owner', 'Recording does not belong to this attachment');
      if (request.kind === 'record.stop') {
        if (session.active) {
          session.active = false;
          if (reg.activeRecording === session) reg.activeRecording = null;
          session.recorder!.stop();
          this.publishRecording(reg, session);
        }
        return this.current(binding) ? [encodeMessage({ ...common, kind: 'ack', requestId: request.requestId, target: session.target })]
          : this.error(request, 'not-found', 'Attachment is no longer current');
      }
      if (session.active) return this.error(request, 'invalid-state', 'Stop the recording before exporting');
      if (this.exporting) return this.error(request, 'invalid-state', 'An export is already in progress');
      let text: string;
      try { text = session.recorder!.dump(); }
      catch { return this.error(request, 'internal', 'Recording export could not be serialized'); }
      if (!this.current(binding)) return this.error(request, 'not-found', 'Attachment is no longer current');
      let stream: TraceExport;
      try { stream = new TraceExport({ target: session.target, requestId: request.requestId, exportId: crypto.randomUUID(), text }); }
      catch { return this.error(request, 'limit', 'Recording cannot be exported within byte and Unicode limits'); }
      this.exporting = stream; this.exportTurn = true;
      return [this.pullExport()!];
    } catch {
      this.releaseRecording(binding);
      return this.error(request, 'internal', 'Recording operation failed');
    } finally { reg.recordingBusy = false; }
  }
}

/** Explicitly exposed page sources. No DOM, timers, transports or automatic attachment. */
export class DiagnosticRegistry {
  private readonly admittedKind: 'attached' | 'probe';
  private readonly limits: RegistryLimits;
  private readonly sources = new Map<string, Registration>();
  private readonly seen = new Set<string>();
  private readonly connections = new Map<string, HostConnection>();
  private descriptorBytes = 0;
  private disposed = false;

  constructor(options: { readonly limits?: Partial<RegistryLimits>; readonly sourceKind?: 'attached' | 'probe' } = {}) {
    this.admittedKind = options.sourceKind ?? 'attached';
    if (this.admittedKind !== 'attached' && this.admittedKind !== 'probe') throw new Error('Invalid diagnostic source kind');
    this.limits = { maxSources: 32, maxDescriptorBytes: 131072, maxConnections: 8, maxRegistrations: 1024, ...options.limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Registry limits must be positive safe integers');
    }
    if (this.limits.maxSources > 64 || this.limits.maxDescriptorBytes > MAX_MESSAGE_BYTES - 2048) {
      throw new Error('Registry limits exceed discovery wire bounds');
    }
  }

  /** Probe registries are owner-local and cannot be installed on a page bridge. */
  get sourceKind(): 'attached' | 'probe' { return this.admittedKind; }

  /** Discovery-only registration. Revoke releases this registry's leases, not the application source. */
  register(capture: DiagnosticCapture, options?: RecordingOptions): () => void {
    if (this.disposed) throw new Error('Diagnostic registry is disposed');
    if (options && typeof options.createRecorder !== 'function') throw new Error('Invalid diagnostic recorder factory');
    const descriptor = projectSource(capture.descriptor);
    if (descriptor.kind !== this.admittedKind) throw new Error(`Diagnostic registry accepts ${this.admittedKind} sources only`);
    const key = sourceKey(descriptor.sourceId, descriptor.runId);
    if (this.seen.has(key)) throw new Error('Diagnostic source/run identity was already registered');
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor)).byteLength + 1;
    if (this.sources.size >= this.limits.maxSources || this.seen.size >= this.limits.maxRegistrations
      || bytes > this.limits.maxDescriptorBytes - this.descriptorBytes) throw new Error('Diagnostic registration limit reached');
    const registration: Registration = { key, capture, descriptor, bytes,
      options: options ? { createRecorder: options.createRecorder } : undefined,
      recordings: new Set(), activeRecording: null, recordingBusy: false };
    this.seen.add(key); this.sources.set(key, registration); this.descriptorBytes += bytes;
    return () => {
      if (this.sources.get(key) !== registration) return;
      this.sources.delete(key); this.descriptorBytes -= bytes;
      for (const connection of [...this.connections.values()]) connection.revoke(registration);
    };
  }

  /** Bind once to an actual host context; a supplied owner string does not authenticate that context. */
  open(ownerId: string): DiagnosticHostConnection {
    if (this.disposed) throw new Error('Diagnostic registry is disposed');
    encodeMessage({ ...common, kind: 'discover', requestId: 'registry-owner', ownerId });
    if (this.connections.has(ownerId)) throw new Error('Diagnostic owner already has an open connection');
    if (this.connections.size >= this.limits.maxConnections) throw new Error('Diagnostic connection limit reached');
    const connection = new HostConnection(ownerId, {
      list: () => Array.from(this.sources.values(), value => value.descriptor),
      find: (sourceId, runId) => this.sources.get(sourceKey(sourceId, runId)),
      owns: registration => !this.disposed && this.sources.get(registration.key) === registration,
      release: value => { if (this.connections.get(ownerId) === value) this.connections.delete(ownerId); },
    });
    this.connections.set(ownerId, connection);
    return connection;
  }

  /** Revoke the registry before cleanup callbacks run. Application captures remain independently usable. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sources.clear(); this.descriptorBytes = 0; this.seen.clear();
    for (const connection of [...this.connections.values()]) connection.terminate('registry-disposed');
  }
}
