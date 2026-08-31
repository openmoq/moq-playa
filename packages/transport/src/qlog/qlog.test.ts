/**
 * qlog event tracing tests — TDD red/green.
 *
 * Tests the qlog types (discriminated union) and QlogTrace collector
 * per draft-pardue-moq-qlog-moq-events-06 and [QLOG-MAIN].
 *
 * @see draft-pardue-moq-qlog-moq-events-06
 * @module
 */

import { describe, it, expect } from 'vitest';
import { QlogTrace, MOQT_EVENT_SCHEMA } from './trace.js';
import { parseSeq } from './file.js';
import type {
  QlogEvent,
  QlogControlMessageCreated,
  QlogControlMessageParsed,
  QlogStreamTypeSet,
  QlogObjectDatagramParsed,
  QlogSubgroupHeaderParsed,
  QlogSubgroupObjectParsed,
  QlogFetchHeaderParsed,
  QlogFetchObjectParsed,
  QlogOwner,
  QlogStreamType,
} from './types.js';
import { varint } from '../primitives/varint.js';
import type {
  ControlMessage,
  ParameterValue,
  SetupOptionValue,
} from '../control/messages.js';

/** One extracted variant of the control-message union. */
type Variant<T extends ControlMessage['type']> = Extract<ControlMessage, { type: T }>;

// ─── Helpers ────────────────────────────────────────────────────────

/** Minimal CLIENT_SETUP for testing. */
const CLIENT_SETUP: ControlMessage = {
  type: 'CLIENT_SETUP',
  parameters: new Map(),
};

/** Minimal SERVER_SETUP for testing. */
const SERVER_SETUP: ControlMessage = {
  type: 'SERVER_SETUP',
  parameters: new Map([[varint(0x02), [varint(10)]]]),
};

/** Minimal SUBSCRIBE for testing. */
const SUBSCRIBE: ControlMessage = {
  type: 'SUBSCRIBE',
  requestId: varint(1),
  trackNamespace: [new Uint8Array([108, 105, 118, 101])], // "live"
  trackName: new Uint8Array([118, 105, 100, 101, 111]),   // "video"
  parameters: new Map(),
};

// ─── Type discriminant tests ────────────────────────────────────────

describe('qlog types', () => {
  it('control_message_created has correct type discriminant', () => {
    const event: QlogControlMessageCreated = {
      type: 'control_message_created',
      stream_id: 0n,
      message: CLIENT_SETUP,
    };
    expect(event.type).toBe('control_message_created');
  });

  it('control_message_parsed has correct type discriminant', () => {
    const event: QlogControlMessageParsed = {
      type: 'control_message_parsed',
      stream_id: 0n,
      message: SERVER_SETUP,
    };
    expect(event.type).toBe('control_message_parsed');
  });

  it('stream_type_set has correct type discriminant', () => {
    const event: QlogStreamTypeSet = {
      type: 'stream_type_set',
      owner: 'remote',
      stream_id: 1n,
      stream_type: 'subgroup_header',
    };
    expect(event.type).toBe('stream_type_set');
  });

  it('object_datagram_parsed has correct type discriminant', () => {
    const event: QlogObjectDatagramParsed = {
      type: 'object_datagram_parsed',
      track_alias: 1n,
      group_id: 0n,
      publisher_priority: 128,
      end_of_group: false,
    };
    expect(event.type).toBe('object_datagram_parsed');
  });

  it('object_datagram_parsed allows optional publisher_priority (-06 §4.5)', () => {
    // -06: publisher_priority is optional (inherits from subscription)
    const event: QlogObjectDatagramParsed = {
      type: 'object_datagram_parsed',
      track_alias: 1n,
      group_id: 0n,
      end_of_group: false,
    };
    expect(event.publisher_priority).toBeUndefined();
  });

  it('subgroup_header_parsed has correct type discriminant with subgroup_id_mode (-06 §4.7)', () => {
    const event: QlogSubgroupHeaderParsed = {
      type: 'subgroup_header_parsed',
      stream_id: 1n,
      track_alias: 1n,
      group_id: 0n,
      subgroup_id_mode: 0,
      publisher_priority: 128,
      contains_end_of_group: false,
      extensions_present: false,
    };
    expect(event.type).toBe('subgroup_header_parsed');
    expect(event.subgroup_id_mode).toBe(0);
  });

  it('subgroup_header_parsed allows optional publisher_priority (-06 §4.7)', () => {
    const event: QlogSubgroupHeaderParsed = {
      type: 'subgroup_header_parsed',
      stream_id: 1n,
      track_alias: 1n,
      group_id: 0n,
      subgroup_id_mode: 2,
      subgroup_id: 0n,
      contains_end_of_group: false,
      extensions_present: false,
    };
    expect(event.publisher_priority).toBeUndefined();
  });

  it('subgroup_object_parsed uses object_id_delta (-06 §4.9)', () => {
    const event: QlogSubgroupObjectParsed = {
      type: 'subgroup_object_parsed',
      stream_id: 1n,
      object_id_delta: 0n,
      object_payload_length: 42,
    };
    expect(event.type).toBe('subgroup_object_parsed');
    expect(event.object_id_delta).toBe(0n);
    // -06: group_id, subgroup_id, extension_headers_length removed
    expect(event).not.toHaveProperty('group_id');
    expect(event).not.toHaveProperty('subgroup_id');
    expect(event).not.toHaveProperty('extension_headers_length');
  });

  it('fetch_header_parsed has correct type discriminant', () => {
    const event: QlogFetchHeaderParsed = {
      type: 'fetch_header_parsed',
      stream_id: 1n,
      request_id: 5n,
    };
    expect(event.type).toBe('fetch_header_parsed');
  });

  it('fetch_object_parsed has new required bools and optional fields (-06 §4.13)', () => {
    const event: QlogFetchObjectParsed = {
      type: 'fetch_object_parsed',
      stream_id: 1n,
      datagram: false,
      end_of_nonexistent_range: false,
      end_of_unknown_range: false,
      group_id: 0n,
      subgroup_id: 0n,
      object_id: 0n,
      publisher_priority: 128,
      extension_headers_length: 0,
      object_payload_length: 100,
    };
    expect(event.type).toBe('fetch_object_parsed');
    expect(event.datagram).toBe(false);
    expect(event.end_of_nonexistent_range).toBe(false);
    expect(event.end_of_unknown_range).toBe(false);
  });

  it('fetch_object_parsed allows optional fields per -06 §4.13', () => {
    // Minimal: only required fields + payload length
    const event: QlogFetchObjectParsed = {
      type: 'fetch_object_parsed',
      stream_id: 1n,
      datagram: false,
      end_of_nonexistent_range: false,
      end_of_unknown_range: false,
      object_payload_length: 0,
    };
    expect(event.group_id).toBeUndefined();
    expect(event.subgroup_id).toBeUndefined();
    expect(event.object_id).toBeUndefined();
    expect(event.publisher_priority).toBeUndefined();
  });

  it('QlogEvent union accepts all 8 event variants (-06)', () => {
    const events: QlogEvent[] = [
      { type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP },
      { type: 'control_message_parsed', stream_id: 0n, message: SERVER_SETUP },
      { type: 'stream_type_set', stream_id: 1n, stream_type: 'control' },
      { type: 'object_datagram_parsed', track_alias: 1n, group_id: 0n, end_of_group: false },
      { type: 'subgroup_header_parsed', stream_id: 1n, track_alias: 1n, group_id: 0n, subgroup_id_mode: 0, contains_end_of_group: false, extensions_present: false },
      { type: 'subgroup_object_parsed', stream_id: 1n, object_id_delta: 0n, object_payload_length: 10 },
      { type: 'fetch_header_parsed', stream_id: 1n, request_id: 1n },
      { type: 'fetch_object_parsed', stream_id: 1n, datagram: false, end_of_nonexistent_range: false, end_of_unknown_range: false, object_payload_length: 10 },
    ];
    expect(events).toHaveLength(8);
  });

  it('QlogStreamType accepts valid values including subscribe_namespace (-06)', () => {
    const types: QlogStreamType[] = ['control', 'subgroup_header', 'fetch_header', 'subscribe_namespace'];
    expect(types).toHaveLength(4);
  });

  it('QlogOwner accepts valid values', () => {
    const owners: QlogOwner[] = ['local', 'remote'];
    expect(owners).toHaveLength(2);
  });
});

