/**
 * Tests for player-connect.ts — pure functions for connection setup.
 *
 * @see draft-ietf-moq-transport-16 §3.3 (CLIENT_SETUP / SERVER_SETUP)
 * @see draft-ietf-moq-transport-16 §9.2.2 (Subscription Parameters)
 * @see draft-ietf-moq-transport-16 §9.3.1 (Setup Parameters)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { varint } from '@moqt/transport';
import { buildConnectUrl, buildSetupOptions, buildSubscribeOptions } from './player-connect.js';
import type { MoqtPlayerConfig } from './config.js';

/** Minimal config for testing — only the fields these functions read. */
function minimalConfig(overrides: Partial<MoqtPlayerConfig> = {}): MoqtPlayerConfig {
  return {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: async () => ({}) as any,
    createConnection: () => ({}) as any,
    maxRequestId: 100,
    ...overrides,
  } as MoqtPlayerConfig;
}

// ─── buildConnectUrl ─────────────────────────────────────────────────

describe('buildConnectUrl', () => {
  it('returns relay URL as-is (namespace via SUBSCRIBE, not URL)', () => {
    const config = minimalConfig();
    expect(buildConnectUrl(config)).toBe('https://relay.example.com/moq');
  });

  it('preserves existing query params', () => {
    const config = minimalConfig({
      url: 'https://relay.example.com/moq?token=abc',
    });
    expect(buildConnectUrl(config)).toBe('https://relay.example.com/moq?token=abc');
  });

  it('uses urlOverride when provided', () => {
    const config = minimalConfig();
    expect(buildConnectUrl(config, 'https://new-relay.example.com')).toBe(
      'https://new-relay.example.com',
    );
  });
});

// ─── buildSetupOptions ───────────────────────────────────────────────

describe('buildSetupOptions', () => {
  it('includes maxRequestId as varint (§9.3.1.3)', () => {
    const config = minimalConfig({ maxRequestId: 200 });
    const options = buildSetupOptions(config);
    expect(options.maxRequestId).toEqual(varint(200));
  });

  it('passes maxRequestId through to SetupOptions', () => {
    const config = minimalConfig({ maxRequestId: 10_000 });
    const options = buildSetupOptions(config);
    expect(options.maxRequestId).toEqual(varint(10_000));
  });

  it('includes implementation when configured', () => {
    const config = minimalConfig({ moqtImplementation: 'proto-moq' });
    const options = buildSetupOptions(config);
    expect(options.implementation).toBe('proto-moq');
  });

  it('omits implementation when not configured', () => {
    const config = minimalConfig({ moqtImplementation: undefined });
    const options = buildSetupOptions(config);
    expect(options.implementation).toBeUndefined();
  });

  it('includes authTokens when configured (§9.2.2.1)', () => {
    const token = new Uint8Array([1, 2, 3]);
    const config = minimalConfig({ authTokens: [token] });
    const options = buildSetupOptions(config);
    expect(options.authTokens).toEqual([token]);
  });
});

// ─── buildSubscribeOptions ───────────────────────────────────────────

describe('buildSubscribeOptions', () => {
  it('returns undefined when no params configured', () => {
    const config = minimalConfig();
    expect(buildSubscribeOptions(config)).toBeUndefined();
  });

  it('includes deliveryTimeout as varint (§9.2.2.2)', () => {
    const config = minimalConfig({ deliveryTimeoutMs: 5000 });
    const options = buildSubscribeOptions(config);
    expect(options?.deliveryTimeout).toEqual(varint(5000n));
  });

  it('includes subscriberPriority as varint (§9.2.2.3)', () => {
    const config = minimalConfig({ subscriberPriority: 128 });
    const options = buildSubscribeOptions(config);
    expect(options?.subscriberPriority).toEqual(varint(128n));
  });

  it('includes groupOrder ascending (§9.2.2.4)', () => {
    const config = minimalConfig({ groupOrder: 'ascending' });
    const options = buildSubscribeOptions(config);
    expect(options?.groupOrder).toEqual(varint(0x1n));
  });

  it('includes groupOrder descending (§9.2.2.4)', () => {
    const config = minimalConfig({ groupOrder: 'descending' });
    const options = buildSubscribeOptions(config);
    expect(options?.groupOrder).toEqual(varint(0x2n));
  });

  it('includes LargestObject filter (§9.2.2.5)', () => {
    const config = minimalConfig({
      subscriptionFilter: { type: 'LargestObject' },
    });
    const options = buildSubscribeOptions(config);
    expect(options?.subscriptionFilter).toEqual({ type: 'LargestObject' });
  });

  it('maps deprecated LatestObject to LargestObject (compat)', () => {
    const config = minimalConfig({
      subscriptionFilter: { type: 'LatestObject' },
    });
    const options = buildSubscribeOptions(config);
    expect(options?.subscriptionFilter).toEqual({ type: 'LargestObject' });
  });

  it('includes AbsoluteStart filter with start position (§9.2.2.5)', () => {
    const config = minimalConfig({
      subscriptionFilter: { type: 'AbsoluteStart', startGroup: 5, startObject: 2 },
    });
    const options = buildSubscribeOptions(config);
    expect(options?.subscriptionFilter).toEqual({
      type: 'AbsoluteStart',
      startGroup: varint(5n),
      startObject: varint(2n),
    });
  });

  it('includes AbsoluteRange filter (§9.2.2.5)', () => {
    const config = minimalConfig({
      subscriptionFilter: { type: 'AbsoluteRange', startGroup: 1, startObject: 0, endGroup: 10 },
    });
    const options = buildSubscribeOptions(config);
    expect(options?.subscriptionFilter).toEqual({
      type: 'AbsoluteRange',
      startGroup: varint(1n),
      startObject: varint(0n),
      endGroup: varint(10n),
    });
  });

  it('includes NextGroupStart filter (§9.2.2.5)', () => {
    const config = minimalConfig({
      subscriptionFilter: { type: 'NextGroupStart' },
    });
    const options = buildSubscribeOptions(config);
    expect(options?.subscriptionFilter).toEqual({ type: 'NextGroupStart' });
  });
});
