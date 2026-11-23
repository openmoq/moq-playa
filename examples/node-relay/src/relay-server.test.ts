import { afterEach, expect, it, vi } from 'vitest';

const { startRelayServer } = vi.hoisted(() => ({
  startRelayServer: vi.fn(() => new Promise<never>(() => {})),
}));
vi.mock('./server.js', () => ({ startRelayServer }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['4', '8'])('passes a history depth of %s to the server', async groups => {
  vi.resetModules();
  vi.stubEnv('RELAY_HISTORY_GROUPS', groups);
  vi.stubEnv('RELAY_MAX_PENDING_OBJECTS', '4096');
  vi.stubEnv('RELAY_MAX_PENDING_BYTES', '33554432');
  await import('./relay-server.js');
  expect(startRelayServer).toHaveBeenCalledExactlyOnceWith({ relayOptions: {
    historyCache: { maxGroups: Number(groups) },
    maxPendingObjectsPerSubscription: 4096,
    maxPendingBytesPerSubscription: 33554432,
  } });
});

it('leaves the default history depth with the relay when no override is supplied', async () => {
  vi.resetModules();
  vi.stubEnv('RELAY_HISTORY_GROUPS', undefined);
  vi.stubEnv('RELAY_MAX_PENDING_OBJECTS', undefined);
  vi.stubEnv('RELAY_MAX_PENDING_BYTES', undefined);
  await import('./relay-server.js');
  expect(startRelayServer).toHaveBeenCalledExactlyOnceWith({ relayOptions: {} });
});