// ─── QlogTrace tests ────────────────────────────────────────────────

describe('QlogTrace', () => {
  it('creates empty trace with session ID', () => {
    const trace = new QlogTrace('session-1');
    expect(trace.length).toBe(0);
  });

  it('record() adds event with timestamp', () => {
    const trace = new QlogTrace('session-1', () => 100);
    const event: QlogEvent = {
      type: 'control_message_created',
      stream_id: 0n,
      message: CLIENT_SETUP,
    };
    trace.record(event);
    expect(trace.length).toBe(1);
  });

  it('record() timestamps are relative to trace start', () => {
    let now = 1000;
    const trace = new QlogTrace('session-1', () => now);

    now = 1050;
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });

    now = 1200;
    trace.record({ type: 'control_message_parsed', stream_id: 0n, message: SERVER_SETUP });

    const json = trace.toJSON();
    expect(json.traces[0].events[0].time).toBe(50);
    expect(json.traces[0].events[1].time).toBe(200);
  });

  it('toJSON() returns valid qlog structure with qlog_version 0.4', () => {
    const trace = new QlogTrace('session-1');
    const json = trace.toJSON();
    expect(json.qlog_version).toBe('0.4');
    expect(json.qlog_format).toBe('JSON');
  });

  it('toJSON() includes sessionId as group_id', () => {
    const trace = new QlogTrace('my-session-42');
    const json = trace.toJSON();
    expect(json.traces[0].common_fields.group_id).toBe('my-session-42');
  });

  it('toJSON() protocol_type is [moqt]', () => {
    const trace = new QlogTrace('s');
    const json = trace.toJSON();
    expect(json.traces[0].common_fields.protocol_type).toEqual(['moqt']);
  });

  it('toJSON() vantage_point is client', () => {
    const trace = new QlogTrace('s');
    const json = trace.toJSON();
    expect(json.traces[0].vantage_point.type).toBe('client');
  });

  it('toJSON() events array contains all recorded events in order', () => {
    let now = 0;
    const trace = new QlogTrace('s', () => now);

    now = 10;
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });
    now = 20;
    trace.record({ type: 'control_message_parsed', stream_id: 0n, message: SERVER_SETUP });

    const events = trace.toJSON().traces[0].events;
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('moqt:control_message_created');
    expect(events[1].name).toBe('moqt:control_message_parsed');
  });

  it('toJSON() events use moqt: namespace prefix', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'stream_type_set',
      owner: 'remote',
      stream_id: 1n,
      stream_type: 'subgroup_header',
    });
    const event = trace.toJSON().traces[0].events[0];
    expect(event.name).toBe('moqt:stream_type_set');
  });

  it('toString() returns valid JSON string', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });
    const str = trace.toString();
    expect(() => JSON.parse(str)).not.toThrow();
    const parsed = JSON.parse(str);
    expect(parsed.qlog_version).toBe('0.4');
  });

  it('length returns count of recorded events', () => {
    const trace = new QlogTrace('s', () => 0);
    expect(trace.length).toBe(0);
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });
    expect(trace.length).toBe(1);
    trace.record({ type: 'control_message_parsed', stream_id: 0n, message: SERVER_SETUP });
    expect(trace.length).toBe(2);
  });

  it('clear() resets events to empty', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });
    trace.record({ type: 'control_message_parsed', stream_id: 0n, message: SERVER_SETUP });
    expect(trace.length).toBe(2);
    trace.clear();
    expect(trace.length).toBe(0);
    expect(trace.toJSON().traces[0].events).toHaveLength(0);
  });

  it('timestamps after clear() continue from original start time', () => {
    let now = 1000;
    const trace = new QlogTrace('s', () => now);

    now = 1100;
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });
    trace.clear();

    now = 1300;
    trace.record({ type: 'control_message_parsed', stream_id: 0n, message: SERVER_SETUP });
    expect(trace.toJSON().traces[0].events[0].time).toBe(300);
  });

  // ─── Event data serialization ─────────────────────────────────

  it('control_message_created serializes message type to lowercase', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({ type: 'control_message_created', stream_id: 0n, message: CLIENT_SETUP });
    const data = trace.toJSON().traces[0].events[0].data;
    expect((data.message as any).type).toBe('client_setup');
  });

  it('control_message_parsed serializes SUBSCRIBE with request_id and track info', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({ type: 'control_message_parsed', stream_id: 0n, message: SUBSCRIBE });
    const data = trace.toJSON().traces[0].events[0].data;
    const msg = data.message as any;
    expect(msg.type).toBe('subscribe');
    expect(msg.request_id).toBe(1);
    expect(msg.track_namespace).toEqual([{ value: 'live' }]);
    expect(msg.track_name).toEqual({ value: 'video' });
  });

  it('control_message_created includes stream_id as number', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({ type: 'control_message_created', stream_id: 42n, message: CLIENT_SETUP });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.stream_id).toBe(42);
  });

  it('control_message_created includes optional length and raw', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'control_message_created',
      stream_id: 0n,
      message: CLIENT_SETUP,
      length: 24,
      raw: { payload_length: 24, data: 'deadbeef' },
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.length).toBe(24);
    expect(data.raw).toEqual({ payload_length: 24, data: 'deadbeef' });
  });

  it('stream_type_set serializes with owner and stream_type', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'stream_type_set',
      owner: 'remote',
      stream_id: 5n,
      stream_type: 'fetch_header',
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.owner).toBe('remote');
    expect(data.stream_id).toBe(5);
    expect(data.stream_type).toBe('fetch_header');
  });

  it('object_datagram_parsed serializes required fields', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'object_datagram_parsed',
      track_alias: 1n,
      group_id: 5n,
      object_id: 3n,
      publisher_priority: 200,
      end_of_group: true,
      object_payload: { payload_length: 100 },
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.track_alias).toBe(1);
    expect(data.group_id).toBe(5);
    expect(data.object_id).toBe(3);
    expect(data.publisher_priority).toBe(200);
    expect(data.end_of_group).toBe(true);
    expect(data.object_payload).toEqual({ payload_length: 100 });
  });

  it('subgroup_header_parsed serializes all required fields including subgroup_id_mode (-06)', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'subgroup_header_parsed',
      stream_id: 2n,
      track_alias: 1n,
      group_id: 3n,
      subgroup_id_mode: 2,
      subgroup_id: 0n,
      publisher_priority: 128,
      contains_end_of_group: true,
      extensions_present: true,
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.stream_id).toBe(2);
    expect(data.track_alias).toBe(1);
    expect(data.group_id).toBe(3);
    expect(data.subgroup_id_mode).toBe(2);
    expect(data.subgroup_id).toBe(0);
    expect(data.publisher_priority).toBe(128);
    expect(data.contains_end_of_group).toBe(true);
    expect(data.extensions_present).toBe(true);
  });

  it('subgroup_header_parsed omits optional fields when absent (-06)', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'subgroup_header_parsed',
      stream_id: 2n,
      track_alias: 1n,
      group_id: 3n,
      subgroup_id_mode: 0,
      contains_end_of_group: false,
      extensions_present: false,
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data).not.toHaveProperty('subgroup_id');
    expect(data).not.toHaveProperty('publisher_priority');
  });

  it('subgroup_object_parsed serializes object_id_delta, no group_id/subgroup_id (-06)', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'subgroup_object_parsed',
      stream_id: 2n,
      object_id_delta: 7n,
      object_payload_length: 256,
      object_status: 3n,
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.stream_id).toBe(2);
    expect(data.object_id_delta).toBe(7);
    expect(data.object_payload_length).toBe(256);
    expect(data.object_status).toBe(3);
    // -06: these fields removed
    expect(data).not.toHaveProperty('group_id');
    expect(data).not.toHaveProperty('subgroup_id');
    expect(data).not.toHaveProperty('extension_headers_length');
    expect(data).not.toHaveProperty('object_id');
  });

  it('fetch_header_parsed serializes stream_id and request_id', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'fetch_header_parsed',
      stream_id: 4n,
      request_id: 10n,
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.stream_id).toBe(4);
    expect(data.request_id).toBe(10);
  });

  it('fetch_object_parsed serializes new required bools and optional fields (-06)', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'fetch_object_parsed',
      stream_id: 4n,
      datagram: false,
      end_of_nonexistent_range: false,
      end_of_unknown_range: false,
      group_id: 2n,
      subgroup_id: 0n,
      object_id: 5n,
      publisher_priority: 64,
      extension_headers_length: 0,
      object_payload_length: 1024,
    });
    const data = trace.toJSON().traces[0].events[0].data;
    expect(data.stream_id).toBe(4);
    expect(data.datagram).toBe(false);
    expect(data.end_of_nonexistent_range).toBe(false);
    expect(data.end_of_unknown_range).toBe(false);
    expect(data.group_id).toBe(2);
    expect(data.subgroup_id).toBe(0);
    expect(data.object_id).toBe(5);
    expect(data.publisher_priority).toBe(64);
    expect(data.object_payload_length).toBe(1024);
  });

  it('extension_headers are serialized to JSON format (-06)', () => {
    const trace = new QlogTrace('s', () => 0);
    trace.record({
      type: 'subgroup_object_parsed',
      stream_id: 1n,
      object_id_delta: 0n,
      extension_headers: [
        { header_type: 0x01n, header_value: 12345n },
        { header_type: 0x02n, header_length: 4n, payload: { payload_length: 4, data: 'deadbeef' } },
      ],
      object_payload_length: 100,
    });
    const data = trace.toJSON().traces[0].events[0].data;
    const headers = data.extension_headers as any[];
    expect(headers).toHaveLength(2);
    expect(headers[0].header_type).toBe(1);
    expect(headers[0].header_value).toBe(12345);
    expect(headers[1].header_type).toBe(2);
    expect(headers[1].header_length).toBe(4);
    expect(headers[1].payload).toEqual({ payload_length: 4, data: 'deadbeef' });
  });
});

