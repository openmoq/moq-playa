import type { IncomingPublish, MoqtConnection } from '@openmoq/webtransport';
import type { Relay } from './relay.js';

/** Payload-only test source; it remains live until the fixture is discarded. */
export function publicationMetadata(): Pick<IncomingPublish, 'largestLocation' | 'closed'> {
  return { largestLocation: null, closed: new Promise(() => {}) };
}
export async function acceptTestPublication(relay: Relay, publish: IncomingPublish): Promise<void> {
  const owner = { isTerminated: false, isPublishInitiated: true };
  const conn = { draftVersion: 18, acceptSubscribe: async () => {}, session: {
    state: 'established', getIncomingSubscription: (id: bigint) => id === publish.requestId ? owner : undefined,
  } } as unknown as MoqtConnection;
  await relay.handlePublish(conn, publish);
}
