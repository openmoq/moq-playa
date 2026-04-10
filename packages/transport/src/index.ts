/**
 * @moqt/transport — Sans-I/O protocol core for MOQT draft-ietf-moq-transport-16
 * @module
 */

// ─── Primitives ──────────────────────────────────────────────────────
export { varint, readVarint, writeVarint, varintEncodingLength, MAX_VARINT } from './primitives/varint.js';
export type { Varint } from './primitives/varint.js';

export {
  readUint8, writeUint8,
  readBytes,
  readLengthPrefixedBytes, writeLengthPrefixedBytes, lengthPrefixedBytesEncodingLength,
  readTuple, writeTuple, tupleEncodingLength,
  validateTrackNamespace, validateTrackNamespacePrefix, validateTrackNamespaceSuffix, validateFullTrackName,
} from './primitives/bytes.js';

export { readKvpList, writeKvpList, kvpListEncodingLength } from './primitives/kvp.js';
export type { KvpValue } from './primitives/kvp.js';

export { readLocation, writeLocation, locationEncodingLength } from './primitives/location.js';
export type { Location } from './primitives/location.js';

export { readReasonPhrase, writeReasonPhrase, reasonPhraseEncodingLength } from './primitives/reason.js';

// ─── Error Codes ─────────────────────────────────────────────────────
export { SessionError, RequestError, PublishDoneCode, DataStreamError, ProtocolViolationError } from './errors.js';

// ─── Control Messages ────────────────────────────────────────────────
export { MessageType } from './control/codes.js';
export type { MessageTypeCode } from './control/codes.js';

export { SetupParam, MessageParam } from './control/parameters.js';

export type {
  ControlMessage,
  Parameters,
  TrackExtensions,
  ClientSetup,
  ServerSetup,
  Goaway,
  MaxRequestId,
  RequestsBlocked,
  RequestOk,
  RequestErrorMsg,
  Subscribe,
  SubscribeOk,
  RequestUpdate,
  Unsubscribe,
  Publish,
  PublishOk,
  PublishError,
  PublishDone,
  Fetch,
  StandaloneFetch,
  JoiningFetch,
  FetchOk,
  FetchCancel,
  TrackStatus,
  PublishNamespace,
  Namespace,
  PublishNamespaceDone,
  NamespaceDone,
  PublishNamespaceCancel,
  SubscribeNamespace,
  UnsubscribeNamespace,
  PublishNamespaceOk,
  PublishNamespaceError,
} from './control/messages.js';

export { encodeControlMessage } from './control/encoder.js';
export { decodeControlMessage } from './control/decoder.js';

export { createControlCodec } from './control/codec.js';
export type { ControlCodec, DraftVersion } from './control/codec.js';

// ─── Data Plane ──────────────────────────────────────────────────────
export {
  ObjectStatus,
  DataStreamType,
  SubgroupFlags,
  SubgroupIdMode,
  DatagramFlags,
  FetchFlags,
  FetchSubgroupMode,
  FetchSpecialFlags,
  isSubgroupHeaderType,
  isDatagramType,
  isValidSubgroupIdMode,
  isValidDatagramFlags,
  getSubgroupIdMode,
} from './data/codes.js';

export type {
  SubgroupHeader,
  SubgroupObject,
  FetchHeader,
  FetchObject,
  FetchEndOfRange,
  ObjectDatagram,
  DataStreamHeader,
  MoqtObject,
  MoqtObjectData,
  MoqtObjectGap,
} from './data/types.js';

export {
  decodeSubgroupHeader,
  decodeSubgroupObject,
  decodeFetchHeader,
  decodeFetchObject,
  decodeFetchObjectV14,
  decodeObjectDatagram,
} from './data/decoder.js';
export type { FetchPriorContext, DecodedFetchItem } from './data/decoder.js';

export {
  encodeSubgroupHeader,
  encodeSubgroupObject,
  encodeFetchHeader,
  encodeFetchObject,
  encodeFetchEndOfRange,
  encodeObjectDatagram,
} from './data/encoder.js';

// ─── qlog (draft-pardue-moq-qlog-moq-events-04) ─────────────────────
export { QlogTrace } from './qlog/trace.js';
export type { QlogTraceEvent, QlogTraceJson, QlogTraceEntry } from './qlog/trace.js';
export type {
  QlogEvent,
  QlogControlMessageCreated,
  QlogControlMessageParsed,
  QlogStreamTypeSet,
  QlogObjectDatagramParsed,
  QlogSubgroupHeaderParsed,
  QlogSubgroupObjectParsed,
  QlogFetchHeaderParsed,
  QlogFetchObjectParsed,
  QlogImportance,
  QlogStreamType,
  QlogOwner,
  QlogRawInfo,
  QlogExtensionHeader,
} from './qlog/types.js';


// ─── Session Layer ──────────────────────────────────────────────────────
export {
  SessionState,
  EndpointRole,
  SubscriptionState,
  ForwardState,
  FetchState,
  NamespaceState,
} from './session/types.js';
export type {
  SessionStateValue,
  EndpointRoleValue,
  SubscriptionStateValue,
  ForwardStateValue,
  FetchStateValue,
  NamespaceStateValue,
  SessionInboundEvent,
  SessionOutboundAction,
  SessionEmittedEvent,
  ControlMessageEvent,
  DataStreamOpenedEvent,
  ObjectReceivedEvent,
  StreamClosedEvent,
  ConnectionClosedEvent,
  SendControlAction,
  OpenDataStreamAction,
  SendObjectAction,
  CloseStreamAction,
  ResetStreamAction,
  StopSendingAction,
  OpenNamespaceStreamAction,
  NotifyNamespaceAction,
  CloseConnectionAction,
  SessionStateChangedEvent,
  SubscriptionStateChangedEvent,
  FetchStateChangedEvent,
  ObjectDeliveryEvent,
} from './session/types.js';

export { RequestIdAllocator, RequestIdError } from './session/request-id.js';
export { SetupGate, SetupError } from './session/setup.js';
export type { SetupResult } from './session/setup.js';
export { SubscriptionStateMachine } from './session/subscription.js';
export type { Location as SubscriptionLocation } from './session/subscription.js';
export { FetchStateMachine } from './session/fetch.js';
export { NamespaceStateMachine } from './session/namespace.js';
export { TrackAliasManager } from './session/track-alias.js';
export type { TrackIdentity } from './session/track-alias.js';
export { Session } from './session/session.js';
export { SessionError as SessionProtocolError, SessionDrainingError } from './session/session.js';
export type { SetupOptions, SubscribeOptions, SubscriptionFilter, RequestUpdateOptions, FetchOptions, RequestResult } from './session/session.js';
