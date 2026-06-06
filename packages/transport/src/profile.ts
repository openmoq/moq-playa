/**
 * ProtocolProfile — the per-draft bundle of wire/protocol behavior.
 *
 * A profile is the TypeScript expression of "everything that varies between MoQT
 * draft revisions", selected once by version. It is deliberately small: rather
 * than a libmoq-style vtable of one function per message, it composes the three
 * seams Playa already has a grain for —
 *
 *   - {@link ControlCodec}: control-message wire format + framing.
 *   - {@link DataCodec}: object/subgroup/datagram/fetch decode.
 *   - {@link RequestPolicy}: request-admission (credit + inbound validation).
 *   - {@link ProfileCapabilities}: coarse per-draft semantic facts (booleans the
 *     session/adapter can branch on instead of re-deriving from a raw version
 *     number — e.g. "responses omit the Request ID").
 *
 * Stream topology (bidi control vs uni-pair + per-request bidi) is intentionally
 * NOT implemented here — it belongs to the I/O layer (`@moqt/webtransport`),
 * keeping this package sans-I/O. The capability *flags* describe whether a draft
 * uses those mechanisms, but the wiring lives in the adapter.
 *
 * @module
 */

import { createControlCodec, type ControlCodec } from './control/codec.js';
import { createDataCodec, type DataCodec } from './data/data-codec.js';
import { getRequestPolicy, type RequestPolicy } from './session/request-policy.js';
import type { DraftVersion } from './versions.js';

/**
 * Coarse, session/adapter-facing per-draft semantic facts.
 *
 * These are deliberately *not* wire-format details (those live in the codecs);
 * they are the high-level behavioral switches the session and topology layers
 * key off so they branch on a named capability instead of re-deriving intent
 * from a bare `_draftVersion === N` check. The flags describe the draft-18
 * topology inversion without implementing it here (topology I/O is in
 * `@moqt/webtransport`).
 */
export interface ProfileCapabilities {
  /**
   * SETUP is a single unified message shape negotiated over the (uni) control
   * channel, rather than the draft-14/16 CLIENT_SETUP/SERVER_SETUP exchange on a
   * bidi control stream. (draft-18)
   */
  readonly usesUnifiedSetup: boolean;
  /**
   * Each request rides its own bidirectional stream (responses correlate by
   * stream context) instead of being multiplexed on a shared control stream.
   * (draft-18)
   */
  readonly usesRequestStreams: boolean;
  /**
   * Response messages omit the Request ID on the wire (it is recovered from the
   * request stream). draft-14/16 responses carry it inline. (draft-18)
   */
  readonly responsesOmitRequestId: boolean;
  /**
   * Cancellation of a FETCH uses an explicit FETCH_CANCEL control message.
   * draft-18 replaces this with stream RESET_STREAM/STOP_SENDING semantics, so
   * the message is absent there.
   */
  readonly usesFetchCancelMessage: boolean;
  /**
   * Ending a namespace publication uses an explicit PUBLISH_NAMESPACE_DONE
   * control message. draft-18 conveys this via the request stream lifecycle, so
   * the message is absent there.
   */
  readonly usesPublishNamespaceDoneMessage: boolean;
}

/** The per-draft protocol behavior bundle. */
export interface ProtocolProfile {
  readonly version: DraftVersion;
  readonly control: ControlCodec;
  readonly data: DataCodec;
  readonly requestPolicy: RequestPolicy;
  readonly capabilities: ProfileCapabilities;
}

/** draft-14/16: bidi control stream, inline Request IDs, explicit cancel/done messages. */
const LEGACY_CAPABILITIES: ProfileCapabilities = {
  usesUnifiedSetup: false,
  usesRequestStreams: false,
  responsesOmitRequestId: false,
  usesFetchCancelMessage: true,
  usesPublishNamespaceDoneMessage: true,
};

/** draft-18: uni control pair, per-request bidi streams, stream-correlated responses. */
const D18_CAPABILITIES: ProfileCapabilities = {
  usesUnifiedSetup: true,
  usesRequestStreams: true,
  responsesOmitRequestId: true,
  usesFetchCancelMessage: false,
  usesPublishNamespaceDoneMessage: false,
};

/** Resolve the {@link ProfileCapabilities} for a draft version. */
function getCapabilities(version: DraftVersion): ProfileCapabilities {
  return version === 18 ? D18_CAPABILITIES : LEGACY_CAPABILITIES;
}

/**
 * Resolve the {@link ProtocolProfile} for a draft version.
 * @param version Draft version (default: 16). Drafts 14, 16, and 18 are wired.
 */
export function getProtocolProfile(version: DraftVersion = 16): ProtocolProfile {
  return {
    version,
    control: createControlCodec(version),
    data: createDataCodec(version),
    requestPolicy: getRequestPolicy(version),
    capabilities: getCapabilities(version),
  };
}