// ─── uint64 serialization ───────────────────────────────────────────

/**
 * qlog main -14 §10.1: serializers MAY encode uint64 values as JSON strings,
 * and parsers SHOULD accept either form. Values above Number.MAX_SAFE_INTEGER
 * cannot round-trip through a JSON number, so they must be emitted as decimal
 * strings. Safe values stay numbers to avoid churn.
 *
 * These assert on the serialized event data, not the private helper — the
 * defect is in what we put on the wire.
 */
describe('QlogTrace uint64 encoding', () => {
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
  const TWO_53 = 1n << 53n;
  const TWO_62 = 1n << 62n;
  const MAX_U64 = (1n << 64n) - 1n;

  /** Serialize one event and return its `data` object. */
  function dataFor(event: QlogEvent): Record<string, unknown> {
    const trace = new QlogTrace('uint64-test');
    trace.record(event);
    return trace.toJSON().traces[0].events[0].data;
  }

  function datagram(overrides: Partial<QlogObjectDatagramParsed> = {}): QlogEvent {
    return {
      type: 'object_datagram_parsed',
      track_alias: 1n,
      group_id: 2n,
      object_id: 3n,
      end_of_group: false,
      ...overrides,
    } as QlogObjectDatagramParsed;
  }

  it('keeps safe values as JSON numbers', () => {
    const data = dataFor(datagram({ track_alias: MAX_SAFE, group_id: 0n, object_id: 42n }));
    expect(data.track_alias).toBe(Number.MAX_SAFE_INTEGER);
    expect(data.group_id).toBe(0);
    expect(data.object_id).toBe(42);
  });

  it('encodes 2^53 and above as decimal strings', () => {
    const data = dataFor(datagram({ track_alias: TWO_53 }));
    expect(data.track_alias).toBe('9007199254740992');
  });

  it('preserves 2^62 exactly', () => {
    const data = dataFor(datagram({ group_id: TWO_62 }));
    expect(data.group_id).toBe('4611686018427387904');
    expect(BigInt(data.group_id as string)).toBe(TWO_62);
  });

  it('preserves 2^64-1 exactly', () => {
    const data = dataFor(datagram({ object_id: MAX_U64 }));
    expect(data.object_id).toBe('18446744073709551615');
    expect(BigInt(data.object_id as string)).toBe(MAX_U64);
  });

  it('round-trips large identifiers through JSON.stringify', () => {
    const trace = new QlogTrace('uint64-json');
    trace.record(datagram({ track_alias: TWO_62, group_id: MAX_U64 }));
    const reparsed = JSON.parse(trace.toString());
    const data = reparsed.traces[0].events[0].data;
    expect(BigInt(data.track_alias)).toBe(TWO_62);
    expect(BigInt(data.group_id)).toBe(MAX_U64);
  });

  it('applies to control message identifiers', () => {
    const data = dataFor({
      type: 'control_message_created',
      stream_id: 0n,
      message: {
        type: 'SUBSCRIBE_OK',
        requestId: TWO_62,
        trackAlias: 2n,
        parameters: new Map(),
      },
    });
    expect((data.message as Record<string, unknown>).request_id).toBe('4611686018427387904');
  });

  it('applies to stream ids and subgroup ids', () => {
    const data = dataFor({
      type: 'subgroup_header_parsed',
      stream_id: TWO_62,
      track_alias: 1n,
      group_id: 2n,
      subgroup_id_mode: 3,
      subgroup_id: MAX_U64,
      publisher_priority: 128,
    });
    expect(data.stream_id).toBe('4611686018427387904');
    expect(data.subgroup_id).toBe('18446744073709551615');
  });

  it('applies to nested extension headers', () => {
    const data = dataFor(datagram({
      extension_headers: [{ header_type: TWO_62, header_value: MAX_U64 }],
    }));
    const [header] = data.extension_headers as Array<Record<string, unknown>>;
    expect(header.header_type).toBe('4611686018427387904');
    expect(header.header_value).toBe('18446744073709551615');
  });

  it('applies to object status', () => {
    const data = dataFor(datagram({ object_status: TWO_53 }));
    expect(data.object_status).toBe('9007199254740992');
  });
});

