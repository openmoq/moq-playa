/**
 * qlog event type definitions for MOQT per draft-pardue-moq-qlog-moq-events-06.
 *
 * Defines the 8 subscriber-relevant event types (of 13 total).
 * Publisher-side events (5 "created" data events) are omitted.
 *
 * Types mirror the CDDL definitions in the spec. Required/optional
 * field markers match the CDDL `?` prefix exactly.
 *
 * @see draft-pardue-moq-qlog-moq-events-06
 * @module
 */

import type { ControlMessage } from '../control/messages.js';

// ─── Common Types (§5) ─────────────────────────────────────────────

/**
 * qlog event importance levels.
 *
 * - `core`: Events essential for basic protocol analysis.
 * - `base`: Supplementary events for deeper analysis.
 *
 * All 8 subscriber events are "core" except stream_type_set ("base").
 * @see draft-pardue-moq-qlog-moq-events-06 §4
 */
export type QlogImportance = 'core' | 'base';

/**
 * Stream owner — who initiated the stream.
 * @see draft-pardue-moq-qlog-moq-events-06 §5.1
 */
export type QlogOwner = 'local' | 'remote';

/**
 * MOQT stream types for stream_type_set.
 * @see draft-pardue-moq-qlog-moq-events-06 §4.3
 */
export type QlogStreamType = 'control' | 'subgroup_header' | 'fetch_header' | 'subscribe_namespace';

/**
 * Raw byte information per [QLOG-MAIN] RawInfo.
 *
 * Used for optional payload capture in data events.
 * Typically only `payload_length` is populated to avoid
 * storing large media payloads in trace output.
 *
 * @see [QLOG-MAIN] §3.3.6 (RawInfo)
 */
export interface QlogRawInfo {
  readonly length?: number;
  readonly payload_length?: number;
  readonly data?: string; // hex-encoded bytes
}

/**
 * Extension header in qlog format.
 * @see draft-pardue-moq-qlog-moq-events-06 §5.7
 */
export interface QlogExtensionHeader {
  readonly header_type: bigint;
  readonly header_value?: bigint;
  readonly header_length?: bigint;
  readonly payload?: QlogRawInfo;
}

// ─── Event Types (§4) ──────────────────────────────────────────────

/**
 * Discriminated union of all 8 subscriber-relevant qlog events.
 *
 * Subscriber events:
 * - control_message_created (§4.1) — we send control messages
 * - control_message_parsed (§4.2) — we receive control messages
 * - stream_type_set (§4.3) — incoming data stream type determined
 * - object_datagram_parsed (§4.5) — decoded datagram
 * - subgroup_header_parsed (§4.7) — decoded subgroup header
 * - subgroup_object_parsed (§4.9) — decoded subgroup object
 * - fetch_header_parsed (§4.11) — decoded fetch header
 * - fetch_object_parsed (§4.13) — decoded fetch object
 *
 * Publisher-side "created" data events (§4.4, §4.6, §4.8, §4.10, §4.12)
 * are not emitted by a subscriber.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4
 */
export type QlogEvent =
  | QlogControlMessageCreated
  | QlogControlMessageParsed
  | QlogStreamTypeSet
  | QlogObjectDatagramParsed
  | QlogSubgroupHeaderParsed
  | QlogSubgroupObjectParsed
  | QlogFetchHeaderParsed
  | QlogFetchObjectParsed;

/**
 * Emitted when a control message is created (sent).
 *
 * Importance: Core.
 *
 * The `message` field contains the full ControlMessage from
 * `@moqt/transport`. QlogTrace.toJSON() converts it to the
 * `$MOQTControlMessage` qlog format (§5.6).
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.1
 */
export interface QlogControlMessageCreated {
  readonly type: 'control_message_created';
  /** Stream ID. For the control stream, uses the adapter's assigned ID. */
  readonly stream_id: bigint;
  /** Wire byte length of the encoded message (optional). */
  readonly length?: number;
  /** The full control message. @see §5.6 ($MOQTControlMessage) */
  readonly message: ControlMessage;
  /** Raw wire bytes (optional). */
  readonly raw?: QlogRawInfo;
}

/**
 * Emitted when a control message is parsed (received).
 *
 * Importance: Core.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.2
 */
export interface QlogControlMessageParsed {
  readonly type: 'control_message_parsed';
  /** Stream ID. For the control stream, uses the adapter's assigned ID. */
  readonly stream_id: bigint;
  /** Wire byte length of the message frame (optional). */
  readonly length?: number;
  /** The full control message. @see §5.6 ($MOQTControlMessage) */
  readonly message: ControlMessage;
  /** Raw wire bytes (optional). */
  readonly raw?: QlogRawInfo;
}

/**
 * Emitted when a MOQT stream type becomes known.
 *
 * Importance: Base.
 *
 * For a subscriber, all data streams are incoming (owner="remote").
 * The control stream type is set once at session establishment.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.3
 */
