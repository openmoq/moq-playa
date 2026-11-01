import {
  array, boolean, bytes, id, integer, InvalidField, nonnegative, nullable, number,
  object, oneOf, record, refined, text, uint64,
} from './schema.js';
import type { Reader, Value } from './schema.js';

export const versionReader = object({ major: integer, minor: integer });
export const sourceTargetReader = object({ ownerId: id, sourceId: id, runId: id });
export const targetReader = object({ ownerId: id, sourceId: id, runId: id, attachmentId: id });
export type SourceTarget = Value<typeof sourceTargetReader>;
export type AttachmentTarget = Value<typeof targetReader>;

export const sourceReader = object({
  sourceId: id, runId: id, kind: oneOf('attached', 'probe'), label: nullable(text()), synthetic: boolean,
  exposure: nullable(oneOf('development', 'production')),
  capabilities: array(text(96, /^[a-z][a-z0-9._-]*$/), 64),
  modules: array(object({ name: text(128), version: text(64), buildId: nullable(text(128)) }), 32),
});
export type SourceDescriptor = Value<typeof sourceReader>;

export const clockReader = object({ id, unit: oneOf('ms'), kind: oneOf('monotonic') });
const unavailable = oneOf('not-applicable', 'not-observed', 'unsupported');
const creditReader = refined(object({ value: nullable(uint64), unavailable: nullable(unavailable) }),
  v => (v.value === null) === (v.unavailable !== null), 'value or unavailability, exclusively');
const protocolReader: Reader<string | null> = (value, path) =>
  value === '' || value === undefined ? null : nullable(text(128))(value, path);

export const identityReader = object({ namespace: array(bytes, 32), name: bytes });
export type TrackIdentity = Value<typeof identityReader>;

const sessionReader = refined(object({
  kind: oneOf('session'), sessionId: id, state: oneOf('dialing', 'setup', 'ready', 'closing', 'closed', 'failed'),
  transport: oneOf('webtransport', 'quic'),
  endpoint: nullable(object({ origin: text(), path: nullable(text()) })),
  draft: nullable(refined(integer, value => value > 0 && value <= 255, 'draft number')),
  draftEvidence: oneOf('configured', 'in-band', 'transport', 'unknown'),
  offeredProtocols: array(text(128), 16), negotiatedProtocol: protocolReader,
  setupDurationMs: nullable(nonnegative), maxRequestId: creditReader,
}), v => (v.draft !== 18 && v.draft !== 22) || v.maxRequestId.unavailable === 'not-applicable',
'no MAX_REQUEST_ID on draft 18 or 22');

