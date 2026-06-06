/**
 * RequestEndpoint — the correlation context the I/O layer supplies for a
 * control message that arrived on a request stream.
 *
 * In draft-14/16 every control message carries the Request ID it pertains to on
 * the wire, so this context is unnecessary. In draft-18, responses omit the
 * Request ID (the request's bidirectional stream IS the correlation) and
 * REQUEST_UPDATE omits its "Existing Request ID" (the stream identifies the
 * target). The topology layer recovers those values from stream context and
 * hands them to the session as a RequestEndpoint, so the session's
 * Request-ID-keyed state stays draft-neutral.
 *
 * @see draft-ietf-moq-transport-18 §3.3 (request streams)
 * @module
 */

/** Stream-derived correlation for a control message processed by the session. */
export interface RequestEndpoint {
  /**
   * The Request ID this message correlates to. For a draft-18 response recovered
   * from the request stream; for a draft-18 REQUEST_UPDATE this is the update's
   * own (new) Request ID. Never a placeholder — only set when genuinely known.
   */
  readonly requestId: bigint;

  /**
   * For a REQUEST_UPDATE on a draft-18 request stream: the original request the
   * update targets (the removed "Existing Request ID"), recovered from stream
   * context. Undefined for draft-14/16, where it is carried on the wire.
   */
  readonly existingRequestId?: bigint;
}
