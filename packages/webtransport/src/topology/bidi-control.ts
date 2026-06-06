/**
 * BidiControlTopology — the stream topology used by draft-14 and draft-16.
 *
 * In these drafts a single client-initiated bidirectional stream carries the
 * SETUP handshake and (almost) all control messages, and requests are correlated
 * by the Request ID on the wire. This module owns the *per-version construction*
 * of the wire codecs and the control-stream framer for that topology.
 *
 * It is deliberately thin. Draft-18 inverts the topology (a unidirectional
 * control-stream pair plus one bidirectional stream per request); that
 * `UniPairTopology` — and the generic dispatch/run/cancel surface that lets the
 * adapter treat the two uniformly — lands in Slice C, where the draft-18 wire
 * format forces its exact shape. Building that framework now would be premature.
 *
 * @see draft-ietf-moq-transport-16 §3.3
 * @module
 */

import {
  createControlCodec,
  createDataCodec,
  type ControlCodec,
  type DataCodec,
  type DraftVersion,
} from '@moqt/transport';
import { ControlStreamFramer } from '../framer.js';

/** The per-version codec bundle for a single-bidi-control-stream topology. */
export interface BidiControlTopology {
  readonly version: DraftVersion;
  /** Control-message wire codec for this draft. */
  readonly control: ControlCodec;
  /** Data-plane decoder bound to this draft. */
  readonly data: DataCodec;
  /** Control-stream framer driving the control codec. */
  readonly framer: ControlStreamFramer;
}

/**
 * Build the {@link BidiControlTopology} bundle for a draft version.
 * @param version Draft version (default: 16). Throws for drafts without a wired
 *   bidi-control codec (e.g. draft-18, which uses the uni-pair topology).
 */
export function createBidiControlTopology(version: DraftVersion = 16): BidiControlTopology {
  // draft-18 inverts the topology (uni control-stream pair + per-request bidi
  // streams) and its responses omit the Request ID. It MUST NOT enter the
  // single-bidi-control path, which casts DecodedControlMessage to a fully
  // correlated ControlMessage — that is only sound for draft-14/16. Reject it
  // explicitly here (do not rely on the data codec throwing) until the draft-18
  // uni-pair topology lands in Slice C.
  if (version === 18) {
    throw new Error('createBidiControlTopology: draft-18 uses the uni-pair topology, not single-bidi control');
  }
  const control = createControlCodec(version);
  return {
    version,
    control,
    data: createDataCodec(version),
    framer: new ControlStreamFramer(control),
  };
}
