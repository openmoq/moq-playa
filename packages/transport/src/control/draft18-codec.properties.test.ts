/**
 * PR2 — property tests for the draft-18 control codec (§10).
 *
 * Generates a bounded set of VALID `ControlMessage` values across the request /
 * response / namespace families and asserts the canonical codec invariant:
 *   encode(msg) → decode → consumes all bytes → re-encode is byte-identical.
 * Byte-identity is robust to the draft-18 response Request-ID omission (responses
 * do not carry it on the wire, so re-encoding a decoded response reproduces the
 * original bytes without fabricating an ID).
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED. A heavier soak:
 *   FC_RUNS=5000 npx vitest run packages/transport/src/control/draft18-codec.properties.test.ts
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import { MessageParam } from './parameters.js';
import type { ControlMessage } from './messages.js';
import {
  fc,
  fcParams,
  vi64Value,
  bytes,
  namespaceTuple,
  namespacePrefix,
  priorityByte,
  reasonPhrase,
} from '../testkit/arbitraries.js';

const codec18 = createControlCodec(18);

// ─── shared sub-arbitraries ──────────────────────────────────────────────────

const requestId = vi64Value;
const trackName = bytes(16);
const location = fc.tuple(vi64Value, vi64Value).map(([group, object]) => ({ group, object }));

/**
 * Conservative control-message `parameters`: only well-understood params with
 * values inside the boundary the control path enforces (SUBSCRIBER_PRIORITY is a
 * uint8; EXPIRES is a draft-18 vi64 message-parameter, so it spans the full
 * uint64 range — the codec's parameter bridge must NOT re-cap it through the
 * QUIC-Varint guard; LARGEST_OBJECT is a vi64 Location). Heavier per-kind
 * parameter fuzzing lives in message-params-18.properties.test.ts.
 */
const controlParams = fc
  .record({
    prio: fc.option(priorityByte, { nil: undefined }),
    expires: fc.option(vi64Value, { nil: undefined }),
    largest: fc.option(location, { nil: undefined }),
  })
  .map(({ prio, expires, largest }) => {
    const m = new Map<bigint, unknown[]>();
    if (prio !== undefined) m.set(MessageParam.SUBSCRIBER_PRIORITY, [BigInt(prio)]);
    if (expires !== undefined) m.set(MessageParam.EXPIRES, [expires]);
    if (largest !== undefined) m.set(MessageParam.LARGEST_OBJECT, [largest]);
    return m as never;
  });

/**
 * A small VALID Track Properties block. Types are restricted to [0x100, 0x3FFE]
 * (clear of known/Object-only/Mandatory Types), so only the parity rule applies:
 * even Type → vi64 value, odd Type → bytes.
 */
const trackProperties = fc
  .uniqueArray(
    fc.integer({ min: 0x100, max: 0x3ffe }).chain((tNum) => {
      const type = BigInt(tNum);
      const valueArb: fc.Arbitrary<bigint | Uint8Array> = (type & 1n) === 0n ? vi64Value : bytes(24);
      return fc.tuple(fc.constant(type), valueArb);
    }),
    { selector: ([t]) => t, maxLength: 4 },
  )
  .map((entries) => {
    const m = new Map<bigint, (bigint | Uint8Array)[]>();
    for (const [type, value] of entries) m.set(type, [value]);
    return m as never;
  });

/** A draft-18 Setup Option map: distinct unknown Types ≥ 0x40 (even→vi64, odd→bytes). */
const setupOptions = fc
  .uniqueArray(
    fc.integer({ min: 0x40, max: 0xff }).chain((tNum) => {
      const type = BigInt(tNum);
      const valueArb: fc.Arbitrary<bigint | Uint8Array> = (type & 1n) === 0n ? vi64Value : bytes(24);
      return fc.tuple(fc.constant(type), valueArb);
    }),
    { selector: ([t]) => t, maxLength: 5 },
  )
  .map((entries) => {
    const m = new Map<bigint, (bigint | Uint8Array)[]>();
    for (const [type, value] of entries) m.set(type, [value]);
    return m;
  });

// ─── per-message arbitraries ─────────────────────────────────────────────────

const setupArb = setupOptions.map((opts) => ({ type: 'SETUP', setupOptions: opts }));

const subscribeArb = fc
  .record({ requestId, ns: namespaceTuple, name: trackName, parameters: controlParams })
  .map(({ requestId: rid, ns, name, parameters }) => ({
    type: 'SUBSCRIBE', requestId: rid, trackNamespace: ns, trackName: name, parameters,
  }));

const trackStatusArb = fc
  .record({ requestId, ns: namespaceTuple, name: trackName, parameters: controlParams })
  .map(({ requestId: rid, ns, name, parameters }) => ({
    type: 'TRACK_STATUS', requestId: rid, trackNamespace: ns, trackName: name, parameters,
  }));

const subscribeOkArb = fc
  .record({ trackAlias: vi64Value, parameters: controlParams, props: trackProperties })
  .map(({ trackAlias, parameters, props }) => ({
    type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias, parameters, trackProperties: props,
  }));

const requestOkArb = fc
  .record({ parameters: controlParams, props: trackProperties })
  .map(({ parameters, props }) => ({ type: 'REQUEST_OK', requestId: 0n, parameters, trackProperties: props }));

const requestErrorNoRedirectArb = fc
  .record({
    errorCode: vi64Value.filter((c) => c !== 0x34n), // 0x34 = REDIRECT requires a Redirect structure
    retryInterval: vi64Value,
    errorReason: reasonPhrase,
  })
  .map(({ errorCode, retryInterval, errorReason }) => ({
    type: 'REQUEST_ERROR', requestId: 0n, errorCode, retryInterval, errorReason,
  }));