// ─── draft-14 envelopes and legacy compatibility ────────────────────

/**
 * The legacy 0.4 shape is a published export, so it is pinned here as a
 * characterization test: adding draft-14 output must not change it. New
 * consumers use toContained()/toSeq().
 */
describe('QlogTrace envelope compatibility', () => {
  const event: QlogEvent = {
    type: 'stream_type_set',
    stream_id: 4n,
    stream_type: 'control',
    owner: 'remote',
  };

  function trace(): QlogTrace {
    let t = 0;
    const tr = new QlogTrace('session-abc', () => t++);
    tr.record(event);
    return tr;
  }

  it('leaves the legacy 0.4 shape unchanged', () => {
    const json = trace().toJSON();
    expect(json.qlog_version).toBe('0.4');
    expect(json.qlog_format).toBe('JSON');
    expect(json.traces[0].common_fields).toEqual({
      group_id: 'session-abc',
      protocol_type: ['moqt'],
    });
    expect(json.traces[0].vantage_point).toEqual({ type: 'client' });
    expect(json.traces[0].events[0]!.name).toBe('moqt:stream_type_set');
    expect(json).not.toHaveProperty('file_schema');
  });

  it('emits a draft-14 contained file from the same trace', () => {
    const file = trace().toContained();
    expect(file.file_schema).toBe('urn:ietf:params:qlog:file:contained');
    expect(file.serialization_format).toBe('application/qlog+json');
    expect(file.traces[0]!.event_schemas).toEqual(['urn:ietf:params:qlog:events:moqt-06']);
    expect(file.traces[0]!.events[0]!.name).toBe('moqt:stream_type_set');
    expect(file).not.toHaveProperty('qlog_version');
  });

  it('emits a draft-14 sequential file that parses back', () => {
    const result = parseSeq(trace().toSeq());
    expect(result.truncated).toBe(false);
    expect(result.header.file_schema).toBe('urn:ietf:params:qlog:file:sequential');
    expect(result.header.trace.event_schemas).toEqual(['urn:ietf:params:qlog:events:moqt-06']);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.name).toBe('moqt:stream_type_set');
  });

  it('carries the session id as the trace group_id', () => {
    expect(trace().traceSpec().common_fields?.group_id).toBe('session-abc');
  });

  it('declares a monotonic reference clock with no epoch', () => {
    expect(trace().traceSpec().common_fields?.reference_time).toEqual({
      clock_type: 'monotonic',
      epoch: 'unknown',
    });
  });

  it('pins the MOQT schema URI to the implemented revision', () => {
    expect(MOQT_EVENT_SCHEMA).toBe('urn:ietf:params:qlog:events:moqt-06');
  });

  it('preserves large ids through the sequential envelope', () => {
    let t = 0;
    const tr = new QlogTrace('big', () => t++);
    tr.record({
      type: 'object_datagram_parsed',
      track_alias: 1n << 62n,
      group_id: 2n,
      end_of_group: false,
    });
    const parsed = parseSeq(tr.toSeq());
    expect(BigInt(parsed.events[0]!.data.track_alias as string)).toBe(1n << 62n);
  });
});

