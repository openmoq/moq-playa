# Encoder validation policy

All encoders in `@moqt/transport` validate their inputs against the
wire-format spec at encode time. Invalid inputs throw `ProtocolViolationError`
(or a plain `Error` where the codec pre-dates the unified error type) at
the call site. Encoders MUST NOT silently truncate, default, or drop
fields.

Where a wire format uses a flag/field pair (e.g. the EXTENSIONS flag on
an OBJECT_DATAGRAM type byte gating the extensions field), validation is
**symmetric**: both `flag-set-without-field` AND `flag-clear-with-field`
throw. A clear flag combined with a present field means the caller's
data would be silently dropped on the wire — this is worse than
rejecting it, because the receiver has no signal that the field was
ever set.

This policy was established in April 2026 after a disciplined
property-testing pass across the transport package surfaced seven
encoder defects in three categories:

- **Silent truncation** of oversized values (e.g. `SUBSCRIBER_PRIORITY`
  declared 8-bit on the wire, silently masked from a wider Varint
  input).
- **Self-incompatible codecs** — encoder emits a type code the decoder
  has no arm for (`PUBLISH_OK` in draft-14), or produces bytes the
  same library's decoder rejects (empty Track Namespace tuple fields,
  §2.4.1).
- **Silent field drops** — flag/field asymmetric validation in the
  data-plane encoders (SubgroupObject status on non-empty payload,
  ObjectDatagram STATUS/EXTENSIONS/DEFAULT_PRIORITY, FetchObject
  PRIORITY/EXTENSIONS).

All seven are now fixed with loud throws at the encode boundary and
regression tests that pin the throwing behavior. New encoders added to
this package should follow the same pattern: validate on encode,
symmetric flag/field checks, no silent behavior.
