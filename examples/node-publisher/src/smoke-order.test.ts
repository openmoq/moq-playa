import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => {
  const payload = Uint8Array.of(0, 0, 0, 9, 109, 100, 97, 116, 7);
  const track = { meta: { name: 'video', role: 'video', codec: 'test' }, initData: Uint8Array.of(1), chunks: [payload] };
  return { payload, track, ready: new Set<string>(), collections: new Map<string, (objects: unknown[]) => void>() };
});
vi.mock('node:child_process', () => ({ spawn: () => ({
  stdout: { on: (_: string, receive: (b: Buffer) => void) => queueMicrotask(() => receive(Buffer.from('listening on https://localhost/\n'))) },
  on: () => {}, kill: () => {},
}) }));
vi.mock('node:fs', () => ({ existsSync: () => true }));
vi.mock('./cert.js', () => ({ relayCertExists: () => true, RELAY_CERT_PATH: 'unused' }));
vi.mock('./fixture.js', () => ({ loadFixtureFromDisk: () => ({ manifest: { namespace: ['demo'] }, tracks: [state.track] }) }));
vi.mock('./synthetic-fixture.js', () => ({
  loadSyntheticFixture: () => ({ manifest: { namespace: ['demo'] }, tracks: [state.track] }),
  syntheticChunkPayload: () => state.payload, CHUNKS_PER_TRACK: 1,
}));
vi.mock('@openmoq/msf', () => ({ parseCatalogAuto: () => ({ tracks: [{ name: 'video', codec: 'test', initData: 'AQ==', packaging: 'locmaf' }] }), isTrackPackagingSupported: () => true }));
vi.mock('@openmoq/locmaf', () => ({ LocmafTrackDecoder: class {
  push() { return { kind: 'chunk', startsWithSync: true, baseMediaDecodeTime: 1n, bytes: state.payload }; }
} }));
vi.mock('./client.js', () => ({
  connectClient: async () => ({ conn: {}, close: async () => {} }),
  subscribeCollect: (_conn: unknown, _ns: string[], track: string, _count: number, _timeout?: number, onReady?: () => void) => {
    const result = new Promise(resolve => state.collections.set(track, resolve));
    queueMicrotask(() => { state.ready.add(track); onReady?.(); });
    return result;
  },
}));
vi.mock('./publisher.js', () => ({ publishFixture: async () => {
  expect([...state.ready].sort(), 'both catalog and media subscriptions accepted before publishing').toEqual(['catalog', 'video']);
  for (const resolve of state.collections.values()) resolve([{ groupId: 0n, subgroupId: 0n, objectId: 0n, payload: state.payload }]);
} }));
afterEach(() => { vi.restoreAllMocks(); state.ready.clear(); state.collections.clear(); });
for (const name of ['smoke', 'locmaf-smoke']) it(`${name} collects catalog and media without relay replay`, async () => {
  let complete!: (code: number) => void;
  const done = new Promise<number>(resolve => { complete = resolve; });
  vi.spyOn(process, 'exit').mockImplementation((code) => { complete(Number(code)); return undefined as never; });
  if (name === 'smoke') await import('./smoke.js'); else await import('./locmaf-smoke.js');
  expect(await done).toBe(0);
});
