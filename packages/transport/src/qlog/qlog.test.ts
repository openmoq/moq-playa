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
import { QlogTrace } from './trace.js';
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
import type { ControlMessage } from '../control/messages.js';

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
