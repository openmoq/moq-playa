import { expect } from 'vitest';
import type { Location, PublicationOwner } from '../../../shared/publication-state.js';

/** Exact outgoing identities for byte-recording publisher tests, without a transport. */
export function publicationOwners() {
  const owners = new Map<bigint, PublicationOwner>();
  const heads = new Map<bigint, Location>();
  let provider: ((id: bigint) => Location | null) | undefined;
  return {
    session: {
      draftVersion: 18,
      getOutgoingPublish: (id: bigint) => owners.get(id),
      getIncomingSubscription: (_id: bigint) => undefined,
    },
    setLargestLocationProvider(next: (id: bigint) => Location | null) { provider = next; },
    publish(id: bigint, namespace: readonly Uint8Array[], name: Uint8Array, alias: bigint) {
      owners.set(id, { isTerminated: false, trackNamespace: namespace.map(p => p.slice()), trackName: name.slice(), trackAlias: alias });
    },
    sent(alias: bigint, group: bigint, object: bigint) {
      const entry = [...owners].find(([, owner]) => owner.trackAlias === alias);
      if (!entry || !provider) throw new Error('Unowned publication or missing head provider');
      const [id] = entry;
      const previous = heads.get(id);
      const head = !previous || group > previous.group || (group === previous.group && object > previous.object)
        ? { group, object } : previous;
      heads.set(id, head);
      // Production admission must have recorded the real source head before send.
      expect(provider(id)).toEqual(head);
    },
  };
}
