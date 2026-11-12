import type { MoqtObject, SubgroupHeader } from '@openmoq/transport';

export interface CachedObject {
  readonly firstObject: boolean;
  readonly endOfGroup: boolean;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly payload: Uint8Array;
  readonly extensions: Uint8Array | undefined;
}
export interface HistoryLimits { maxGroups: number; maxObjects: number; maxBytes: number }
type Location = { group: bigint; object: bigint };
interface Group {
  objects: Map<bigint, CachedObject>;
  final?: bigint;
  subgroupEnds: Map<bigint, bigint>;
  carriers: Map<object, Map<bigint, { last: bigint; clean: boolean; stream?: bigint | null | undefined; ambiguous: boolean }>>;
}
const compare = (a: bigint, b: bigint): number => a < b ? -1 : a > b ? 1 : 0;
const size = (object: CachedObject): number => object.payload.byteLength + (object.extensions?.byteLength ?? 0);

/** Retain whole Groups; only data-only END_OF_GROUP FIN proves a missing tail. */
export class HistoryCache {
  private readonly groups = new Map<bigint, Group>();
  private objects = 0;
  private bytes = 0;
  constructor(private readonly limits: HistoryLimits) {}

  observe(source: object, object: MoqtObject, stream?: bigint | null): void {
    let group = this.groups.get(object.groupId);
    if (object.kind !== 'data') {
      const carrier = group?.carriers.get(source)?.get(object.subgroupId);
      if (carrier) { carrier.ambiguous ||= carrier.stream !== stream || object.objectId <= carrier.last; carrier.clean = false; carrier.last = object.objectId; }
      return;
    }
    if (!group) { group = { objects: new Map(), carriers: new Map(), subgroupEnds: new Map() }; this.groups.set(object.groupId, group); }
    let carriers = group.carriers.get(source);
    if (!carriers) { carriers = new Map(); group.carriers.set(source, carriers); }
    const previous = carriers.get(object.subgroupId);
    carriers.set(object.subgroupId, { last: object.objectId, stream, clean: previous?.clean !== false,
      ambiguous: previous !== undefined && (previous.ambiguous || previous.stream !== stream || object.objectId <= previous.last) });
  }

  attribute(source: object, groupId: bigint, subgroupId: bigint | null, stream: bigint | null): void {
    const carrier = subgroupId === null ? undefined : this.groups.get(groupId)?.carriers.get(source)?.get(subgroupId);
    if (carrier && carrier.stream !== stream) carrier.ambiguous = true;
  }

  admit(object: CachedObject): 'added' | 'duplicate' | 'malformed' {
    const group = this.groups.get(object.groupId)!;
    const previous = group.objects.get(object.objectId);
    if (previous) return previous.subgroupId !== object.subgroupId || previous.payload.length !== object.payload.length
      || previous.payload.some((byte, index) => byte !== object.payload[index]) ? 'malformed' : 'duplicate';
    const subgroupEnd = group.subgroupEnds.get(object.subgroupId);
    if ((group.final !== undefined && object.objectId > group.final)
      || (subgroupEnd !== undefined && object.objectId > subgroupEnd)) return 'malformed';
    group.objects.set(object.objectId, object);
    this.objects++; this.bytes += size(object);
    while (this.groups.size > this.limits.maxGroups || this.objects > this.limits.maxObjects || this.bytes > this.limits.maxBytes) {
      const oldest = [...this.groups.keys()].reduce((a, b) => a < b ? a : b);
      for (const row of this.groups.get(oldest)!.objects.values()) { this.objects--; this.bytes -= size(row); }
      this.groups.delete(oldest);
    }
    return 'added';
  }

  finish(source: object, header: SubgroupHeader, stream?: bigint | null): boolean {
    const group = this.groups.get(header.groupId);
    const carrier = group?.carriers.get(source)?.get(header.subgroupId);
    if (carrier && (carrier.ambiguous || carrier.stream !== stream)) { carrier.ambiguous = true; return false; }
    if (group && carrier) {
      group.subgroupEnds.set(header.subgroupId, carrier.last);
      if (carrier.clean && header.isEndOfGroup) {
        if ([...group.objects.keys()].some(id => id > carrier.last)) return true;
        group.final = carrier.last;
      }
    }
    group?.carriers.get(source)?.delete(header.subgroupId);
    return false;
  }

  clear(): void { this.groups.clear(); this.objects = 0; this.bytes = 0; }

  forgetSource(source: object): void { for (const group of this.groups.values()) group.carriers.delete(source); }

  /** Iterate retained IDs, never the potentially enormous requested ID space. */
  plan(start: Location, end: Location): CachedObject[] | undefined {
    if (compare(start.group, end.group) > 0 || (start.group === end.group && start.object > end.object)) return;
    const rows: CachedObject[] = [];
    let nextGroup = start.group;
    for (const [id, group] of [...this.groups].sort(([a], [b]) => compare(a, b))) {
      if (id < start.group || id > end.group) continue;
      if (id !== nextGroup++) return;
      let next = id === start.group ? start.object : 0n;
      const last = id === end.group ? end.object : group.final;
      if (last === undefined) return;
      const through = group.final !== undefined && group.final < last ? group.final : last;
      for (const row of [...group.objects.values()].sort((a, b) => compare(a.objectId, b.objectId))) {
        if (row.objectId < next || row.objectId > through) continue;
        if (row.objectId !== next++) return;
        rows.push(row);
      }
      if (next <= through) return;
    }
    return nextGroup === end.group + 1n ? rows : undefined;
  }
}