// ─── -06 control message conformance ────────────────────────────────

/**
 * Advertising `moqt-06` in `event_schemas` obliges us to serialize the
 * recognized message definitions faithfully, not merely to satisfy the
 * permissive `$MOQTControlMessage` socket.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.7
 */
describe('control message serialization (-06)', () => {
  function messageData(message: ControlMessage): Record<string, unknown> {
    let t = 0;
    const trace = new QlogTrace('conformance', () => t++);
    trace.record({ type: 'control_message_created', stream_id: 0n, message });
    return trace.toContained().traces[0]!.events[0]!.data.message as Record<string, unknown>;
  }

  it('emits number_of_parameters for CLIENT_SETUP (§5.7.1)', () => {
    const data = messageData({ type: 'CLIENT_SETUP', parameters: new Map() });
    expect(data.type).toBe('client_setup');
    expect(data.number_of_parameters).toBe(0);
  });

  it('emits number_of_parameters for SUBSCRIBE (§5.7.x)', () => {
    const data = messageData({
      type: 'SUBSCRIBE',
      requestId: 1n,
      trackNamespace: [new TextEncoder().encode('live')],
      trackName: new TextEncoder().encode('video'),
      parameters: new Map(),
    });
    expect(data.number_of_parameters).toBe(0);
    expect(data.track_name).toEqual({ value: 'video' });
  });

  it('names the request-update existing id existing_request_id (§5.7.10)', () => {
    const data = messageData({
      type: 'REQUEST_UPDATE',
      requestId: 2n,
      existingRequestId: 1n,
      parameters: new Map(),
    });
    expect(data.existing_request_id).toBe(1);
    expect(data).not.toHaveProperty('subscription_request_id');
  });

  it('uses registered -06 names for known setup parameters (§5.4)', () => {
    const data = messageData({
      type: 'CLIENT_SETUP',
      parameters: new Map<bigint, ParameterValue[]>([
        [0x02n, [10n]],
        [0x05n, [new TextEncoder().encode('relay.example')]],
      ]),
    });
    expect(data.number_of_parameters).toBe(2);
    expect(data.setup_parameters).toEqual([
      { name: 'max_request_id', value: 10 },
      { name: 'authority', value: 'relay.example' },
    ]);
  });

  it('uses the specified unknown form for unrecognized types', () => {
    // AUTHORIZATION_TOKEN (0x03) has an -06 shape we cannot faithfully produce
    // (it requires alias_type), so it must not claim the registered name.
    const data = messageData({
      type: 'CLIENT_SETUP',
      parameters: new Map<bigint, ParameterValue[]>([[0x03n, [new TextEncoder().encode('tok')]]]),
    });
    expect(data.setup_parameters).toEqual([
      { name: 'unknown', name_bytes: 3, value_bytes: { length: 3, payload_length: 3 } },
    ]);
  });

  it('keeps parameters lossless above 2^53', () => {
    const data = messageData({
      type: 'CLIENT_SETUP',
      parameters: new Map<bigint, ParameterValue[]>([[0x02n, [1n << 62n]]]),
    });
    expect(data.setup_parameters).toEqual([
      { name: 'max_request_id', value: '4611686018427387904' },
    ]);
  });

  it('serializes a Location parameter as largest_object, never null (§5.5)', () => {
    const data = messageData({
      type: 'SUBSCRIBE_OK',
      requestId: 1n,
      trackAlias: 2n,
      parameters: new Map<bigint, ParameterValue[]>([[0x09n, [{ group: 4n, object: 7n }]]]),
    });
    expect(data.parameters).toEqual([
      { name: 'largest_object', value: { group: 4, object: 7 } },
    ]);
    expect(JSON.stringify(data)).not.toContain('null');
  });

  it('serializes a namespace-tuple parameter without inventing an integer', () => {
    const data = messageData({
      type: 'SUBSCRIBE_OK',
      requestId: 1n,
      trackAlias: 2n,
      parameters: new Map<bigint, ParameterValue[]>([
        [0x34n, [[new TextEncoder().encode('a'), new TextEncoder().encode('b')]]],
      ]),
    });
    expect(data.parameters).toEqual([
      {
        name: 'unknown',
        name_bytes: 52,
        playa_value: { track_namespace: [{ value: 'a' }, { value: 'b' }] },
      },
    ]);
    const json = JSON.stringify(data);
    expect(json).not.toContain('null');
    expect(json).not.toContain('NaN');
  });

  it('emits repeated parameter values as separate entries', () => {
    const data = messageData({
      type: 'SUBSCRIBE',
      requestId: 1n,
      trackNamespace: [new TextEncoder().encode('ns')],
      trackName: new TextEncoder().encode('t'),
      parameters: new Map<bigint, ParameterValue[]>([[0x04n, [1n, 2n]]]),
    });
    expect(data.number_of_parameters).toBe(2);
    expect(data.parameters).toEqual([
      { name: 'unknown', name_bytes: 4, value: 1 },
      { name: 'unknown', name_bytes: 4, value: 2 },
    ]);
  });

  it('marks draft-18 SETUP private — -06 defines no such message', () => {
    const data = messageData({
      type: 'SETUP',
      // AUTHORITY (0x05) is a real draft-18 Setup Option; 0x02 is not.
      setupOptions: new Map<bigint, SetupOptionValue[]>([
        [0x05n, [new TextEncoder().encode('relay.example')]],
      ]),
    });
    expect(data.type).toBe('playa_setup');
    expect(data.playa_reason).toBe('not defined by moqt-06');
    expect(data.number_of_parameters).toBe(1);
    expect(data.setup_parameters).toEqual([{ name: 'authority', value: 'relay.example' }]);
  });

  it('omits parameter fields for messages that carry none', () => {
    const data = messageData({ type: 'UNSUBSCRIBE', requestId: 5n });
    expect(data.request_id).toBe(5);
    expect(data).not.toHaveProperty('number_of_parameters');
    expect(data).not.toHaveProperty('parameters');
  });
});

