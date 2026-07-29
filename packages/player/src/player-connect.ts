/**
 * Pure functions for MoQ connection setup.
 *
 * Extracted from MoqtPlayer to keep the orchestrator thin.
 * Each function takes config as a parameter (no class state).
 *
 * @see draft-ietf-moq-transport-16 §3.3 (CLIENT_SETUP / SERVER_SETUP)
 * @see draft-ietf-moq-transport-16 §9.2.2 (Subscription Parameters)
 * @see draft-ietf-moq-transport-16 §9.3.1 (Setup Parameters)
 * @module
 */

import type { SubscriptionFilter, SetupOptions } from '@moqt/transport';
import { varint } from '@moqt/transport';
import type { MoqtPlayerConfig } from './config.js';

/**
 * Build the WebTransport connect URL from config.
 *
 * Format: `${url}/?ns=${encodeURIComponent(namespace)}`
 *
 * @param config - Player configuration
 * @param urlOverride - Optional URL override (e.g. from GOAWAY migration)
 */
export function buildConnectUrl(config: MoqtPlayerConfig, urlOverride?: string): string {
  // Use the relay URL as-is. Namespace is communicated via SUBSCRIBE (§9.7),
  // not the connection URL. Some relays (moquito) accept ?ns= but others
  // (Red5, Akamai) reject unrecognized URL paths/query params.
  return urlOverride ?? config.url;
}

/**
 * Why a GOAWAY New Session URI cannot be used as a migration target, or null
 * if it can. The field is peer-controlled text (a misbehaving relay has been
 * observed placing its own error string there), so it must be validated
 * before any candidate connection or transport is created. WebTransport
 * targets are https-only.
 */
export function invalidGoawayUriReason(uri: string): string | null {
  const shown = uri.length > 120 ? `${uri.slice(0, 120)}…` : uri;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `GOAWAY New Session URI is not a valid URL: "${shown}"`;
  }
  if (parsed.protocol !== 'https:') {
    return `GOAWAY New Session URI has unsupported scheme "${parsed.protocol}" (WebTransport requires https): "${shown}"`;
  }
  // The W3C WebTransport constructor fails on any URL whose fragment is
  // non-null — which includes a bare trailing '#' (URL.hash is '' for it, so
  // check the raw text too).
  if (parsed.hash !== '' || uri.includes('#')) {
    return `GOAWAY New Session URI contains a fragment (WebTransport forbids fragments): "${shown}"`;
  }
  return null;
}

/**
 * Build SetupOptions from player config for CLIENT_SETUP.
 *
 * @see draft-ietf-moq-transport-16 §9.3.1 (Setup Parameters)
 * @see draft-ietf-moq-transport-16 §9.3.1.3 (MAX_REQUEST_ID)
 */
export function buildSetupOptions(config: MoqtPlayerConfig): SetupOptions {
  const options: SetupOptions = {
    maxRequestId: varint(config.maxRequestId!),
  };

  if (config.moqtImplementation) {
    options.implementation = config.moqtImplementation;
  }

  if (config.authority) {
    options.authority = config.authority;
  }

  if (config.authTokens) {
    options.authTokens = config.authTokens;
  }

  return options;
}

/**
 * Build SubscribeOptions from player config.
 *
 * Returns undefined if no subscription parameters are configured,
 * so the SUBSCRIBE message uses spec defaults.
 *
 * @see draft-ietf-moq-transport-16 §9.2.2
 */
export function buildSubscribeOptions(config: MoqtPlayerConfig): {
  deliveryTimeout?: ReturnType<typeof varint>;
  subscriberPriority?: ReturnType<typeof varint>;
  groupOrder?: ReturnType<typeof varint>;
  subscriptionFilter?: SubscriptionFilter;
} | undefined {
  const hasDeliveryTimeout = config.deliveryTimeoutMs !== undefined;
  const hasSubscriberPriority = config.subscriberPriority !== undefined;
  const hasGroupOrder = config.groupOrder !== undefined;
  const hasFilter = config.subscriptionFilter !== undefined;

  if (!hasDeliveryTimeout && !hasSubscriberPriority && !hasGroupOrder && !hasFilter) {
    return undefined;
  }

  const options: {
    deliveryTimeout?: ReturnType<typeof varint>;
    subscriberPriority?: ReturnType<typeof varint>;
    groupOrder?: ReturnType<typeof varint>;
    subscriptionFilter?: SubscriptionFilter;
  } = {};

  if (hasDeliveryTimeout) {
    // §9.2.2.2: duration in milliseconds
    options.deliveryTimeout = varint(BigInt(config.deliveryTimeoutMs!));
  }
  if (hasSubscriberPriority) {
    // §9.2.2.3: range 0-255
    options.subscriberPriority = varint(BigInt(config.subscriberPriority!));
  }
  if (hasGroupOrder) {
    // §9.2.2.4: Ascending (0x1) or Descending (0x2)
    const value = config.groupOrder === 'ascending' ? 0x1n : 0x2n;
    options.groupOrder = varint(value);
  }
  if (hasFilter) {
    // §9.2.2.5: Convert player config filter to transport SubscriptionFilter
    const f = config.subscriptionFilter!;
    switch (f.type) {
      case 'NextGroupStart':
        options.subscriptionFilter = { type: 'NextGroupStart' };
        break;
      case 'LargestObject':
      case 'LatestObject':
        options.subscriptionFilter = { type: 'LargestObject' };
        break;
      case 'AbsoluteStart':
        options.subscriptionFilter = {
          type: 'AbsoluteStart',
          startGroup: varint(BigInt(f.startGroup ?? 0)),
          startObject: varint(BigInt(f.startObject ?? 0)),
        };
        break;
      case 'AbsoluteRange':
        options.subscriptionFilter = {
          type: 'AbsoluteRange',
          startGroup: varint(BigInt(f.startGroup ?? 0)),
          startObject: varint(BigInt(f.startObject ?? 0)),
          endGroup: varint(BigInt(f.endGroup ?? 0)),
        };
        break;
    }
  }

  return options;
}
