import type { DiagnosticHostConnection } from './registry.js';
import { decodeCarrierRequest, decodeMessage, encodeCarrierReply } from '@openmoq/devtools-protocol';
import type { CarrierClose } from '@openmoq/devtools-protocol';

export interface CarrierOptions {
  readonly now: () => number;
  readonly idleTimeoutMs?: number;
}

export function carrierIdleTimeout(value: number | undefined): number {
  const timeout = value ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 600000) throw new Error('Invalid diagnostic carrier timeout');
  return timeout;
}

/** One port, one credit. The host drives expiry with a timer and sends each returned string once. */
export class DiagnosticCarrier {
  private readonly idleTimeoutMs: number;
  private started = false;
  private busy = false;
  private terminal: CarrierClose | null = null;
  private terminalSent = false;
  private receipt: string | null = null;
  private serial = 0n;
  private lastTime: number | null = null;
  private deadline: number | null = null;

  constructor(private readonly connection: DiagnosticHostConnection, private readonly options: CarrierOptions) {
    this.idleTimeoutMs = carrierIdleTimeout(options.idleTimeoutMs);
    if (typeof options.now !== 'function') throw new Error('Invalid diagnostic carrier clock');
  }

  get closed(): boolean { return this.terminal !== null; }
  get deadlineMs(): number | null { return this.deadline; }

  /** One discovery bootstrap over the newly transferred port; never a playback/Probe command. */
  start(discover: unknown): string | null {
    return this.exchange(now => {
      if (this.started) { this.terminate('invalid-packet'); return null; }
      this.started = true;
      const decoded = decodeMessage(discover);
      if (!decoded.ok || decoded.message.kind !== 'discover' || typeof discover !== 'string') {
        this.terminate('invalid-packet'); return null;
      }
      return this.respond(this.connection.request(discover), now);
    });
  }

  receive(packet: unknown): string | null {
    return this.exchange(now => {
      const decoded = decodeCarrierRequest(packet);
      if (!decoded.ok) { this.terminate('invalid-packet'); return null; }
      const p = decoded.packet;
      if (p.kind === 'close') { this.terminate('owner-closed'); return null; }
      if (!this.started) { this.terminate('invalid-packet'); return null; }
      if (p.receipt !== this.receipt) { this.terminate('invalid-receipt'); return null; }
      // Consume before invoking the registry, whose activation/clock callbacks can reenter.
      this.receipt = null;
      const frames = p.kind === 'request' ? this.connection.request(p.message) : this.pull();
      return this.respond(frames, now);
    });
  }

  /** The page endpoint must call this on its timer, even if the reader never sends again. */
  expire(): string | null { return this.exchange(() => null); }

  close(reason: Exclude<CarrierClose['reason'], 'registry-closed'> = 'owner-closed'): string | null {
    this.terminate(reason);
    return this.busy ? null : this.takeTerminal();
  }

  private pull(): readonly string[] {
    const frame = this.connection.pull();
    return frame === null ? [] : [frame];
  }

  private exchange(action: (now: number) => string | null): string | null {
    if (this.busy) { this.terminate('reentrant-exchange'); return null; }
    if (this.closed) return this.takeTerminal();
    this.busy = true;
    let response: string | null = null;
    try {
      this.checkConnection();
      const now = this.closed ? null : this.readClock();
      if (!this.closed && now !== null) {
        if (this.deadline !== null && now >= this.deadline) this.terminate('idle-timeout');
        else response = action(now);
      }
    } catch { this.terminate('internal-error'); }
    finally { this.busy = false; }
    return this.closed ? this.takeTerminal() : response;
  }

  private readClock(): number | null {
    let now: number;
    try { now = this.options.now(); }
    catch { this.terminate('clock-error'); return null; }
    if (this.closed) return null;
    if (!Number.isFinite(now) || now < 0 || (this.lastTime !== null && now < this.lastTime)
      || !Number.isFinite(now + this.idleTimeoutMs) || now + this.idleTimeoutMs <= now) {
      this.terminate('clock-error'); return null;
    }
    this.lastTime = now;
    return now;
  }

  private respond(frames: readonly string[], now: number): string | null {
    this.checkConnection();
    if (this.closed) return null;
    if (this.serial === 0xffffffffffffffffn) { this.terminate('internal-error'); return null; }
    const entropy = crypto.getRandomValues(new Uint8Array(16));
    // Fresh entropy prevents pre-crediting replies not yet read. The serial also
    // prevents an old receipt becoming valid even if random bytes ever repeat.
    const receipt = `${++this.serial}.${Array.from(entropy, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const encoded = encodeCarrierReply({ kind: 'reply', receipt, frames });
    this.receipt = receipt;
    this.deadline = now + this.idleTimeoutMs;
    return encoded;
  }

  private checkConnection(): void {
    if (this.closed || !this.connection.closed) return;
    const reason = this.connection.closedReason;
    if (reason === null) this.terminate('internal-error');
    else this.finish({ kind: 'closed', reason: 'registry-closed', connectionReason: reason });
  }

  private terminate(reason: Exclude<CarrierClose['reason'], 'registry-closed'>): void {
    this.finish({ kind: 'closed', reason, connectionReason: null });
  }

  private finish(terminal: CarrierClose): void {
    if (this.closed) return;
    this.terminal = terminal;
    this.receipt = null;
    this.deadline = null;
    // Revoke carrier authority before last-lease callbacks run.
    const wasBusy = this.busy;
    this.busy = true;
    try { this.connection.close(); } catch { /* A diagnostic cleanup cannot escape into playback. */ }
    finally { this.busy = wasBusy; }
  }

  private takeTerminal(): string | null {
    if (this.terminal === null || this.terminalSent) return null;
    this.terminalSent = true;
    return encodeCarrierReply(this.terminal);
  }
}