describe('control message field families (-06)', () => {
  function messageData(message: ControlMessage): Record<string, unknown> {
    let t = 0;
    const trace = new QlogTrace('families', () => t++);
    trace.record({ type: 'control_message_created', stream_id: 0n, message });
    return trace.toContained().traces[0]!.events[0]!.data.message as Record<string, unknown>;
  }

  it('nests a standalone FETCH with both locations', () => {
    const data = messageData({
      type: 'FETCH',
      requestId: 1n,
      fetch: {
        fetchType: 0x1,
        trackNamespace: [new TextEncoder().encode('ns')],
        trackName: new TextEncoder().encode('t'),
        startLocation: { group: 1n, object: 0n },
        endLocation: { group: 9n, object: 4n },
      },
      parameters: new Map(),
    } as ControlMessage);
    expect(data.fetch_type).toBe('standalone');
    expect(data.standalone_fetch).toEqual({
      track_namespace: [{ value: 'ns' }],
      track_name: { value: 't' },
      start_location: { group: 1, object: 0 },
      end_location: { group: 9, object: 4 },
    });
    expect(data).not.toHaveProperty('joining_fetch');
  });

  it('names both joining fetch types and nests their fields', () => {
    const relative = messageData({
      type: 'FETCH',
      requestId: 1n,
      fetch: { fetchType: 0x2, joiningRequestId: 7n, joiningStart: 2n },
      parameters: new Map(),
    } as ControlMessage);
    expect(relative.fetch_type).toBe('relative_joining');
    expect(relative.joining_fetch).toEqual({ joining_request_id: 7, joining_start: 2 });

    const absolute = messageData({
      type: 'FETCH',
      requestId: 1n,
      fetch: { fetchType: 0x3, joiningRequestId: 7n, joiningStart: 2n },
      parameters: new Map(),
    } as ControlMessage);
    expect(absolute.fetch_type).toBe('absolute_joining');
  });

  it('emits FETCH_OK end_location as a group/object pair', () => {
    const data = messageData({
      type: 'FETCH_OK',
      requestId: 1n,
      endOfTrack: 0,
      endLocation: { group: 1n << 62n, object: 3n },
      parameters: new Map(),
    } as ControlMessage);
    expect(data.end_location).toEqual({ group: '4611686018427387904', object: 3 });
  });

  it('maps track properties onto track_extensions by type parity', () => {
    const data = messageData({
      type: 'FETCH_OK',
      requestId: 1n,
      endOfTrack: 0,
      endLocation: { group: 0n, object: 0n },
      parameters: new Map(),
      trackProperties: new Map([
        [2n, [42n]],
        [3n, [new Uint8Array([1, 2, 3])]],
      ]),
    } as ControlMessage);
    expect(data.track_extensions).toEqual([
      { header_type: 2, header_value: 42 },
      { header_type: 3, payload: { payload_length: 3 } },
    ]);
  });

  it('marks fields -06 does not define rather than faking standard names', () => {
    // newSessionUri is a string; RawInfo.payload_length is a wire-byte count,
    // so a supplementary character must not be counted as UTF-16 units.
    const uri = 'https://x/\u{1F600}';
    const data = messageData({ type: 'GOAWAY', newSessionUri: uri });
    const bytes = new TextEncoder().encode(uri).length;
    expect(bytes).toBe(14);
    expect(data.new_session_uri).toEqual({ length: bytes, payload_length: bytes });
    expect(data).not.toHaveProperty('playa_unmapped');

  });
});

/**
 * We support transport drafts 14, 16, and 18 while -06 tracks one revision, so
 * a semantically valid message can lack a field the standardized definition of
 * the same name requires. Those must not be presented as recognized -06
 * structures.
 */
