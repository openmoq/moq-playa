import type { LocTrackContext } from '@openmoq/loc';

/** MSF-02 §12.2: private per-registration defaults, retired with the alias route. */
export const liveLocContexts = new WeakMap<object, Map<bigint, LocTrackContext>>();
