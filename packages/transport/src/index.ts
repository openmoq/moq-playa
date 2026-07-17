/**
 * @moqt/transport — Sans-I/O protocol core for MOQT draft-ietf-moq-transport-16
 * @module
 */

// ─── Primitives ──────────────────────────────────────────────────────
export { varint, readVarint, writeVarint, varintEncodingLength, MAX_VARINT } from './primitives/varint.js';
export type { Varint } from './primitives/varint.js';

// draft-18 variable-length integer (vi64). Operates on raw bigint (full uint64);
// deliberately not the QUIC-varint `Varint` brand. @see draft-18 §1.4.1
export { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from './primitives/vi64.js';

// ─── draft-18 wire code tables (foundation; codec lands incrementally) ──
export {
  ControlMessageType18,
  SetupOption18,
  MessageParam18,
  PropertyRange18,
  isMandatoryProperty,
} from './control/codes-18.js';
export type { ParamValueKind } from './control/codes-18.js';
export {
  StreamType18,
  PADDING_DATAGRAM_TYPE,
  SubgroupFlags18,
  DatagramFlags18,
  SUBGROUP_ID_MODE_RESERVED,
  subgroupIdMode18,
  isSubgroupHeaderForm18,
  isValidSubgroupHeaderType18,
  isDatagramForm18,
  isValidDatagramType18,
} from './data/codes-18.js';
export { classifyStream18, classifyStreamTypeValue18 } from './data/stream-type-18.js';
export type { StreamClass18, ClassifiedStream18 } from './data/stream-type-18.js';
export {
  encodeMessageParams18,
  decodeMessageParams18,
  messageParams18EncodingLength,
  DEFAULT_MESSAGE_PARAM_REGISTRY,
} from './control/message-params-18.js';
export type {
  MessageParamValue,
  MessageParams18,
  MessageParamRegistry,
} from './control/message-params-18.js';
export {
  encodeTrackProperties18,
  decodeTrackProperties18,
  trackProperties18EncodingLength,
  hasObjectOnlyTrackProperty,
  hasUnsupportedMandatoryTrackProperty,
} from './control/track-properties-18.js';

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
// draft-18 error code registries (canonical; the legacy exports above stay draft-14/16).
export { RequestError18, PublishDoneCode18, StreamResetCode18, DataStreamError18 } from './errors.js';

// ─── Control Messages ────────────────────────────────────────────────
export { MessageType } from './control/codes.js';
export type { MessageTypeCode } from './control/codes.js';

export { SetupParam, MessageParam } from './control/parameters.js';

export type {
  ControlMessage,
  Parameters,
  TrackProperties,
  TrackPropertyValue,
  TrackExtensions,
  Redirect,
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
  SubscribeTracks,
  PublishBlocked,
  UnsubscribeNamespace,
  PublishNamespaceOk,
  PublishNamespaceError,
  RequestId,
  TrackAlias,
  Setup,
  SetupOptionMap,
  SetupOptionValue,
  ParameterValue,
} from './control/messages.js';

export { encodeControlMessage } from './control/encoder.js';
export { decodeControlMessage } from './control/decoder.js';

export { createControlCodec } from './control/codec.js';
export type { ControlCodec, DraftVersion, DecodedControlMessage } from './control/codec.js';

// ─── Profile (per-draft behavior bundle) ─────────────────────────────
export { isWiredDraft, WIRED_DRAFTS } from './versions.js';
export { getProtocolProfile } from './profile.js';
export type { ProtocolProfile, ProfileCapabilities } from './profile.js';
export { getRequestPolicy } from './session/request-policy.js';
export type { RequestPolicy, InboundValidation } from './session/request-policy.js';

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
  GroupOrder,
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
  decodeSubgroupHeader18,
  decodeSubgroupObject18,
  decodeObjectDatagram18,
  decodeFetchHeader18,
  decodeFetchObject18,
} from './data/decoder-18.js';
// GroupOrder is exported above from the neutral './data/types.js' (its home).
export type { FetchObjectPrior18 } from './data/decoder-18.js';

export { createDataCodec } from './data/data-codec.js';
export type { DataCodec, StreamClass, DatagramClass } from './data/data-codec.js';

export {
  encodeSubgroupHeader,
  encodeSubgroupObject,
  encodeFetchHeader,
  encodeFetchObject,
  encodeFetchEndOfRange,
  encodeObjectDatagram,
} from './data/encoder.js';
export {
  encodeSubgroupHeader18,
  encodeSubgroupObject18,
  encodeObjectDatagram18,
  encodeFetchHeader18,
  encodeFetchObject18,
  encodeFetchEndOfRange18,
} from './data/encoder-18.js';
export type { FetchObjectFields } from './data/encoder-18.js';

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
export type { RequestEndpoint } from './session/request-endpoint.js';
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
export type { SetupOptions, SubscribeOptions, RequestUpdateOptions, FetchOptions, JoiningFetchOptions, FetchAcceptOptions, TrackStatusAcceptOptions, RequestResult } from './session/session.js';
export { resolveJoiningFetchRange, type JoiningFetchFields } from './session/joining.js';
export { decodeSubscriptionFilter } from './control/subscription-filter.js';
export type { SubscriptionFilter } from './control/subscription-filter.js';