describe('cross-draft compatibility policy', () => {
  function messageData(message: ControlMessage): Record<string, unknown> {
    let t = 0;
    const trace = new QlogTrace('compat', () => t++);
    trace.record({ type: 'control_message_created', stream_id: 0n, message });
    return trace.toContained().traces[0]!.events[0]!.data.message as Record<string, unknown>;
  }

  it('privatizes draft-14 PUBLISH_NAMESPACE_DONE, which has no request_id', () => {
    const data = messageData({
      type: 'PUBLISH_NAMESPACE_DONE',
      trackNamespace: [new TextEncoder().encode('live')],
    });
    expect(data.type).toBe('playa_publish_namespace_done');
    expect(data.playa_reason).toContain('request_id');
    // The diagnostic is preserved, not dropped.
    expect(data.track_namespace).toEqual([{ value: 'live' }]);
  });

  it('privatizes draft-14 PUBLISH_NAMESPACE_CANCEL, which has no request_id', () => {
    const data = messageData({
      type: 'PUBLISH_NAMESPACE_CANCEL',
      trackNamespace: [new TextEncoder().encode('live')],
      errorCode: varint(1),
      errorReason: 'x',
    });
    expect(data.type).toBe('playa_publish_namespace_cancel');
    expect(data.playa_reason).toContain('request_id');
    expect(data.error_code).toBe(1);
  });

  it('keeps the standardized name for the valid draft-16 form', () => {
    const data = messageData({ type: 'PUBLISH_NAMESPACE_DONE', requestId: 3n });
    expect(data.type).toBe('publish_namespace_done');
    expect(data.request_id).toBe(3);
    expect(data).not.toHaveProperty('playa_reason');
  });

  it('privatizes draft-18-only message types -06 does not define', () => {
    const blocked = messageData({
      type: 'PUBLISH_BLOCKED',
      trackNamespaceSuffix: [new TextEncoder().encode('live')],
      trackName: new TextEncoder().encode('video'),
    });
    expect(blocked.type).toBe('playa_publish_blocked');
    expect(blocked.playa_reason).toBe('not defined by moqt-06');
    expect(blocked.track_name).toEqual({ value: 'video' });
  });

  it('privatizes the draft-14-only message types', () => {
    const ns = [new TextEncoder().encode('live')];
    const messages: ControlMessage[] = [
      {
        type: 'PUBLISH_ERROR', requestId: 1n, errorCode: varint(1), errorReason: 'x',
      } satisfies Variant<'PUBLISH_ERROR'>,
      {
        type: 'UNSUBSCRIBE_NAMESPACE', trackNamespacePrefix: ns,
      } satisfies Variant<'UNSUBSCRIBE_NAMESPACE'>,
      {
        type: 'PUBLISH_NAMESPACE_OK', requestId: 1n,
      } satisfies Variant<'PUBLISH_NAMESPACE_OK'>,
      {
        type: 'PUBLISH_NAMESPACE_ERROR', requestId: 1n, errorCode: varint(1), errorReason: 'x',
      } satisfies Variant<'PUBLISH_NAMESPACE_ERROR'>,
    ];
    for (const message of messages) {
      const data = messageData(message);
      expect(data.type).toBe(`playa_${message.type.toLowerCase()}`);
      expect(data.playa_reason).toBe('not defined by moqt-06');
    }
  });

  it('privatizes a draft-14 SUBSCRIBE_NAMESPACE, which carries no option', () => {
    const data = messageData({
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: 1n,
      trackNamespacePrefix: [new TextEncoder().encode('live')],
      parameters: new Map(),
    });
    expect(data.type).toBe('playa_subscribe_namespace');
    expect(data.playa_reason).toContain('subscribe_options');
  });

  it('maps a corroborated subscribe option to its -06 name', () => {
    const data = messageData({
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: 1n,
      trackNamespacePrefix: [new TextEncoder().encode('live')],
      subscribeOptions: varint(0x02),
      parameters: new Map(),
    });
    expect(data.subscribe_options).toBe('both');
    expect(data).not.toHaveProperty('playa_unmapped');
  });

  it('maps all three subscribe option values (transport-16 §9.25)', () => {
    const expected = [
      [0x00, 'publish'],
      [0x01, 'namespace'],
      [0x02, 'both'],
    ] as const;
    for (const [code, name] of expected) {
      const data = messageData({
        type: 'SUBSCRIBE_NAMESPACE',
        requestId: 1n,
        trackNamespacePrefix: [new TextEncoder().encode('live')],
        subscribeOptions: varint(code),
        parameters: new Map(),
      });
      expect(data.subscribe_options).toBe(name);
      expect(data.type).toBe('subscribe_namespace');
      expect(data).not.toHaveProperty('playa_unmapped');
    }
  });

  it('leaves an unrecognized subscribe option value unmapped', () => {
    const data = messageData({
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: 1n,
      trackNamespacePrefix: [new TextEncoder().encode('live')],
      subscribeOptions: varint(0x09),
      parameters: new Map(),
    });
    expect(data.type).toBe('playa_subscribe_namespace');
    expect(data.playa_unmapped).toEqual({ subscribe_options: 9 });
  });
});

