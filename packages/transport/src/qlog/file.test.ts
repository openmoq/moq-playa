/**
 * qlog file machinery tests — [QLOG-MAIN] draft-14 envelopes and framing.
 *
 * @see draft-ietf-quic-qlog-main-schema-14
 * @see RFC 7464
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  QLOG_FILE_SCHEMA_CONTAINED,
  QLOG_FILE_SCHEMA_SEQUENTIAL,
  QLOG_FORMAT_JSON,
  QLOG_FORMAT_JSON_SEQ,
  QlogEventLog,
  parseSeq,
  seqHeader,
  seqRecord,
  serializeSeq,
  toContainedFile,
} from './file.js';
import type { QlogClock, QlogEventRecord, QlogTraceSpec } from './file.js';

const RS = '\x1e';
const LF = '\n';

const SPEC: QlogTraceSpec = {
  title: 'test trace',
  event_schemas: ['urn:ietf:params:qlog:events:moqt-06'],
  vantage_point: { type: 'client' },
  common_fields: {
    time_format: 'relative_to_epoch',
    reference_time: { clock_type: 'monotonic', epoch: 'unknown' },
  },
};

const EVENTS: QlogEventRecord[] = [
  { time: 0, name: 'moqt:stream_type_set', data: { stream_id: 0 } },
  { time: 1.5, name: 'moqt:subgroup_header_parsed', data: { group_id: 7 } },
];

/** Deterministic clock — ticks 1ms per read. */
function testClock(id = 'clock-0'): QlogClock {
  let t = 0;
  return { clock_id: id, clock_type: 'monotonic', now: () => t++ };
}

describe('contained envelope', () => {
  it('emits the draft-14 file schema and format', () => {
    const file = toContainedFile(SPEC, EVENTS);
    expect(file.file_schema).toBe('urn:ietf:params:qlog:file:contained');
    expect(file.serialization_format).toBe('application/qlog+json');
  });

  it('puts event_schemas inside the trace, not at top level', () => {
    const file = toContainedFile(SPEC, EVENTS);
    expect(file.traces[0]!.event_schemas).toEqual(['urn:ietf:params:qlog:events:moqt-06']);
    expect(file).not.toHaveProperty('event_schemas');
  });

  it('carries events and round-trips through JSON', () => {
    const file = toContainedFile(SPEC, EVENTS);
    const reparsed = JSON.parse(JSON.stringify(file));
    expect(reparsed.traces[0].events).toHaveLength(2);
    expect(reparsed.traces[0].events[1].name).toBe('moqt:subgroup_header_parsed');
  });

  it('omits absent file metadata rather than emitting undefined', () => {
    const file = toContainedFile(SPEC, EVENTS);
    expect(file).not.toHaveProperty('title');
    expect(toContainedFile(SPEC, EVENTS, { title: 'x' }).title).toBe('x');
  });
});

describe('sequential framing', () => {
  it('prefixes every record with RS and terminates with LF', () => {
    const doc = serializeSeq(SPEC, EVENTS);
    expect(doc.startsWith(RS)).toBe(true);
    expect(doc.endsWith(LF)).toBe(true);
    // header + 2 events
    expect(doc.split(RS)).toHaveLength(4); // leading empty chunk + 3 records
    for (const chunk of doc.split(RS).slice(1)) {
      expect(chunk.endsWith(LF)).toBe(true);
    }
  });

  it('emits the draft-14 sequential header', () => {
    const parsed = JSON.parse(seqHeader(SPEC).slice(1, -1));
    expect(parsed.file_schema).toBe('urn:ietf:params:qlog:file:sequential');
    expect(parsed.serialization_format).toBe('application/qlog+json-seq');
    expect(parsed.trace.event_schemas).toEqual(SPEC.event_schemas);
    expect(parsed.trace).not.toHaveProperty('events');
  });

  it('never emits a raw RS inside a record payload', () => {
    const record = seqRecord({ time: 0, name: 'x:y', data: { text: `a${RS}b` } });
    expect(record.slice(1, -1)).not.toContain(RS);
    expect(JSON.parse(record.slice(1, -1)).data.text).toBe(`a${RS}b`);
  });

  it('round-trips through parseSeq', () => {
    const result = parseSeq(serializeSeq(SPEC, EVENTS));
    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(2);
    expect(result.header.trace.event_schemas).toEqual(SPEC.event_schemas);
  });
});

