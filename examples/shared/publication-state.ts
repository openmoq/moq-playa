/** Example-owned heads, checked against exact live request owners. */
export type Location = { group: bigint; object: bigint };
export interface PublicationOwner {
  readonly isTerminated: boolean;
  readonly trackAlias?: bigint | undefined;
  readonly trackNamespace?: Uint8Array[] | undefined;
  readonly trackName?: Uint8Array | undefined;
}
export interface PublicationConnection {
  setLargestLocationProvider(provider: (id: bigint) => Location | null): void;
  session: {
    readonly draftVersion?: number;
    getOutgoingPublish?(id: bigint): PublicationOwner | undefined;
    getIncomingSubscription(id: bigint): PublicationOwner | undefined;
  };
}
const states = new WeakMap<PublicationConnection, ReturnType<typeof createState>>();
function createState(conn: PublicationConnection) {
  const entries = new Map<bigint, { owner: PublicationOwner; alias: bigint; head: Location | null }>();
  const prepared = new Map<bigint, Location | null>();
  let retired = false;
  const owner = (id: bigint) => conn.session.getOutgoingPublish?.(id) ?? conn.session.getIncomingSubscription(id);
  const current = (id: bigint) => {
    const live = conn.session.getOutgoingPublish?.(id);
    const head = live && !live.isTerminated ? prepared.get(live.trackAlias!) : undefined;
    if (!retired && head !== undefined) return head ? { ...head } : null;
    const entry = entries.get(id);
    if (retired || !entry || entry.owner.isTerminated || owner(id) !== entry.owner) throw new Error('Publication unavailable');
    return entry.head ? { ...entry.head } : null;
  };
  conn.setLargestLocationProvider(current);
  return {
    current,
    prepare(alias: bigint) { prepared.set(alias, null); },
    bind(id: bigint, alias: bigint) {
      for (const [key, value] of entries) if (value.owner.isTerminated || owner(key) !== value.owner) entries.delete(key);
      const live = owner(id);
      if (!live || live.isTerminated || retired) throw new Error('Publication unavailable');
      entries.set(id, { owner: live, alias, head: null });
    },
    sent(alias: bigint, group: bigint, object: bigint) {
      const head = prepared.get(alias);
      if (head !== undefined && (!head || group > head.group || (group === head.group && object > head.object))) prepared.set(alias, { group, object });
      for (const [id, entry] of entries) if (entry.alias === alias) {
        current(id);
        if (!entry.head || group > entry.head.group || (group === entry.head.group && object > entry.head.object)) entry.head = { group, object };
      }
    },
    remove(id: bigint) { entries.delete(id); },
    retire() { retired = true; entries.clear(); prepared.clear(); },
  };
}
export function publicationState(conn: PublicationConnection) {
  let state = states.get(conn);
  if (!state) { state = createState(conn); states.set(conn, state); }
  return state;
}