describe('registered scalar parameters and text safety', () => {
  function messageData(message: ControlMessage): Record<string, unknown> {
    let t = 0;
    const trace = new QlogTrace('scalars', () => t++);
    trace.record({ type: 'control_message_created', stream_id: 0n, message });
    return trace.toContained().traces[0]!.events[0]!.data.message as Record<string, unknown>;
  }

  it('names the registered scalar message parameters (§5.5.5-§5.5.12)', () => {
    const data = messageData({
      type: 'SUBSCRIBE_OK',
      requestId: 1n,
      trackAlias: 2n,
      parameters: new Map<bigint, ParameterValue[]>([
        [0x10n, [1n]],
        [0x20n, [64n]],
        [0x22n, [2n]],
        [0x32n, [1n]],
      ]),
    });
    expect(data.parameters).toEqual([
      { name: 'forward', value: 1 },
      { name: 'subscriber_priority', value: 64 },
      { name: 'group_order', value: 2 },
      { name: 'new_group_request', value: 1 },
    ]);
    expect(JSON.stringify(data)).not.toContain('unknown');
  });

  it('keeps structured parameters we cannot yet decode in the unknown form', () => {
    const data = messageData({
      type: 'SUBSCRIBE_OK',
      requestId: 1n,
      trackAlias: 2n,
      parameters: new Map<bigint, ParameterValue[]>([[0x21n, [new Uint8Array([1, 2])]]]),
    });
    expect(data.parameters).toEqual([
      { name: 'unknown', name_bytes: 33, value_bytes: { length: 2, payload_length: 2 } },
    ]);
  });

  it('does not promote invalid UTF-8 to a standardized text value', () => {
    const data = messageData({
      type: 'CLIENT_SETUP',
      // 0xff is not valid UTF-8; a lossy decode would emit U+FFFD and claim
      // a valid authority.
      parameters: new Map<bigint, ParameterValue[]>([[0x05n, [new Uint8Array([0xff])]]]),
    });
    expect(data.setup_parameters).toEqual([
      { name: 'unknown', name_bytes: 5, value_bytes: { length: 1, payload_length: 1 } },
    ]);
    expect(JSON.stringify(data)).not.toContain('�');
  });

  it('advertises the draft-period schema URI required by §3.1', () => {
    // The revisionless URI belongs to the eventual RFC; §3.1 requires draft
    // implementations to append the draft number, and forbids the bare form.
    expect(MOQT_EVENT_SCHEMA).toBe('urn:ietf:params:qlog:events:moqt-06');
  });
});

/**
 * A recognized discriminant is not enough: our transport union spans drafts
 * 14, 16, and 18, so a valid newer-draft message can carry fields the concrete
 * -06 alternative of that name does not define. Those must not be presented as
 * faithful instances.
 */
describe('same-name variant shapes (-06 §5.7.3, §5.7.6, §5.7.7)', () => {
  function messageData(message: ControlMessage): Record<string, unknown> {
    let t = 0;
    const trace = new QlogTrace('variants', () => t++);
    trace.record({ type: 'control_message_created', stream_id: 0n, message });
    return trace.toContained().traces[0]!.events[0]!.data.message as Record<string, unknown>;
  }

  it('keeps a draft-16 GOAWAY standard', () => {
    const data = messageData({ type: 'GOAWAY', newSessionUri: 'https://x/' });
    expect(data.type).toBe('goaway');
    expect(data).not.toHaveProperty('playa_reason');
  });

  it('privatizes a draft-18 GOAWAY carrying a request id and timeout', () => {
    const data = messageData({
      type: 'GOAWAY',
      newSessionUri: 'https://x/',
      timeout: 5000n,
      requestId: 9n,
    });
    expect(data.type).toBe('playa_goaway');
    expect(data.playa_reason).toBe(
      'field(s) outside the moqt-06 shape: request_id, timeout',
    );
    // Both values must survive privatization, not merely trigger it.
    expect(data.request_id).toBe(9);
    expect(data.playa_unmapped).toEqual({ timeout: 5000 });
  });

  it('keeps an ordinary REQUEST_OK standard', () => {
    const data = messageData({ type: 'REQUEST_OK', requestId: 1n, parameters: new Map() });
    expect(data.type).toBe('request_ok');
    expect(data).not.toHaveProperty('playa_reason');
  });

  it('privatizes a REQUEST_OK carrying Track Properties', () => {
    const data = messageData({
      type: 'REQUEST_OK',
      requestId: 1n,
      parameters: new Map(),
      trackProperties: new Map([[2n, [42n]]]),
    });
    expect(data.type).toBe('playa_request_ok');
    expect(data.playa_reason).toContain('track_extensions');
    // -06 SUBSCRIBE_OK does allow track_extensions, so this is specific to
    // the concrete REQUEST_OK shape, not a blanket rule.
    expect(data.track_extensions).toEqual([{ header_type: 2, header_value: 42 }]);
  });

  it('keeps an ordinary REQUEST_ERROR standard', () => {
    const data = messageData({
      type: 'REQUEST_ERROR',
      requestId: 1n,
      errorCode: varint(52),
      errorReason: 'gone',
      retryInterval: 0n,
    });
    expect(data.type).toBe('request_error');
    expect(data).not.toHaveProperty('playa_reason');
  });

  it('privatizes a REQUEST_ERROR redirect and preserves its target', () => {
    const data = messageData({
      type: 'REQUEST_ERROR',
      requestId: 1n,
      errorCode: varint(52),
      errorReason: 'redirect',
      retryInterval: 0n,
      redirect: {
        connectUri: new TextEncoder().encode('https://relay2/'),
        trackNamespace: [new TextEncoder().encode('live')],
        trackName: new TextEncoder().encode('video'),
      },
    });
    expect(data.type).toBe('playa_request_error');
    // The diagnostic must survive: a bare boolean would drop the target.
    expect(data.playa_unmapped).toEqual({
      redirect: {
        connect_uri: { length: 15, payload_length: 15 },
        track_namespace: [{ value: 'live' }],
        track_name: { value: 'video' },
      },
    });
  });

  it('privatizes a draft-14 REQUEST_ERROR carrying a request kind', () => {
    const data = messageData({
      type: 'REQUEST_ERROR',
      requestId: 1n,
      errorCode: varint(1),
      errorReason: 'x',
      retryInterval: 0n,
      requestKind: 'SUBSCRIBE',
    });
    expect(data.type).toBe('playa_request_error');
    expect(data.playa_unmapped).toEqual({ request_kind: 'SUBSCRIBE' });
  });

  it('allows track_extensions where -06 defines them', () => {
    const data = messageData({
      type: 'SUBSCRIBE_OK',
      requestId: 1n,
      trackAlias: 2n,
      parameters: new Map(),
      trackProperties: new Map([[2n, [42n]]]),
    });
    expect(data.type).toBe('subscribe_ok');
    expect(data).not.toHaveProperty('playa_reason');
  });
});