const readers = {
  source_state: object({
    kind: oneOf('source_state'), state: oneOf('ended'),
    reason: oneOf('disposed', 'sequence-exhausted', 'clock-error'),
  }),
  session: sessionReader,
  track: object({
    kind: oneOf('track'), trackId: id, identity: nullable(identityReader), displayName: nullable(text()),
    mediaType: oneOf('video', 'audio', 'text', 'event', 'unknown'), codec: nullable(text()), packaging: nullable(text(128)),
  }),
  request: object({
    kind: oneOf('request'), sessionId: id, requestId: uint64, requestType: text(64),
    trackId: nullable(id), trackAlias: nullable(uint64),
    state: oneOf('pending', 'accepted', 'receiving', 'done', 'cancelled', 'refused', 'reset', 'failed'),
  }),
  object: object({
    kind: oneOf('object'), deliveryId: id, sessionId: id, requestId: nullable(uint64), trackId: nullable(id),
    trackAlias: uint64, groupId: uint64, objectId: uint64, subgroupId: nullable(uint64), streamId: nullable(uint64),
    payloadBytes: integer, objectStatus: uint64,
    independence: oneOf('independent', 'dependent', 'expected-independent', 'unknown'),
  }),
  stage: object({
    kind: oneOf('stage'), deliveryId: id, unitId: nullable(id),
    stage: oneOf('reconstructed', 'appended', 'decoded', 'scheduled', 'presented', 'discarded'), reason: nullable(text()),
  }),
  group_bound: object({
    kind: oneOf('group_bound'), sessionId: id, trackAlias: uint64, groupId: uint64, objectId: uint64,
    bound: oneOf('inclusive', 'exclusive'), evidence: oneOf('end-of-group', 'end-of-track'),
  }),
  group_summary: object({
    kind: oneOf('group_summary'), sessionId: id, trackAlias: uint64, groupId: uint64,
    observedObjects: uint64, observedBytes: uint64, completeCapture: boolean,
  }),
  control: object({
    kind: oneOf('control'), sessionId: id, streamId: nullable(uint64), requestId: nullable(uint64),
    messageType: text(64), direction: oneOf('sent', 'received'),
  }),
  stream: object({
    kind: oneOf('stream'), sessionId: id, streamId: uint64,
    trackAlias: nullable(uint64), groupId: nullable(uint64), subgroupId: nullable(uint64),
    state: oneOf('opened', 'fin', 'reset', 'stop-sending', 'cancelled'), code: nullable(uint64),
  }),
  metric: refined(object({
    kind: oneOf('metric'), name: text(96), sessionId: nullable(id), trackId: nullable(id),
    value: nullable(number), unavailable: nullable(unavailable), unit: oneOf('ms', 'seconds', 'bytes', 'bps', 'count', 'percent'),
    definition: text(), windowMs: nullable(nonnegative), uncertaintyMs: nullable(nonnegative),
  }), v => (v.value === null) === (v.unavailable !== null), 'value or unavailability, exclusively'),
  failure: object({
    kind: oneOf('failure'), stage: oneOf('dial', 'setup', 'catalog', 'subscribe', 'stream', 'teardown'),
    outcome: oneOf('error', 'timeout', 'cancelled', 'refused'), attribution: oneOf('local', 'peer', 'unknown'),
    sessionId: nullable(id), requestId: nullable(uint64), attemptId: nullable(id),
    message: text(), code: nullable(text(128)), codeSpace: nullable(oneOf('moqt', 'webtransport', 'local')),
  }),
  dial_attempt: object({
    kind: oneOf('dial_attempt'), attemptId: id, state: oneOf('started', 'ready', 'failed', 'cancelled'),
    offeredProtocols: array(text(128), 16), negotiatedProtocol: protocolReader,
    policy: oneOf('strict', 'compatibility'),
  }),
  recording: object({
    kind: oneOf('recording'), recordingId: nullable(id), ownerAttachmentId: nullable(id), state: oneOf('recording', 'stopped'),
  }),
} as const;

export type KnownFact = Value<(typeof readers)[keyof typeof readers]>;
export type UnknownFact = { readonly kind: 'unknown'; readonly name: string };
export type Fact = KnownFact | UnknownFact;

const factReader: Reader<Fact> = (value, path) => {
  const data = record(value, path);
  const kind = text(96, /^[a-z][a-z0-9._-]*$/)(data.kind, `${path}.kind`);
  if (kind === 'unknown') return { kind, name: text(96, /^[a-z][a-z0-9._-]*$/)(data.name, `${path}.name`) };
  if (Object.hasOwn(readers, kind)) return readers[kind as keyof typeof readers](value, path);
  return { kind: 'unknown', name: kind };
};

export const observationReader = object({ clockId: id, timeMs: nonnegative, fact: factReader });
export const eventReader = object({ seq: uint64, clockId: id, timeMs: nonnegative, fact: factReader });
export type Observation = Value<typeof observationReader>;
export type SequencedObservation = Value<typeof eventReader>;

export const retentionReader = refined(object({
  maxEvents: integer, maxBytes: integer, maxAgeMs: nonnegative, retainedEvents: integer, retainedBytes: integer,
  evictedDense: uint64, evictedSparse: uint64,
}), v => v.retainedEvents <= v.maxEvents && v.retainedBytes <= v.maxBytes, 'retention within declared bounds');

