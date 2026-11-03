import type { MoqtObject } from '@openmoq/transport';
import type { MoqtConnection } from '@openmoq/webtransport';

type StreamConnection = Pick<MoqtConnection, 'onDataStream'>;

/** Test-only bounded receipt/processing witness, never installed by an application. */
export function observeWarmStart() {
  const received: Array<{ seq: number; source: 'prefix' | 'live'; request: string | null; alias: string; group: string; object: string }> = [];
  const processed: Array<{ seq: number; alias: string; group: string; object: string }> = [];
  const requests = new WeakMap<StreamConnection, Map<bigint, bigint>>();
  let sequence = 0;
  const append = <T>(list: T[], item: T) => { if (list.length >= 2048) throw new Error('warm-start witness capacity exceeded'); list.push(item); };
  return {
    connection(conn: StreamConnection) {
      const streams = new Map<bigint, bigint>();
      let onStream = conn.onDataStream;
      const originalDescriptor = Object.getOwnPropertyDescriptor(conn, 'onDataStream');
      if (originalDescriptor?.get || originalDescriptor?.set) throw new Error('Unexpected existing data-stream observer');
      requests.set(conn, streams);
      Object.defineProperty(conn, 'onDataStream', {
        configurable: true, get: () => onStream,
        set(next: MoqtConnection['onDataStream']) {
          onStream = (id, header) => {
            if (header.type === 'fetch') streams.set(id, header.header.requestId);
            next?.call(conn, id, header);
          };
        },
      });
      if (onStream) conn.onDataStream = onStream;
    },
    /** Called by the page's single object tee; alias zero is also a legal live alias. */
    record(conn: StreamConnection, stream: bigint, object: MoqtObject): 'fetch' | 'live' {
      const request = requests.get(conn)?.get(stream);
      if (object.kind === 'data') {
        append(received, { seq: ++sequence, source: request === undefined ? 'live' : 'prefix',
          request: request === undefined ? null : String(request), alias: String(object.trackAlias),
          group: String(object.groupId), object: String(object.objectId) });
      }
      return request === undefined ? 'live' : 'fetch';
    },
    transform(object: MoqtObject) {
      if (object.kind === 'data') append(processed, { seq: ++sequence, alias: String(object.trackAlias),
        group: String(object.groupId), object: String(object.objectId) });
      return object;
    },
    snapshot() { return { received: [...received], processed: [...processed] }; },
  };
}