const requestErrorRedirectArb = fc
  .record({
    retryInterval: vi64Value,
    errorReason: reasonPhrase,
    connectUri: bytes(40),
    ns: namespacePrefix,
    name: trackName,
  })
  .map(({ retryInterval, errorReason, connectUri, ns, name }) => ({
    type: 'REQUEST_ERROR', requestId: 0n, errorCode: 0x34n, retryInterval, errorReason,
    redirect: { connectUri, trackNamespace: ns, trackName: name },
  }));

const fetchStandaloneArb = fc
  .record({ requestId, ns: namespaceTuple, name: trackName, start: location, end: location, parameters: controlParams })
  .map(({ requestId: rid, ns, name, start, end, parameters }) => ({
    type: 'FETCH', requestId: rid,
    fetch: { fetchType: 0x1, trackNamespace: ns, trackName: name, startLocation: start, endLocation: end },
    parameters,
  }));

const fetchJoiningArb = fc
  .record({
    requestId,
    fetchType: fc.constantFrom(0x2, 0x3),
    joiningRequestId: vi64Value,
    joiningStart: vi64Value,
    parameters: controlParams,
  })
  .map(({ requestId: rid, fetchType, joiningRequestId, joiningStart, parameters }) => ({
    type: 'FETCH', requestId: rid,
    fetch: { fetchType, joiningRequestId, joiningStart },
    parameters,
  }));

const fetchOkArb = fc
  .record({ endOfTrack: fc.constantFrom(0, 1), end: location, parameters: controlParams, props: trackProperties })
  .map(({ endOfTrack, end, parameters, props }) => ({
    type: 'FETCH_OK', requestId: 0n, endOfTrack, endLocation: end, parameters, trackProperties: props,
  }));

const publishArb = fc
  .record({ requestId, ns: namespaceTuple, name: trackName, trackAlias: vi64Value, parameters: controlParams, props: trackProperties })
  .map(({ requestId: rid, ns, name, trackAlias, parameters, props }) => ({
    type: 'PUBLISH', requestId: rid, trackNamespace: ns, trackName: name, trackAlias, parameters, trackProperties: props,
  }));

const publishNamespaceArb = fc
  .record({ requestId, ns: namespaceTuple, parameters: controlParams })
  .map(({ requestId: rid, ns, parameters }) => ({
    type: 'PUBLISH_NAMESPACE', requestId: rid, trackNamespace: ns, parameters,
  }));

const subscribeNamespaceArb = fc
  .record({ requestId, prefix: namespacePrefix, parameters: controlParams })
  .map(({ requestId: rid, prefix, parameters }) => ({
    type: 'SUBSCRIBE_NAMESPACE', requestId: rid, trackNamespacePrefix: prefix, parameters,
  }));

const subscribeTracksArb = fc
  .record({ requestId, prefix: namespacePrefix, parameters: controlParams })
  .map(({ requestId: rid, prefix, parameters }) => ({
    type: 'SUBSCRIBE_TRACKS', requestId: rid, trackNamespacePrefix: prefix, parameters,
  }));

const namespaceArb = namespaceTuple.map((suffix) => ({ type: 'NAMESPACE', trackNamespaceSuffix: suffix }));
const namespaceDoneArb = namespaceTuple.map((suffix) => ({ type: 'NAMESPACE_DONE', trackNamespaceSuffix: suffix }));
const publishBlockedArb = fc
  .record({ suffix: namespaceTuple, name: trackName })
  .map(({ suffix, name }) => ({ type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: suffix, trackName: name }));
// GOAWAY: both the control-stream form (with Request ID) and the request-stream
// form (no Request ID); URI reuses the UTF-8-safe reason-phrase arbitrary.
const goawayArb = fc
  .record({ uri: reasonPhrase, timeout: vi64Value, requestId: fc.option(vi64Value, { nil: undefined }) })
  .map(({ uri, timeout, requestId }) => ({
    type: 'GOAWAY', newSessionUri: uri, timeout,
    ...(requestId !== undefined ? { requestId } : {}),
  }));

const controlMessageArb = fc.oneof(
  setupArb,
  subscribeArb,
  trackStatusArb,
  subscribeOkArb,
  requestOkArb,
  requestErrorNoRedirectArb,
  requestErrorRedirectArb,
  fetchStandaloneArb,
  fetchJoiningArb,
  fetchOkArb,
  publishArb,
  publishNamespaceArb,
  subscribeNamespaceArb,
  subscribeTracksArb,
  namespaceArb,
  namespaceDoneArb,
  publishBlockedArb,
  goawayArb,
) as fc.Arbitrary<ControlMessage>;

describe('draft-18 control codec round-trip properties', () => {
  it('encode → decode consumes all bytes; type is preserved; re-encode is byte-identical', () => {
    fc.assert(
      fc.property(controlMessageArb, (msg) => {
        const e1 = codec18.encode(msg);
        const { message, bytesRead } = codec18.decode(e1, 0);
        expect(bytesRead).toBe(e1.length);
        expect(message.type).toBe(msg.type);
        const e2 = codec18.encode(message);
        expect([...e2]).toEqual([...e1]);
      }),
      fcParams(),
    );
  });

  it('peekFrameSize agrees with the full framed length', () => {
    fc.assert(
      fc.property(controlMessageArb, (msg) => {
        const e1 = codec18.encode(msg);
        expect(codec18.peekFrameSize(e1)).toBe(e1.length);
      }),
      fcParams(),
    );
  });
});
