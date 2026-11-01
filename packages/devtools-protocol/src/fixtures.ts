import { encodeMessage } from './index.js';
import type { Message, CarrierReply, CarrierRequest } from './index.js';

/** Synthetic observations for extension development; never a live measurement. */
export const fixtureTarget = {
  ownerId: 'mock-owner-1', sourceId: 'mock-source-1', runId: 'mock-run-1', attachmentId: 'mock-attachment-1',
} as const;

export const fixtureSource = {
  sourceId: fixtureTarget.sourceId, runId: fixtureTarget.runId, kind: 'probe',
  label: 'MOCK · example.test', synthetic: true, exposure: null,
  capabilities: ['session', 'requests', 'objects', 'recording'],
  modules: [{ name: '@openmoq/webtransport', version: '0.6.1', buildId: null }],
} as const;

const version = { major: 1, minor: 0 } as const;
const common = { channel: 'openmoq-devtools', version } as const;
const clock = { id: 'mock-clock', unit: 'ms', kind: 'monotonic' } as const;

export const helloFixture = {
  ...common, kind: 'hello', requestId: 'hello-1', ownerId: fixtureTarget.ownerId,
  sources: [fixtureSource],
} as const;

export const snapshotFixture = {
  ...common, kind: 'snapshot', requestId: 'attach-1', target: fixtureTarget,
  source: fixtureSource, watermark: '5', clocks: [clock],
  scope: { kind: 'source' }, omittedFacts: 0,
  retention: {
    maxEvents: 1000, maxBytes: 1048576, maxAgeMs: 30000,
    retainedEvents: 5, retainedBytes: 2000, evictedDense: '0', evictedSparse: '0',
  },
  facts: [
    { clockId: clock.id, timeMs: 1, fact: {
      kind: 'session', sessionId: 'session-1', state: 'ready', transport: 'webtransport',
      endpoint: { origin: 'https://example.test', path: '/moq' }, draft: 18, draftEvidence: 'configured',
      offeredProtocols: ['moqt-18'], negotiatedProtocol: null, setupDurationMs: 2,
      maxRequestId: { value: null, unavailable: 'not-applicable' },
    } },
    { clockId: clock.id, timeMs: 2, fact: {
      kind: 'track', trackId: 'video-1', identity: { namespace: ['6d65646961', '61766e'], name: '766964655f31' },
      displayName: 'vide_1', mediaType: 'video', codec: 'avc1.640028', packaging: 'cmaf',
    } },
    { clockId: clock.id, timeMs: 3, fact: {
      kind: 'request', sessionId: 'session-1', requestId: '2', requestType: 'subscribe',
      trackId: 'video-1', trackAlias: '100', state: 'accepted',
    } },
    { clockId: clock.id, timeMs: 4, fact: {
      kind: 'object', deliveryId: 'delivery-1', sessionId: 'session-1', requestId: '2',
      trackId: 'video-1', trackAlias: '100', groupId: '9007199254740993', objectId: '0',
      subgroupId: '0', streamId: '6', payloadBytes: 92160, objectStatus: '0', independence: 'unknown',
    } },
    { clockId: clock.id, timeMs: 5, fact: {
      kind: 'metric', name: 'end_to_end_latency', sessionId: 'session-1', trackId: null,
      value: null, unavailable: 'unsupported', unit: 'ms', definition: 'Capture-to-presentation delay',
      windowMs: null, uncertaintyMs: null,
    } },
  ],
} as const;

export const batchFixture = {
  ...common, kind: 'batch', target: fixtureTarget, fromSeq: '6', toSeq: '6',
  dropped: { dense: '0', sparse: '0' },
  events: [{ seq: '6', clockId: clock.id, timeMs: 10, fact: {
    kind: 'object', deliveryId: 'delivery-2', sessionId: 'session-1', requestId: '2',
    trackId: 'video-1', trackAlias: '100', groupId: '9007199254740993', objectId: '2',
    subgroupId: '0', streamId: '6', payloadBytes: 1200, objectStatus: '0', independence: 'unknown',
  } }],
} as const;

export const gapFixture = {
  ...batchFixture, fromSeq: '7', toSeq: '9', dropped: { dense: '2', sparse: '0' },
  events: [{ ...batchFixture.events[0], seq: '9', timeMs: 20,
    fact: { ...batchFixture.events[0].fact, deliveryId: 'delivery-3', objectId: '5' } }],
} as const;

export const failureFixture = {
  ...batchFixture,
  events: [{ seq: '6', clockId: clock.id, timeMs: 10, fact: {
    kind: 'failure', stage: 'dial', outcome: 'error', attribution: 'unknown',
    sessionId: null, requestId: null, attemptId: 'attempt-1',
    message: 'Opening handshake failed.', code: null, codeSpace: null,
  } }],
} as const;

export const protocolFixtures = [
  helloFixture, snapshotFixture, batchFixture, gapFixture, failureFixture,
] as const satisfies readonly Message[];

/** Apply after snapshotFixture + batchFixture: delivery loss precedes the refreshed watermark. */
export const refreshFixtures = [gapFixture, {
  ...snapshotFixture, requestId: 'refresh-1', watermark: '9',
  facts: [...snapshotFixture.facts, ...gapFixture.events.map(({ seq: _seq, ...event }) => event)],
  retention: { ...snapshotFixture.retention, retainedEvents: 6, retainedBytes: 2300 },
}] as const satisfies readonly Message[];

/** Details do not advance the stream cursor or consume its queued batches. */
export const scopedRefreshFixture = {
  ...snapshotFixture, requestId: 'detail-1', watermark: '9',
  scope: { kind: 'delivery', deliveryId: 'delivery-3' },
  facts: gapFixture.events.map(({ seq: _seq, ...event }) => event),
} as const satisfies Message;

export const sourceEndedFixture = {
  ...batchFixture, version: { major: 1, minor: 1 }, fromSeq: '10', toSeq: '10',
  events: [{ seq: '10', clockId: clock.id, timeMs: 21,
    fact: { kind: 'source_state', state: 'ended', reason: 'disposed' } }],
} as const satisfies Message;

/** Synthetic carrier receipts; live carriers generate fresh entropy for every reply. */
export const carrierRefreshFixture = {
  kind: 'reply', receipt: '2.0123456789abcdef0123456789abcdef', frames: refreshFixtures.map(encodeMessage),
} as const satisfies CarrierReply;
export const carrierPollFixture = {
  kind: 'poll', receipt: carrierRefreshFixture.receipt,
} as const satisfies CarrierRequest;
export const carrierEmptyFixture = {
  kind: 'reply', receipt: '3.fedcba9876543210fedcba9876543210', frames: [],
} as const satisfies CarrierReply;