describe('truncation recovery', () => {
  it('recovers records preceding a cut mid-record', () => {
    const doc = serializeSeq(SPEC, EVENTS);
    const cut = doc.slice(0, doc.length - 12);
    const result = parseSeq(cut);
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.name).toBe('moqt:stream_type_set');
  });

  it('reports truncation when the final record lost only its terminator', () => {
    const doc = serializeSeq(SPEC, EVENTS);
    const result = parseSeq(doc.slice(0, -1));
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it('does not bless corruption in an earlier record', () => {
    const doc = serializeSeq(SPEC, EVENTS);
    const corrupted = doc.replace('{"time":0', '{"time":0,,,');
    expect(() => parseSeq(corrupted)).toThrow(/corrupt, not truncated/);
  });

  it('rejects a lost terminator in an earlier record', () => {
    const parts = serializeSeq(SPEC, EVENTS).split(RS).slice(1);
    const damaged = RS + parts[0]!.slice(0, -1) + RS + parts[1]! + RS + parts[2]!;
    expect(() => parseSeq(damaged)).toThrow(/corrupt, not truncated/);
  });

  it('rejects input that is not JSON-SEQ at all', () => {
    expect(() => parseSeq('{"file_schema":"x"}')).toThrow(/record separator/);
  });

  it('rejects a header with the wrong file schema', () => {
    const doc = serializeSeq(SPEC, EVENTS).replace(
      QLOG_FILE_SCHEMA_SEQUENTIAL,
      QLOG_FILE_SCHEMA_CONTAINED,
    );
    expect(() => parseSeq(doc)).toThrow(/unexpected file_schema/);
  });
});

describe('QlogEventLog', () => {
  it('timestamps events from the injected clock', () => {
    const log = new QlogEventLog({ clock: testClock() });
    log.record('moqt:a', {});
    log.record('moqt:b', {});
    expect(log.events.map(e => e.time)).toEqual([0, 1]);
    expect(log.clockId).toBe('clock-0');
  });

  it('accepts events from any namespace', () => {
    const log = new QlogEventLog({ clock: testClock() });
    log.record('moqt:stream_type_set', {});
    log.record('loglevel:warning', { message: 'x' });
    log.record('moq_playout:frame_scheduled', {});
    expect(log.namespaces()).toEqual(['moqt', 'loglevel', 'moq_playout']);
  });

  it('rejects an unnamespaced event name', () => {
    const log = new QlogEventLog({ clock: testClock() });
    expect(() => log.record('frame_scheduled', {})).toThrow(/<namespace>:<event_type>/);
  });

  it('keeps sessions distinguishable via per-event group_id', () => {
    const log = new QlogEventLog({ clock: testClock(), defaultGroupId: 'run-1' });
    log.record('moqt:control_message_parsed', {}, 'session-a');
    log.record('moqt:control_message_parsed', {}, 'session-b');
    log.record('moq_playout:frame_presented', {});
    expect(log.events.map(e => e.group_id)).toEqual(['session-a', 'session-b', 'run-1']);
  });

  it('omits group_id entirely when none is configured', () => {
    const log = new QlogEventLog({ clock: testClock() });
    log.record('moqt:a', {});
    expect(log.events[0]).not.toHaveProperty('group_id');
  });

  it('serializes into both envelope forms', () => {
    const log = new QlogEventLog({ clock: testClock(), defaultGroupId: 'run-1' });
    log.record('moqt:a', { v: 1 });
    const contained = toContainedFile(SPEC, log.events);
    const sequential = parseSeq(serializeSeq(SPEC, log.events));
    expect(contained.traces[0]!.events).toEqual(log.events);
    expect(sequential.events).toEqual(log.events);
  });
});

describe('malformed input is not laundered as truncation', () => {
  const header = seqHeader(SPEC);

  it('throws on an LF-terminated malformed final record', () => {
    // Framing is complete — the LF is present — so this is corruption, not a
    // capture cut short, even though it is last.
    expect(() => parseSeq(`${header}${RS}{"time":0,}${LF}`)).toThrow(/corrupt, not truncated/);
  });

  it('still recovers a final record that lost only its terminator', () => {
    const doc = serializeSeq(SPEC, EVENTS);
    const result = parseSeq(doc.slice(0, -1));
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it('rejects a header whose serialization format is not json-seq', () => {
    expect(() => parseSeq(header.replace('json-seq', 'json'))).toThrow(/serialization_format/);
  });

  it('accepts a serialization format differing only in case, and normalizes it', () => {
    const upper = header.replace('application/qlog+json-seq', 'APPLICATION/QLOG+JSON-SEQ');
    expect(parseSeq(upper).header.serialization_format).toBe('application/qlog+json-seq');
  });

  it('rejects a header with no trace object', () => {
    const noTrace = `${RS}${JSON.stringify({
      file_schema: QLOG_FILE_SCHEMA_SEQUENTIAL,
      serialization_format: QLOG_FORMAT_JSON_SEQ,
    })}${LF}`;
    expect(() => parseSeq(noTrace)).toThrow(/trace/);
  });

  it('rejects a trace with an empty or non-string event_schemas', () => {
    const empty = `${RS}${JSON.stringify({
      file_schema: QLOG_FILE_SCHEMA_SEQUENTIAL,
      serialization_format: QLOG_FORMAT_JSON_SEQ,
      trace: { event_schemas: [] },
    })}${LF}`;
    expect(() => parseSeq(empty)).toThrow(/event_schemas/);
  });

  it('rejects a non-object header', () => {
    expect(() => parseSeq(`${RS}"nope"${LF}`)).toThrow(/header/);
  });
});

describe('event name validation', () => {
  function log() {
    return new QlogEventLog({ clock: testClock() });
  }

  it('rejects an empty namespace', () => {
    expect(() => log().record(':frame_presented', {})).toThrow(/namespace/);
  });

  it('rejects an empty event type', () => {
    expect(() => log().record('moq_playout:', {})).toThrow(/event type/);
  });

  it('rejects a namespace outside the URI-unreserved set', () => {
    expect(() => log().record('bad namespace:event', {})).toThrow(/namespace/);
  });

  it('accepts the namespaces we actually use', () => {
    const l = log();
    for (const name of ['moqt:stream_type_set', 'loglevel:warning', 'moq_playout:frame_presented']) {
      expect(() => l.record(name, {})).not.toThrow();
    }
    expect(l.namespaces()).toEqual(['moqt', 'loglevel', 'moq_playout']);
  });

  it('keeps colons in the event type', () => {
    const l = log();
    l.record('moqt:a:b', {});
    expect(l.events[0]!.name).toBe('moqt:a:b');
    expect(l.namespaces()).toEqual(['moqt']);
  });
});
