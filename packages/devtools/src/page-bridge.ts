import type { DiagnosticRegistry } from './registry.js';
import { decodeMessage, encodeCarrierReply } from '@openmoq/devtools-protocol';
import type { CarrierClose } from '@openmoq/devtools-protocol';
import { carrierIdleTimeout, DiagnosticCarrier } from './carrier.js';

export interface PageBridgeOptions { readonly idleTimeoutMs?: number }
export interface PageBridge { dispose(): void }
type CloseReason = Exclude<CarrierClose['reason'], 'registry-closed'>;
const installed = Symbol.for('openmoq.devtools.page-bridge');

/** Explicit page exposure; importing this module alone installs nothing. */
export function installDiagnosticBridge(registry: DiagnosticRegistry, options: PageBridgeOptions = {}): PageBridge {
  if (registry.sourceKind !== 'attached') throw new Error('A local Probe registry cannot be exposed through a page bridge');
  const idleTimeoutMs = carrierIdleTimeout(options.idleTimeoutMs);
  const win = globalThis.window;
  if (!win || win.top !== win) throw new Error('Diagnostic bridge requires a top-level page');
  const origin = win.location.origin;
  if (origin === 'null') throw new Error('Diagnostic bridge requires a non-opaque origin');
  if (Reflect.has(win, installed)) throw new Error('Diagnostic bridge is already installed');
  const marker = Object.freeze({});
  Object.defineProperty(win, installed, { value: marker, configurable: true });
  const now = win.performance.now.bind(win.performance);
  const sessions = new Set<{ stop(reason: CloseReason): void }>();
  let disposed = false;

  function bind(port: MessagePort, carrier: DiagnosticCarrier, discover: string): void {
    let retired = false;
    let processing = false;
    let deferredClose: string | null = null;
    let timer: number | undefined;
    const session = { stop };

    function clearTimer(): void {
      if (timer !== undefined) { win.clearTimeout(timer); timer = undefined; }
    }
    function cleanup(): void {
      if (retired) return;
      retired = true;
      sessions.delete(session);
      clearTimer();
      port.removeEventListener('message', receive);
      port.removeEventListener('messageerror', invalid);
      port.removeEventListener('close', lost);
      carrier.close();
      try { port.close(); } catch { /* The port may already be gone. */ }
    }
    function deliver(packet: string | null): void {
      if (retired) return;
      try { if (packet !== null) port.postMessage(packet); }
      catch { cleanup(); return; }
      if (carrier.closed) { cleanup(); return; }
      clearTimer();
      const deadline = carrier.deadlineMs;
      if (deadline === null) { stop('internal-error'); return; }
      try {
        const time = now();
        if (!Number.isFinite(time)) { stop('clock-error'); return; }
        timer = win.setTimeout(() => invoke(() => carrier.expire()), Math.max(0, deadline - time));
      } catch { stop('internal-error'); }
    }
    function invoke(action: () => string | null): void {
      if (retired) return;
      if (processing) { deferredClose ??= carrier.close('reentrant-exchange'); return; }
      processing = true;
      let packet: string | null;
      try { packet = action(); }
      catch { packet = carrier.close('internal-error'); }
      finally { processing = false; }
      const result = deferredClose ?? packet;
      deferredClose = null;
      deliver(result);
    }
    function stop(reason: CloseReason): void {
      if (retired) return;
      clearTimer();
      const packet = carrier.close(reason);
      // An activation/clock callback can hide the page during an exchange. Its
      // outer call owns the terminal packet; keep the port until it unwinds.
      if (processing) { deferredClose ??= packet; return; }
      deliver(packet);
    }
    function receive(event: MessageEvent): void { invoke(() => carrier.receive(event.data)); }
    function invalid(): void { stop('invalid-packet'); }
    function lost(): void { stop('owner-closed'); }

    sessions.add(session);
    try {
      port.addEventListener('message', receive);
      port.addEventListener('messageerror', invalid);
      // Supported browsers give early cleanup; the timer remains the fallback.
      port.addEventListener('close', lost);
      port.start();
      invoke(() => carrier.start(discover));
    } catch { cleanup(); }
  }

  function accept(event: MessageEvent): void {
    if (disposed || event.source !== win || event.origin !== origin || event.ports.length !== 1) return;
    const decoded = decodeMessage(event.data);
    if (!decoded.ok || decoded.message.kind !== 'discover' || typeof event.data !== 'string') return;
    const port = event.ports[0]!;
    let carrier: DiagnosticCarrier;
    try { carrier = new DiagnosticCarrier(registry.open(decoded.message.ownerId), { now, idleTimeoutMs }); }
    catch {
      try { port.postMessage(encodeCarrierReply({ kind: 'closed', reason: 'bridge-unavailable', connectionReason: null })); }
      catch { /* No admission and no application state to clean up. */ }
      try { port.close(); } catch { /* Already closed. */ }
      return;
    }
    bind(port, carrier, event.data);
  }
  function hide(): void {
    for (const session of [...sessions]) session.stop('page-hidden');
  }
  win.addEventListener('message', accept);
  win.addEventListener('pagehide', hide);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener('message', accept);
      win.removeEventListener('pagehide', hide);
      if (Reflect.get(win, installed) === marker) Reflect.deleteProperty(win, installed);
      for (const session of [...sessions]) session.stop('bridge-disposed');
    },
  };
}