export interface QlogStreamTypeSet {
  readonly type: 'stream_type_set';
  /** Who initiated the stream. Optional per spec. */
  readonly owner?: QlogOwner;
  /** Stream ID. */
  readonly stream_id: bigint;
  /** The determined stream type. */
  readonly stream_type: QlogStreamType;
}

/**
 * Emitted when an OBJECT_DATAGRAM message is parsed.
 *
 * Importance: Core.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.5
 */
export interface QlogObjectDatagramParsed {
  readonly type: 'object_datagram_parsed';
  readonly track_alias: bigint;
  readonly group_id: bigint;
  /** Optional per spec — absent when ZERO_OBJECT_ID flag set. */
  readonly object_id?: bigint;
  /** Optional per -06 — absent means inherit from subscription. @see draft-pardue-moq-qlog-moq-events-06 §4.5 */
  readonly publisher_priority?: number;
  /** Byte length of extension headers (optional). */
  readonly extension_headers_length?: number;
  /** Parsed extension headers (optional). */
  readonly extension_headers?: readonly QlogExtensionHeader[];
  /** Object status code (optional — only when STATUS flag set). */
  readonly object_status?: bigint;
  /** Object payload raw info (optional). */
  readonly object_payload?: QlogRawInfo;
  /** Whether this is the last object in the group. */
  readonly end_of_group: boolean;
}

/**
 * Emitted when the SUBGROUP_HEADER is parsed from a data stream.
 *
 * Importance: Core.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.7
 */
export interface QlogSubgroupHeaderParsed {
  readonly type: 'subgroup_header_parsed';
  readonly stream_id: bigint;
  readonly track_alias: bigint;
  readonly group_id: bigint;
  /** Required per -06. Encodes bits 1-2 of the type byte. @see draft-pardue-moq-qlog-moq-events-06 §4.7 */
  readonly subgroup_id_mode: number;
  /** Optional per spec — absent when mode is ZERO or FIRST_OBJECT. */
  readonly subgroup_id?: bigint;
  /** Optional per -06 — absent means inherit from subscription. @see draft-pardue-moq-qlog-moq-events-06 §4.7 */
  readonly publisher_priority?: number;
  /** Whether this subgroup contains the end-of-group marker. */
  readonly contains_end_of_group: boolean;
  /** Whether objects on this stream carry extension headers. */
  readonly extensions_present: boolean;
}

/**
 * Emitted when a subgroup object is parsed from a data stream.
 *
 * Importance: Core.
 *
 * group_id and subgroup_id are optional per spec — can be inferred
 * from the subgroup header context.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.9
 */
export interface QlogSubgroupObjectParsed {
  readonly type: 'subgroup_object_parsed';
  readonly stream_id: bigint;
  /** Delta from previous object ID. @see draft-pardue-moq-qlog-moq-events-06 §4.9 */
  readonly object_id_delta: bigint;
  /** Parsed extension headers (optional). */
  readonly extension_headers?: readonly QlogExtensionHeader[];
  /** Required — byte length of object payload. */
  readonly object_payload_length: number;
  /** Object status code (optional — only for status objects). */
  readonly object_status?: bigint;
  /** Object payload raw info (optional). */
  readonly object_payload?: QlogRawInfo;
}

/**
 * Emitted when the FETCH_HEADER is parsed from a data stream.
 *
 * Importance: Core.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.11
 */
export interface QlogFetchHeaderParsed {
  readonly type: 'fetch_header_parsed';
  readonly stream_id: bigint;
  readonly request_id: bigint;
}

/**
 * Emitted when a fetch object is parsed from a data stream.
 *
 * Importance: Core.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §4.13
 */
export interface QlogFetchObjectParsed {
  readonly type: 'fetch_object_parsed';
  readonly stream_id: bigint;
  /** Required per -06. @see draft-pardue-moq-qlog-moq-events-06 §4.13 */
  readonly datagram: boolean;
  /** Required per -06. */
  readonly end_of_nonexistent_range: boolean;
  /** Required per -06. */
  readonly end_of_unknown_range: boolean;
  /** Optional per -06. Subgroup ID encoding mode bits. */
  readonly subgroup_id_bits?: number;
  /** Optional per -06. */
  readonly group_id?: bigint;
  /** Optional per -06. */
  readonly subgroup_id?: bigint;
  /** Optional per -06. */
  readonly object_id?: bigint;
  /** Optional per -06 — absent means inherit from subscription. */
  readonly publisher_priority?: number;
  /** Optional per -06. Byte length of extension headers. */
  readonly extension_headers_length?: number;
  /** Parsed extension headers (optional). */
  readonly extension_headers?: readonly QlogExtensionHeader[];
  /** Required — byte length of object payload. */
  readonly object_payload_length: number;
  /** Object status code (optional). */
  readonly object_status?: bigint;
  /** Object payload raw info (optional). */
  readonly object_payload?: QlogRawInfo;
}
