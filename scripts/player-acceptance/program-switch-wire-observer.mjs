// @ts-check
/**
 * Bounded API subscription identities correlated with real parsed peer ACKs.
 * This is not a packet-byte sensor. Request-stream bytes and native media are
 * checked by their own witnesses. No application onMessage callback is replaced.
 */
export function observeProgramSwitchWire() {
  let connections = 0, overflow = false, admissions = 0, disposed = false;
  /** @type {import('./program-switch-wire-observer.mjs').ProgramWireSnapshot['subscriptions']} */
  const subscriptions = [];
  /** @type {Set<() => void>} */
  const cleanup = new Set();
  return {
    /** @param {import('./program-switch-wire-observer.mjs').ProgramWireConnection} connection */
    connection(connection) {
      if (disposed) throw new Error('Program wire observer is disposed');
      connections++;
      if (connections > 64) { overflow = true; return; }
      /** @typedef {{ record: import('./program-switch-wire-observer.mjs').ProgramWireSnapshot['subscriptions'][number],
       * issued: boolean, acceptedAtMs: number | null }} Admission */
      /** @type {Map<bigint, Admission>} */
      const pending = new Map();
      /** @param {bigint} id @param {Admission} entry */
      const complete = (id, entry) => {
        if (disposed || pending.get(id) !== entry || !entry.issued || entry.acceptedAtMs === null) return;
        pending.delete(id);
        subscriptions.push({ ...entry.record, timeMs: entry.acceptedAtMs });
      };
      const original = connection.subscribe;
      /** @type {typeof connection.subscribe} */
      const subscribe = async (namespace, name, options) => {
        const { onRequestId, ...rest } = options ?? {};
        /** @type {{ id: bigint | null }} */
        const owned = { id: null };
        try {
          const id = await original.call(connection, namespace, name, { ...rest, onRequestId: requestId => {
            if (!disposed) {
              // Reserve our bounded identity before invoking caller code.
              // Rejected attempts also spend this owner's finite history budget.
              if (admissions >= 64) overflow = true;
              else {
                admissions++;
                // Preserve a leading U+FEFF in each UTF-8 identity component.
                const decode = new TextDecoder('utf-8', { ignoreBOM: true });
                const entry = { record: { timeMs: performance.now(), requestId: String(requestId),
                  namespace: namespace.map(field => decode.decode(field)), name: decode.decode(name) },
                  issued: false, acceptedAtMs: null };
                owned.id = requestId; pending.set(requestId, entry);
              }
            }
            onRequestId?.(requestId);
          } });
          // A loopback/fast peer may ACK before subscribe's send promise settles.
          // Both facts are required, so a failed API request cannot be counted.
          const entry = pending.get(id);
          if (entry) { entry.issued = true; complete(id, entry); }
          return id;
        } catch (error) {
          if (owned.id !== null) pending.delete(owned.id);
          throw error;
        }
      };
      connection.subscribe = subscribe;
      const remove = connection.observeQlogEvents(event => {
        if (event.type !== 'control_message_parsed') return;
        const message = event.message;
        if (message.type === 'SUBSCRIBE_OK') {
          const id = BigInt(message.requestId), entry = pending.get(id);
          if (entry) { entry.acceptedAtMs = performance.now(); complete(id, entry); }
        } else if (message.type === 'REQUEST_ERROR' || message.type === 'PUBLISH_DONE') {
          pending.delete(BigInt(message.requestId));
        }
      });
      cleanup.add(() => {
        remove(); pending.clear();
        if (connection.subscribe === subscribe) connection.subscribe = original;
      });
    },
    snapshot() { return { connections, overflow, subscriptions: subscriptions.map(item => ({ ...item, namespace: [...item.namespace] })) }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of cleanup) remove(); cleanup.clear();
    },
  };
}
