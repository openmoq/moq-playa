import { parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';

const bytesOf = value => ArrayBuffer.isView(value)
  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
const rangesOf = buffer => {
  try { return Array.from({ length: buffer.buffered.length }, (_, i) => [buffer.buffered.start(i), buffer.buffered.end(i)]); }
  catch { return null; }
};
function fingerprint(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${bytes.length}:${hash >>> 0}`;
}

/** Tee mutable public callbacks without replacing a later restored original with its wrapper. */
function tee(connection, name, observer) {
  let handler = connection[name];
  const originals = new WeakMap(), wrappers = new WeakMap();
  const setter = next => {
    if (!next) { handler = next; return; }
    const original = originals.get(next) ?? next;
    let wrapper = wrappers.get(original);
    if (!wrapper) {
      wrapper = function (...args) { observer(...args); return Reflect.apply(original, this, args); };
      originals.set(wrapper, original); wrappers.set(original, wrapper);
    }
    handler = wrapper;
  };
  const get = () => handler;
  Object.defineProperty(connection, name, { configurable: true, get, set: setter });
  if (handler) setter(handler);
  return () => {
    if (Object.getOwnPropertyDescriptor(connection, name)?.get === get) {
      Object.defineProperty(connection, name, { configurable: true, enumerable: true, writable: true,
        value: originals.get(handler) ?? handler });
    }
  };
}

/** One actual objectTransform stimulus plus observational public/native MSE tees. */
export function createGroupTailProbe({ now = () => performance.now(), delayMs = 1500,
  schedule = setTimeout, unschedule = clearTimeout, catalogIdentity } = {}) {
  if (catalogIdentity && (!Array.isArray(catalogIdentity.namespace) || !catalogIdentity.namespace.length
    || catalogIdentity.namespace.some(field => typeof field !== 'string') || catalogIdentity.name !== 'catalog')) {
    throw new TypeError('Expected the fixed fixture catalog namespace tuple and catalog track name');
  }
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const wireIdentity = (namespace, name) => ({ namespaceFields: namespace.map(field => Array.from(field)), trackNameBytes: Array.from(name),
    identity: { namespace: namespace.map(field => decoder.decode(field)), name: decoder.decode(name) } });
  const expectedCatalog = catalogIdentity && wireIdentity(catalogIdentity.namespace.map(field => encoder.encode(field)), encoder.encode(catalogIdentity.name));
  const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
  const isCatalog = request => expectedCatalog && request?.namespaceFields && request.trackNameBytes
    && request.namespaceFields.length === expectedCatalog.namespaceFields.length
    && request.namespaceFields.every((field, i) => sameBytes(field, expectedCatalog.namespaceFields[i]))
    && sameBytes(request.trackNameBytes, expectedCatalog.trackNameBytes);
  const state = { instrumentation: 'Explicit createMediaDiagnostics before load through player destruction; stage outcomes and unchanged engine tokens; no helper append observer or token creation.',
    catalogFetch: { expectedIdentity: expectedCatalog?.identity ?? null, receiptCapability: 'unobserved',
      disclosure: 'Actual public FETCH receipts retain their request/stream identity and are never subgroup-tail stimulus. Only when no receipt exists may an exactly configured catalog FETCH use the owned-request and parsed-header exception. No receipt or media stage is invented.',
      unavailableReceiptCount: 0, requests: [], headers: [], deliveries: [] },
    armed: false, mode: null, target: null, successor: null, receipts: [], stages: [], diagnostics: [], submissions: [], operations: [],
    losses: { overflow: 0, missingReceipt: 0, missingUnit: 0, missingToken: 0, changedInputs: 0, duplicateTerminal: 0 }, errors: [], closed: false };
  const contexts = {}, aliases = new Map(), receipts = new WeakMap(), receiptObjects = new WeakMap(), units = new WeakMap(), hashes = [];
  const restores = [], listeners = [], buffers = new Map();
  let sequence = 0, connectionSequence = 0, unitSequence = 0, diagnosticSource, candidate, gate, timer, groupBeforeArm = -1n;
  const error = value => { if (state.errors.length < 32) state.errors.push(String(value)); else state.losses.overflow++; };
  const lost = (name, message) => { state.losses[name]++; error(message); };
  const record = (list, value) => {
    if (list.length >= 1024) { lost('overflow', 'tail evidence capacity exceeded'); return null; }
    const row = { seq: ++sequence, atMs: now(), ...value }; list.push(row); return row;
  };
  const hash = (row, bytes) => {
    const copy = Uint8Array.from(bytes);
    hashes.push(crypto.subtle.digest('SHA-256', copy).then(value => {
      row.sha256 = [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }, error));
  };
  const timing = (bytes, context) => {
    const samples = readCmafChunkSamples(bytes, context).effective;
    const duration = samples.durations.reduce((sum, value) => sum + BigInt(value), 0n);
    return { bmdt: String(samples.baseMediaDecodeTime), duration: String(duration), timescale: context.timescale,
      startSec: Number(samples.baseMediaDecodeTime) / context.timescale,
      endSec: Number(samples.baseMediaDecodeTime + duration) / context.timescale };
  };
  const cancel = () => {
    if (state.closed) return;
    state.closed = true;
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    gate?.resolve();
  };
  const stage = event => {
    const inputIds = event.inputs.map(input => {
      const receipt = receipts.get(input);
      if (!receipt) lost('missingReceipt', 'Media stage input has no observed opaque receipt');
      return receipt?.seq ?? null;
    });
    let unit;
    if (event.unit !== null) {
      unit = units.get(event.unit);
      if (!unit && event.stage === 'reconstructed') {
        unit = { id: ++unitSequence, inputs: [...event.inputs], inputIds, submission: null, outcome: null };
        units.set(event.unit, unit);
      } else if (!unit) lost('missingUnit', 'Media terminal has no observed reconstructed unit');
      if (unit && (unit.inputs.length !== event.inputs.length || unit.inputs.some((input, i) => input !== event.inputs[i]))) {
        lost('changedInputs', 'Media unit input identities changed');
      }
    }
    const row = record(state.stages, { unit: event.unit === null ? null : unit?.id ?? -1,
      inputs: inputIds, stage: event.stage, reason: event.reason });
    if (row && unit && ['appended', 'discarded'].includes(event.stage)) {
      if (unit.outcome) lost('duplicateTerminal', 'Media unit has duplicate terminal stages');
      else {
        unit.outcome = { atMs: row.atMs, state: event.stage, reason: event.reason, stage: row.seq };
        if (unit.submission) unit.submission.outcome = unit.outcome;
      }
    }
  };
  return {
    observeDiagnostics(source, createTracker) {
      if (diagnosticSource) throw new Error('Tail diagnostics can be installed exactly once');
      diagnosticSource = source;
      if (typeof source.observeMediaStages !== 'function') { error('Public media stage observations unavailable'); return; }
      listeners.push(source.observeMediaStages(stage, { createTracker }));
    },
    connection(connection) {
      const id = ++connectionSequence, requested = new Map(), accepted = new Map(), fetches = new Map(), fetchStreams = new Map();
      const bind = request => {
        if (requested.has(request) && accepted.has(request)) aliases.set(`${id}/${accepted.get(request)}`, requested.get(request).identity);
      };
      for (const method of ['subscribe', 'fetch', 'joiningFetch']) {
        const original = connection[method];
        const observed = function (...args) {
          const index = method === 'joiningFetch' ? 0 : 2;
          const options = args[index] ?? {}, callback = options.onRequestId;
          const joiningRequestId = method === 'joiningFetch' ? String(options.joiningRequestId) : null;
          const identity = method === 'joiningFetch' ? requested.get(joiningRequestId)
            : wireIdentity(args[0], args[1]);
          let request;
          args[index] = { ...options, onRequestId: function (requestId) {
            request = record(state.catalogFetch.requests, { connection: id, requestId: String(requestId), kind: method,
              joiningRequestId, identity: identity?.identity ?? null, namespaceFields: identity?.namespaceFields ?? null,
              trackNameBytes: identity?.trackNameBytes ?? null, status: 'reserved' });
            if (request) {
              if (method === 'subscribe') { requested.set(String(requestId), request); bind(String(requestId)); }
              else fetches.set(String(requestId), request);
            }
            if (callback) return Reflect.apply(callback, this, arguments);
          } };
          return Reflect.apply(original, this, args).then(value => { if (request) request.status = 'issued'; return value; },
            failure => { if (request) request.status = 'failed'; throw failure; });
        };
        connection[method] = observed;
        restores.push(() => { if (connection[method] === observed) connection[method] = original; });
      }
      listeners.push(connection.observeQlogEvents(event => {
        if (event.type === 'fetch_header_parsed') {
          const header = record(state.catalogFetch.headers, { connection: id, stream: String(event.stream_id), requestId: String(event.request_id) });
          if (header) fetchStreams.set(String(event.stream_id), header);
        } else if (event.type === 'subgroup_header_parsed') fetchStreams.delete(String(event.stream_id));
      }));
      listeners.push(connection.observeObjectReceipts(event => {
        if (event.origin === 'group-end') return;
        const fetch = event.origin === 'fetch';
        if (fetch) state.catalogFetch.receiptCapability = 'available';
        const row = record(state.receipts, { connection: id, stream: fetch ? String(event.streamId) : null,
          alias: event.trackAlias === null ? null : String(event.trackAlias),
          ...(fetch ? { requestId: String(event.requestId) } : {}),
          group: String(event.groupId), object: String(event.objectId), origin: event.origin,
          subgroup: event.subgroupId === null ? null : String(event.subgroupId), status: String(event.objectStatus),
          payloadBytes: event.payloadBytes, identity: fetch ? fetches.get(String(event.requestId))?.identity ?? null : null });
        if (row) receipts.set(event.receipt, row);
      }));
      restores.push(tee(connection, 'onMessage', message => {
        if (message.type === 'SUBSCRIBE_OK') { accepted.set(String(message.requestId), String(message.trackAlias)); bind(String(message.requestId)); }
      }));
      restores.push(tee(connection, 'onObject', (streamId, object) => {
        if (object.kind !== 'data') return;
        const identity = aliases.get(`${id}/${object.trackAlias}`);
        const token = connection.objectReceiptFor(object), row = token && receipts.get(token);
        if (!row) {
          const header = fetchStreams.get(String(streamId)), request = header && fetches.get(header.requestId);
          if (header && state.catalogFetch.receiptCapability !== 'available') state.catalogFetch.receiptCapability = 'unavailable';
          if (request && request.status !== 'failed' && isCatalog(request)) {
            if (record(state.catalogFetch.deliveries, { connection: id, stream: String(streamId), request: request.seq,
              header: header.seq, requestId: request.requestId, identity: request.identity })) state.catalogFetch.unavailableReceiptCount++;
          } else lost('missingReceipt', 'Object delivery has no exact public receipt');
          return;
        }
        if (row.origin === 'fetch') {
          // The public receipt already owns this stream/request. Its placeholder
          // Object alias must not borrow a subscription's identity or need the
          // legacy missing-receipt exception (including its qlog prerequisite).
          if (row.stream !== String(streamId)) { error('Object callback disagrees with its exact public FETCH stream'); return; }
          receiptObjects.set(object, row);
          return;
        }
        row.stream = String(streamId); row.identity = identity ?? null;
        receiptObjects.set(object, row);
        if (identity?.name !== 'video-360' || row.origin !== 'subgroup') return;
        if (state.armed && !candidate && object.objectId === 0n && object.groupId > groupBeforeArm) candidate = row;
        if (gate && !gate.returned && id === state.target.connection && object.trackAlias === gate.object.trackAlias
          && object.groupId === gate.object.groupId + 1n && object.objectId === 0n && !state.successor) {
          state.successor = { ...row, whileHeld: true };
        }
        if (state.target && state.mode === 'ordinary' && id === state.target.connection && row.alias === state.target.alias
          && BigInt(row.group) === BigInt(state.target.group) + 1n && row.object === '0' && !state.successor) {
          state.successor = { ...row, whileHeld: false };
        }
      }));
      restores.push(tee(connection, 'onStreamClosed', (stream, code, terminal) => {
        fetchStreams.delete(String(stream));
        if (state.target?.connection === id && state.target.stream === String(stream)) {
          state.target.fin = { atMs: now(), terminal, error: code === undefined ? null : String(code),
            whilePending: Boolean(gate && !gate.returned) };
        }
      }));
    },
    transform(object) {
      if (state.closed) return null;
      if (!state.armed || state.target || object.kind !== 'data' || !candidate
        || object.trackAlias.toString() !== candidate.alias || object.groupId.toString() !== candidate.group || object.objectId !== 11n) return object;
      const receipt = receiptObjects.get(object);
      if (receipt && (receipt.connection !== candidate.connection || receipt.origin !== 'subgroup')) return object;
      if (!receipt) { lost('missingReceipt', 'Tail has no exact public receipt'); return object; }
      if (!contexts.video) { error('Tail has no video initialization'); return object; }
      try {
        state.target = { ...receipt, heldAtMs: now(), raw: timing(object.payload, contexts.video),
          releaseIssuedAtMs: null, returnedAtMs: null, cancelled: false };
        hash(state.target.raw, object.payload);
      } catch (e) { error(e); return object; }
      if (state.mode === 'ordinary') { state.target.returnedAtMs = now(); return object; }
      const held = new Promise(resolve => { gate = { resolve, object, returned: false }; });
      timer = schedule(() => { timer = undefined; state.target.releaseIssuedAtMs = now(); gate.resolve(); }, delayMs);
      gate.result = held.then(() => {
        gate.returned = true;
        state.target.returnedAtMs = now();
        if (state.closed) { state.target.cancelled = true; return null; }
        return object;
      });
      return gate.result;
    },
    arm(mode) {
      if (state.armed || state.closed || !['ordinary', 'held'].includes(mode)) throw new Error('Tail probe can be armed exactly once');
      for (const receipt of state.receipts) if (receipt.identity?.name === 'video-360' && receipt.origin === 'subgroup'
        && BigInt(receipt.group) > groupBeforeArm) groupBeforeArm = BigInt(receipt.group);
      state.mode = mode; state.armed = true; return { atMs: now(), mode };
    },
    wrapSource(source) {
      const initialize = source.initialize, append = source.appendChunk;
      source.initialize = function (config) {
        for (const mediaType of ['video', 'audio']) if (config[mediaType]) {
          try { contexts[mediaType] = parseLocmafTrackContext(config[mediaType].initData); } catch (e) { error(e); }
        }
        return Reflect.apply(initialize, this, arguments);
      };
      source.appendChunk = function (mediaType, data, trackName, groupId, token) {
        try {
          const unit = token === undefined ? null : units.get(token);
          if (!unit) lost(token === undefined ? 'missingToken' : 'missingUnit', 'Append has no observed engine unit token');
          const parsed = timing(data, contexts[mediaType]);
          const submission = record(state.submissions, { mediaType, trackName, group: groupId === undefined ? null : String(groupId),
            ...parsed, fingerprint: fingerprint(data), unit: unit?.id ?? null, inputs: unit?.inputIds ?? [],
            nativeOperation: null, outcome: unit?.outcome ?? null });
          if (submission) {
            hash(submission, data);
            if (unit) {
              if (unit.submission) lost('missingUnit', 'Engine unit submitted more than once');
              else unit.submission = submission;
            }
          }
        } catch (e) { error(e); }
        return Reflect.apply(append, this, arguments);
      };
      restores.push(() => { source.initialize = initialize; source.appendChunk = append; });
      return source;
    },
    installNative(MediaSourceClass = MediaSource, BufferClass = SourceBuffer) {
      const add = MediaSourceClass.prototype.addSourceBuffer, append = BufferClass.prototype.appendBuffer;
      const observedAdd = function (mime) {
        const buffer = Reflect.apply(add, this, arguments);
        const info = { id: buffers.size, mime, mediaType: mime.startsWith('video/') ? 'video' : 'audio', operation: null };
        buffers.set(buffer, info);
        const onUpdate = () => { if (info.operation) info.operation.updateAtMs = now(); };
        const onError = () => { if (info.operation) info.operation.error = 'native error'; };
        const onAbort = () => { if (info.operation) info.operation.error = 'native abort'; };
        const onEnd = () => {
          if (!info.operation) return;
          info.operation.updateendAtMs = now(); info.operation.ranges = rangesOf(buffer); info.operation = null;
        };
        for (const [event, callback] of [['update', onUpdate], ['error', onError], ['abort', onAbort], ['updateend', onEnd]]) {
          buffer.addEventListener(event, callback); listeners.push(() => buffer.removeEventListener(event, callback));
        }
        return buffer;
      };
      const observedAppend = function (data) {
        const info = buffers.get(this);
        let operation;
        if (info) try {
          const bytes = bytesOf(data);
          const signature = fingerprint(bytes);
          const matching = state.submissions.filter(row => row.mediaType === info.mediaType && row.fingerprint === signature && row.nativeOperation === null);
          operation = record(state.operations, { bufferId: info.id, mediaType: info.mediaType, fingerprint: signature,
            submission: matching.length === 1 ? matching[0].seq : null, offset: this.timestampOffset,
            updatingBefore: this.updating, updateAtMs: null, updateendAtMs: null, error: null, ranges: null });
          if (operation) {
            if (matching.length > 1) error('Ambiguous native operation correlation');
            if (matching.length === 1) matching[0].nativeOperation = operation.seq;
            hash(operation, bytes); if (info.operation === null) info.operation = operation;
          }
        } catch (e) { error(e); }
        try { return Reflect.apply(append, this, arguments); }
        catch (e) { if (operation) { operation.error = String(e); if (info.operation === operation) info.operation = null; } throw e; }
      };
      MediaSourceClass.prototype.addSourceBuffer = observedAdd;
      BufferClass.prototype.appendBuffer = observedAppend;
      restores.push(() => {
        if (MediaSourceClass.prototype.addSourceBuffer === observedAdd) MediaSourceClass.prototype.addSourceBuffer = add;
        if (BufferClass.prototype.appendBuffer === observedAppend) BufferClass.prototype.appendBuffer = append;
      });
    },
    snapshot() { return structuredClone(state); },
    boundarySettled() {
      const { target, successor } = state;
      if (!target || !successor || target.returnedAtMs === null) return false;
      const tailTerminal = state.stages.some(row => row.unit === null && row.stage === 'discarded' && row.reason === 'stale group'
        && row.inputs.length === 1 && row.inputs[0] === target.seq && row.atMs >= target.returnedAtMs)
        || state.submissions.some(row => row.inputs.includes(target.seq) && row.outcome !== null);
      return tailTerminal && state.submissions.some(row => row.inputs.includes(successor.seq) && row.outcome?.state === 'appended'
        && state.operations.some(operation => operation.seq === row.nativeOperation && operation.updateendAtMs !== null));
    },
    async settleHashes() { await Promise.all(hashes); },
    async settleObservations(checkpoint) {
      await gate?.result;
      await Promise.all(hashes);
      for (const delivery of state.catalogFetch.deliveries) {
        const request = state.catalogFetch.requests.find(row => row.seq === delivery.request);
        if (!request) { error('Catalog FETCH scope lacks an owned request'); continue; }
        const subscription = request.joiningRequestId === null ? null : state.catalogFetch.requests.find(row => row.connection === request.connection
          && row.kind === 'subscribe' && row.requestId === request.joiningRequestId);
        if (request?.status !== 'issued' || (request.joiningRequestId !== null && subscription?.status !== 'issued')) {
          error('Catalog FETCH scope lacks a successfully issued request');
        }
      }
      const actual = diagnosticSource?.diagnosticSnapshot();
      record(state.diagnostics, { lifetime: 'before-load-through-player-destroy', checkpoint,
        destroyed: actual?.destroyed ?? null, counters: actual?.mediaStages ? { ...actual.mediaStages } : null });
    },
    cancel,
    restore() { cancel(); for (const off of listeners.splice(0)) off(); for (const restore of restores.splice(0).reverse()) restore(); },
  };
}