const scopeReaders = {
  source: object({ kind: oneOf('source') }),
  track: object({ kind: oneOf('track'), trackId: id }),
  group: object({ kind: oneOf('group'), sessionId: id, trackAlias: uint64, groupId: uint64 }),
  delivery: object({ kind: oneOf('delivery'), deliveryId: id }),
} as const;
export type SnapshotScope = Value<(typeof scopeReaders)[keyof typeof scopeReaders]>;
const scopeReader: Reader<SnapshotScope> = (value, path) => {
  const source = record(value, path);
  const kind = text(32)(source.kind, `${path}.kind`);
  if (!Object.hasOwn(scopeReaders, kind)) throw new InvalidField(`${path}.kind`, 'supported snapshot scope');
  return scopeReaders[kind as keyof typeof scopeReaders](value, path);
};

const common = { channel: oneOf('openmoq-devtools'), version: versionReader };
const request = { ...common, requestId: id };
const messageReaders = {
  discover: object({ ...request, kind: oneOf('discover'), ownerId: id }),
  hello: object({ ...request, kind: oneOf('hello'), ownerId: id, sources: array(sourceReader, 64) }),
  attach: object({ ...request, kind: oneOf('attach'), target: sourceTargetReader }),
  'snapshot.request': object({ ...request, kind: oneOf('snapshot.request'), target: targetReader, scope: scopeReader }),
  snapshot: refined(object({
    ...request, kind: oneOf('snapshot'), target: targetReader, source: sourceReader, watermark: uint64,
    scope: scopeReader, omittedFacts: integer,
    clocks: array(clockReader, 32), facts: array(observationReader), retention: retentionReader,
  }), v => v.source.sourceId === v.target.sourceId && v.source.runId === v.target.runId
    && new Set(v.clocks.map(c => c.id)).size === v.clocks.length
    && v.facts.every(f => v.clocks.some(c => c.id === f.clockId)), 'matching source and declared unique clocks'),
  batch: refined(object({
    ...common, kind: oneOf('batch'), target: targetReader, fromSeq: uint64, toSeq: uint64,
    dropped: object({ dense: uint64, sparse: uint64 }), events: array(eventReader),
  }), v => {
    const from = BigInt(v.fromSeq), to = BigInt(v.toSeq);
    if (from === 0n || from > to || to - from + 1n !== BigInt(v.events.length) + BigInt(v.dropped.dense) + BigInt(v.dropped.sparse)) return false;
    let last = from - 1n;
    for (const event of v.events) {
      const seq = BigInt(event.seq);
      if (seq <= last || seq < from || seq > to) return false;
      last = seq;
    }
    return true;
  }, 'ordered events and complete batch accounting'),
  detach: object({ ...request, kind: oneOf('detach'), target: targetReader }),
  'record.start': object({ ...request, kind: oneOf('record.start'), target: targetReader }),
  'record.started': object({ ...request, kind: oneOf('record.started'), target: targetReader, recordingId: id, token: id }),
  'record.stop': object({ ...request, kind: oneOf('record.stop'), target: targetReader, recordingId: id, token: id }),
  'record.export': object({ ...request, kind: oneOf('record.export'), target: targetReader, recordingId: id, token: id }),
  'export.chunk': object({
    ...request, kind: oneOf('export.chunk'), target: targetReader, exportId: id, index: integer,
    final: boolean, data: text(65536),
  }),
  ack: object({ ...request, kind: oneOf('ack'), target: targetReader }),
  error: object({ ...request, kind: oneOf('error'), target: nullable(targetReader),
    code: oneOf('not-found', 'not-owner', 'unsupported', 'limit', 'invalid-state', 'internal'), message: text() }),
} as const;

export type Message = Value<(typeof messageReaders)[keyof typeof messageReaders]>;
export type Snapshot = Extract<Message, { kind: 'snapshot' }>;
export type Batch = Extract<Message, { kind: 'batch' }>;

export const messageReader: Reader<Message> = (value, path) => {
  const source = record(value, path);
  const kind = text(96)(source.kind, `${path}.kind`);
  if (!Object.hasOwn(messageReaders, kind)) throw new InvalidField(`${path}.kind`, 'supported diagnostic message');
  return messageReaders[kind as keyof typeof messageReaders](value, path);
};
