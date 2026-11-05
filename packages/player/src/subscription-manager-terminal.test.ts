import { describe, expect, it } from 'vitest';
import { varint, type MoqtObject, type ObjectDatagram } from '@openmoq/transport';
import { SubscriptionManager } from './subscription-manager.js';

const data = (): MoqtObject => ({ kind: 'data', trackAlias: varint(1), groupId: varint(0),
  subgroupId: varint(0), objectId: varint(0), publisherPriority: 128, payload: Uint8Array.of(1), extensions: undefined });
const eot = (): MoqtObject => ({ kind: 'gap', trackAlias: varint(1), groupId: varint(1),
  subgroupId: varint(0), objectId: varint(0), status: varint(4) });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('terminal delivery retains processing ownership', () => {
  it.each(['datagram', 'stream'] as const)('alias-wide idle and EOT still wait for accepted %s work', async origin => {
    const manager = new SubscriptionManager(); manager.registerTrack(1n, 'video', 'video');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    manager.objectTransform = object => object.kind === 'data' ? gate.then(() => object) : object;
    const delivered: string[] = [];
    manager.onObject = (_type, _name, object) => { delivered.push(object.kind); };
    const receipt: ObjectDatagram = { typeByte: 0, trackAlias: 1n, groupId: 0n, objectId: 0n,
      publisherPriority: 128, isEndOfGroup: false, extensions: undefined, payload: Uint8Array.of(1), status: undefined };
    const object = data();
    const first = manager.routeObject(0n, object, 18, undefined, origin === 'datagram' ? receipt : object);
    const streamIdle = manager.captureTrackIdle(1n, 0n)();
    const trackIdle = manager.captureTrackIdle(1n)();
    let drained = false;
    void trackIdle?.then(() => { drained = true; });
    const terminal = manager.routeObject(2n, eot());
    try {
      expect(trackIdle).toBeInstanceOf(Promise);
      if (origin === 'datagram') expect(streamIdle).toBeUndefined();
      else expect(streamIdle).toBeInstanceOf(Promise);
      await settle(); expect(delivered).toEqual([]); expect(drained).toBe(false);
    }
    finally { release(); await Promise.all([first, terminal, trackIdle, streamIdle]); }
    expect(drained).toBe(true); expect(delivered).toEqual(['data', 'gap']);
  });

  it('does not dispatch EOT ahead of an earlier accepted transform', async () => {
    const manager = new SubscriptionManager(); manager.registerTrack(1n, 'video', 'video');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    manager.objectTransform = object => object.kind === 'data' ? gate.then(() => object) : object;
    const delivered: string[] = [];
    manager.onObject = (_type, _name, object) => { delivered.push(object.kind); };
    const first = manager.routeObject(1n, data()); const terminal = manager.routeObject(2n, eot());
    try { await settle(); expect(delivered).toEqual([]); }
    finally { release(); await Promise.all([first, terminal]); }
    expect(delivered).toEqual(['data', 'gap']);
  });

  it.each(['async', 'sync'] as const)('refuses transformed LOC data after its registration is replaced: %s', async mode => {
    const manager = new SubscriptionManager(); manager.registerTrack(1n, 'old', 'video');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delivered: string[] = [];
    manager.onObject = (_type, name) => { delivered.push(name); };
    manager.objectTransform = object => {
      if (mode === 'sync') { manager.registerTrack(1n, 'new', 'video'); return object; }
      return gate.then(() => object);
    };
    const task = manager.routeObject(1n, data());
    if (mode === 'async') manager.registerTrack(1n, 'new', 'video');
    release(); await task;
    expect(delivered).toEqual([]);
  });

  it.each(['shared', 'namespace-change', 'connection-change'] as const)('retains only the proven same-track registration: %s', async mode => {
    const manager = new SubscriptionManager(); const source = {};
    manager.registerTrack(1n, 'video', 'video', 'loc', { sourceConnection: source, namespace: ['live/show'] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delivered: string[] = [];
    manager.objectTransform = object => gate.then(() => object);
    manager.onObject = (_type, name) => { delivered.push(name); };
    const task = manager.routeObject(1n, data());
    const originalIdle = manager.captureTrackIdle(1n);
    manager.registerTrack(1n, 'video', 'video', 'loc', { sourceConnection: mode === 'connection-change' ? {} : source,
      namespace: mode === 'namespace-change' ? ['live', 'show'] : ['live/show'] });
    expect(originalIdle()).toBeInstanceOf(Promise);
    release(); await task; await originalIdle();
    expect(delivered).toEqual(mode === 'shared' ? ['video'] : []);
  });

  it('a reentrant EOT cannot overtake the data transform invoking it', async () => {
    const manager = new SubscriptionManager(); manager.registerTrack(1n, 'video', 'video');
    let terminal: Promise<void> | undefined;
    const delivered: string[] = [];
    manager.onObject = (_type, _name, object) => { delivered.push(object.kind); };
    manager.objectTransform = object => { if (object.kind === 'data') terminal = manager.routeObject(2n, eot()); return object; };
    await manager.routeObject(1n, data()); await terminal;
    expect(delivered).toEqual(['data', 'gap']);
  });

  it('custom header parsing cannot deliver through a replaced registration', async () => {
    const manager = new SubscriptionManager(); manager.registerTrack(1n, 'old', 'video');
    const delivered: string[] = [];
    manager.extensionParser = () => { manager.registerTrack(1n, 'new', 'video'); return {}; };
    manager.onObject = (_type, name) => { delivered.push(name); };
    await manager.routeObject(1n, data()); expect(delivered).toEqual([]);
  });

  it.each(['async', 'sync'] as const)('a failure from a retired registration cannot recover its successor: %s', async mode => {
    const manager = new SubscriptionManager(); manager.registerTrack(1n, 'old', 'video');
    const failures: unknown[] = [];
    manager.onMalformedTrack = (...args) => { failures.push(args); };
    let reject!: (reason: Error) => void;
    manager.objectTransform = () => {
      if (mode === 'sync') { manager.registerTrack(1n, 'new', 'video'); throw new Error('old failed'); }
      return new Promise((_resolve, fail) => { reject = fail; });
    };
    const task = manager.routeObject(1n, data());
    if (mode === 'async') { manager.registerTrack(1n, 'new', 'video'); reject(new Error('old failed')); }
    await task; expect(failures).toEqual([]);
  });
});
