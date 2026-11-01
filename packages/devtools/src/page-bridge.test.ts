import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCarrierReply, decodeMessage, encodeCarrierRequest, encodeMessage, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import type { CarrierReply, CarrierRequest } from '@openmoq/devtools-protocol';
import { fixtureSource } from '@openmoq/devtools-protocol/fixtures';
import { DiagnosticCapture } from './capture.js';
import { DiagnosticRegistry } from './registry.js';
import { installDiagnosticBridge } from './page-bridge.js';
import type { PageBridge } from './page-bridge.js';

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
class Page extends EventTarget {
  location = { origin: 'https://page.example' };
  top: Page = this;
  time = 0;
  performance = { now: () => this.time };
  setTimeout = (callback: () => void, delay: number) => setTimeout(callback, delay);
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
  postMessage = vi.fn();
}
class Port extends EventTarget {
  frames: string[] = [];
  closed = false;
  start = vi.fn();
  close = vi.fn(() => { this.closed = true; });
  postMessage = vi.fn((frame: string) => { this.frames.push(frame); });
  receive(data: unknown) { this.dispatchEvent(event('message', { data })); }
}
function event(type: string, fields: object = {}): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(result, key, { value });
  return result;
}
function reply(port: Port): CarrierReply {
  const result = decodeCarrierReply(port.frames.shift());
  if (!result.ok) throw new Error('Expected valid carrier reply');
  return result.packet;
}
function data(port: Port): Extract<CarrierReply, { kind: 'reply' }> {
  const packet = reply(port);
  if (packet.kind !== 'reply') throw new Error('Expected data');
  return packet;
}
const send = (port: Port, packet: CarrierRequest) => port.receive(encodeCarrierRequest(packet));
let page: Page;
let bridges: PageBridge[];
beforeEach(() => { vi.useFakeTimers(); bridges = []; page = new Page(); vi.stubGlobal('window', page); });
afterEach(() => { for (const bridge of bridges) bridge.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function source() {
  const activity = vi.fn();
  const capture = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached' },
    clock: { id: 'source', now: () => page.time }, onActiveChange: activity });
  const registry = new DiagnosticRegistry(); registry.register(capture);
  return { capture, registry, activity };
}
function install(registry: DiagnosticRegistry) {
  const bridge = installDiagnosticBridge(registry, { idleTimeoutMs: 1000 }); bridges.push(bridge); return bridge;
}
function discover(port = new Port(), ownerId = 'reader', fields: object = {}) {
  page.dispatchEvent(event('message', { source: page, origin: page.location.origin, ports: [port],
    data: encodeMessage({ ...common, kind: 'discover', requestId: 'discover', ownerId }), ...fields }));
  return port;
}
function attach(port: Port, ownerId = 'reader') {
  const first = data(port);
  send(port, { kind: 'request', receipt: first.receipt, message: encodeMessage({ ...common, kind: 'attach', requestId: 'attach',
    target: { ownerId, sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }) });
  const next = data(port); const frame = decodeMessage(next.frames[0]);
  if (!frame.ok || frame.message.kind !== 'snapshot') throw new Error('Expected snapshot');
  return { next, snapshot: frame.message };
}

describe('explicit page diagnostic endpoint', () => {
  it('does not expose an uninstalled registry and answers installed discovery only over the transferred port', () => {
    const c = source(); const unused = discover();
    expect(unused.frames).toEqual([]); expect(c.activity).not.toHaveBeenCalled();
    install(c.registry); const port = discover(); const first = data(port);
    expect(decodeMessage(first.frames[0])).toMatchObject({ ok: true, message: { kind: 'hello' } });
    expect(page.postMessage).not.toHaveBeenCalled(); expect(port.start).toHaveBeenCalledTimes(1);
    expect(c.activity).not.toHaveBeenCalled();
  });

  it('keeps the page port private and accepts only same-document, same-origin, one-port discovery', () => {
    const c = source(); install(c.registry);
    for (const fields of [
      { origin: 'https://other.example' }, { source: new Page() }, { ports: [] }, { ports: [new Port(), new Port()] },
      { data: 'malformed' }, { data: { kind: 'discover' } }, { data: encodeCarrierRequest({ kind: 'close' }) },
    ]) {
      const port = discover(new Port(), 'reader', fields);
      expect(port.frames).toEqual([]); expect(port.start).not.toHaveBeenCalled();
    }
    expect(c.activity).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(data(discover()).frames).toHaveLength(1);
  });

  it('activates only after attach and idles out using an actual endpoint-owned timer', () => {
    const c = source(); install(c.registry); const port = discover(); attach(port);
    expect(c.capture.active).toBe(true); expect(vi.getTimerCount()).toBe(1);
    page.time = 1000; vi.advanceTimersByTime(1000);
    expect(reply(port)).toMatchObject({ kind: 'closed', reason: 'idle-timeout' });
    expect(port.closed).toBe(true); expect(c.capture.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
    expect(port.frames).toEqual([]);
  });

  it('reopens a fresh channel for the same owner after expiry without reusing the attachment', () => {
    const c = source(); install(c.registry); const old = discover(); const a = attach(old);
    page.time = 1000; vi.advanceTimersByTime(1000); reply(old);
    const replacement = discover(); const b = attach(replacement);
    expect(b.snapshot.target.attachmentId).not.toBe(a.snapshot.target.attachmentId);
    send(old, { kind: 'close' }); expect(c.capture.active).toBe(true);
    send(replacement, { kind: 'close' }); expect(c.capture.active).toBe(false);
  });

  it('refuses a duplicate owner without closing the original channel', () => {
    const c = source(); install(c.registry); const original = discover(); attach(original);
    const duplicate = discover(); expect(reply(duplicate)).toMatchObject({ kind: 'closed', reason: 'bridge-unavailable' });
    expect(duplicate.closed).toBe(true); expect(original.closed).toBe(false); expect(c.capture.active).toBe(true);
  });

  it('refreshes discovery through credited requests and never broadcasts registration changes', () => {
    const c = source(); install(c.registry); const port = discover(); const first = data(port);
    const second = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached', sourceId: 'another' }, clock: { id: 'other', now: () => 1 } });
    c.registry.register(second); expect(port.frames).toEqual([]);
    send(port, { kind: 'request', receipt: first.receipt, message: encodeMessage({ ...common, kind: 'discover', requestId: 'refresh-list', ownerId: 'reader' }) });
    const frame = decodeMessage(data(port).frames[0]);
    expect(frame).toMatchObject({ ok: true, message: { kind: 'hello', requestId: 'refresh-list', sources: [{}, { sourceId: 'another' }] } });
    expect(c.capture.active).toBe(false); expect(second.active).toBe(false);
  });

  it('pagehide retires all channels, keeps the registry usable and waits for fresh discovery', () => {
    const c = source(); install(c.registry); const a = discover(); attach(a);
    const b = discover(new Port(), 'second'); attach(b, 'second');
    page.dispatchEvent(event('pagehide', { persisted: true }));
    expect(reply(a)).toMatchObject({ reason: 'page-hidden' }); expect(reply(b)).toMatchObject({ reason: 'page-hidden' });
    expect(c.capture.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
    page.dispatchEvent(event('pageshow', { persisted: true }));
    expect(a.frames).toEqual([]); const restored = discover(); attach(restored); expect(c.capture.active).toBe(true);
  });

  it('uninstall is idempotent, releases its leases and leaves app observers alone', () => {
    const c = source(); const app = c.capture.attach('app', 'app'); const bridge = install(c.registry);
    const port = discover(); attach(port); bridge.dispose(); bridge.dispose();
    expect(reply(port)).toMatchObject({ reason: 'bridge-disposed' });
    expect(c.capture.active).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(discover().frames).toEqual([]); app.lease.close(); expect(c.capture.active).toBe(false);
    install(c.registry); attach(discover()); expect(c.capture.active).toBe(true);
  });

  it.each(['messageerror', 'close'])('cleans up on port %s without requiring more data', kind => {
    const c = source(); install(c.registry); const port = discover(); attach(port);
    port.dispatchEvent(event(kind)); expect(port.closed).toBe(true); expect(c.capture.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains postMessage failure and releases the observer immediately', () => {
    const c = source(); install(c.registry); const port = discover(); const { next } = attach(port);
    port.postMessage.mockImplementation(() => { throw new Error('closed port'); });
    expect(() => send(port, { kind: 'poll', receipt: next.receipt })).not.toThrow();
    expect(c.capture.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses duplicate installation without disturbing the existing endpoint', () => {
    const c = source(); install(c.registry);
    expect(() => installDiagnosticBridge(c.registry)).toThrow(/installed/);
    attach(discover()); expect(c.capture.active).toBe(true);
  });

  it('fences pagehide reentry during source activation', () => {
    const capture = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached' }, clock: { id: 'clock', now: () => 1 },
      onActiveChange: active => { if (active) page.dispatchEvent(event('pagehide')); } });
    const registry = new DiagnosticRegistry(); registry.register(capture); install(registry);
    const port = discover(); const first = data(port);
    send(port, { kind: 'request', receipt: first.receipt, message: encodeMessage({ ...common, kind: 'attach', requestId: 'attach',
      target: { ownerId: 'reader', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }) });
    expect(port.frames).toHaveLength(1); expect(reply(port)).toMatchObject({ kind: 'closed', reason: 'page-hidden' });
    expect(capture.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the terminal packet with the outer port callback on reentrant delivery', () => {
    let port!: Port;
    const capture = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached' }, clock: { id: 'clock', now: () => 1 },
      onActiveChange: active => { if (active) port.receive('reentered'); } });
    const registry = new DiagnosticRegistry(); registry.register(capture); install(registry); port = discover();
    const first = data(port);
    send(port, { kind: 'request', receipt: first.receipt, message: encodeMessage({ ...common, kind: 'attach', requestId: 'attach',
      target: { ownerId: 'reader', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }) });
    expect(port.frames).toHaveLength(1); expect(reply(port)).toMatchObject({ reason: 'reentrant-exchange' });
    expect(capture.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses unsupported window contexts and invalid options without partially installing', () => {
    const c = source(); page.top = new Page(); expect(() => installDiagnosticBridge(c.registry)).toThrow(/top/);
    page.top = page; page.location.origin = 'null'; expect(() => installDiagnosticBridge(c.registry)).toThrow(/origin/);
    page.location.origin = 'https://page.example';
    expect(() => installDiagnosticBridge(c.registry, { idleTimeoutMs: NaN })).toThrow();
    install(c.registry); expect(data(discover()).frames).toHaveLength(1);
  });
});
