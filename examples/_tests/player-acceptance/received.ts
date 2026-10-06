import type { MoqtObject } from '@openmoq/transport';
import type { MoqtConnection } from '@openmoq/webtransport';
import { deserializeLocmafObject } from '../../../packages/locmaf/src/index.js';

/** Preserve mutable callback ownership, including a saved handler being restored. */
export function observeConnectionObjects(connection: { onObject?: MoqtConnection['onObject'] },
  observe: NonNullable<MoqtConnection['onObject']>): void {
  type Handler = NonNullable<MoqtConnection['onObject']>;
  let handler = connection.onObject;
  const originals = new WeakMap<Handler, Handler>();
  const wrappers = new WeakMap<Handler, Handler>();
  Object.defineProperty(connection, 'onObject', {
    configurable: true, get: () => handler,
    set: (next: MoqtConnection['onObject']) => {
      if (!next) { handler = next; return; }
      const original = originals.get(next) ?? next;
      let wrapped = wrappers.get(original);
      if (!wrapped) {
        wrapped = function (stream, object) {
          observe(stream, object);
          original.call(connection, stream, object);
        };
        originals.set(wrapped, original);
        wrappers.set(original, wrapped);
      }
      handler = wrapped;
    },
  });
  if (handler) connection.onObject = handler;
}

/** Bounded observations of the actual browser-delivered catalog and media bytes. */
export function observeLocmafDelivery() {
  let catalog: { version: unknown; tracks: { name: string; packaging: unknown; locmafVersion: unknown; initRef: unknown; initResolved: boolean }[] } | null = null;
  const groups = new Map<string, { alias: string; group: string; full: number; delta: number; streams: Set<string> }>();
  const errors: string[] = [];
  return {
    record(streamId: bigint, object: MoqtObject) {
      if (object.kind !== 'data' || !object.payload.length) return;
      const payload = object.payload;
      if (payload[0] === 123) {
        try {
          const value = JSON.parse(new TextDecoder().decode(payload));
          if (Array.isArray(value.tracks)) {
            catalog = { version: value.version, tracks: value.tracks.map((track: Record<string, unknown>) => ({
              name: String(track.name), packaging: track.packaging, locmafVersion: track.locmafVersion, initRef: track.initRef,
              initResolved: Array.isArray(value.initDataList) && value.initDataList.some((entry: Record<string, unknown>) =>
                entry.id === track.initRef && entry.type === 'inline' && typeof entry.data === 'string' && entry.data.length > 0),
            })) };
            return;
          }
        } catch { /* Not a catalog. Validate it as a media Object below. */ }
      }
      try {
        const decoded = deserializeLocmafObject(payload);
        if (decoded.kind !== 'moof') throw new Error(`Expected full/delta moof, got ${decoded.kind}`);
        const alias = String(object.trackAlias);
        const group = String(object.groupId);
        const key = `${alias}/${group}`;
        let entry = groups.get(key);
        if (!entry) {
          entry = { alias, group, full: 0, delta: 0, streams: new Set() };
          groups.set(key, entry);
          if (groups.size > 32) groups.delete(groups.keys().next().value!);
        }
        if (decoded.header.full) entry.full++; else entry.delta++;
        entry.streams.add(String(streamId));
      } catch (error) {
        if (errors.length < 16) errors.push(String(error));
      }
    },
    snapshot() { return { catalog, groups: [...groups.values()].map((group) => ({ ...group, streams: [...group.streams] })), errors: [...errors] }; },
  };
}

export function assessLocmafDelivery(observed: ReturnType<ReturnType<typeof observeLocmafDelivery>['snapshot']>): string[] {
  const failures: string[] = [];
  if (observed.catalog?.version !== '1' || observed.catalog.tracks.length !== 2
    || observed.catalog.tracks.some((track) => track.packaging !== 'locmaf' || track.locmafVersion !== '0.3'
      || typeof track.initRef !== 'string' || !track.initResolved)) failures.push('locmaf-catalog');
  const aliases = new Set(observed.groups.map((group) => group.alias));
  if (aliases.size !== 2 || [...aliases].some((alias) =>
    observed.groups.filter((group) => group.alias === alias && group.full > 0 && group.delta > 0).length < 2)) {
    failures.push('locmaf-full-delta-groups');
  }
  if (observed.groups.some((group) => group.streams.length !== 1)) failures.push('locmaf-subgroup-mapping');
  if (observed.errors.length) failures.push('locmaf-media-rejected');
  return failures;
}
