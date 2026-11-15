# Transport Draft Development

Supported transport drafts are 14, 16, 18, 22 and 23. The default remains draft 16
(`DEFAULT_DRAFT_VERSION` in `@openmoq/transport`). Draft 22 is opt-in. Draft 23 is
opt-in, not tested against an independent draft-23 peer.

Drafts 22 and 23 share the draft-18 codec, session and adapter. Draft-23 rules
branch on `isDraft23`; checks written as `isDraft22` (draft 22 or later) cover
draft 23 too. A new draft must not rely on checks for one exact version.

The session and transport adapter still share stream ownership and cancellation
logic. Changes there need the old-draft suites as well as draft-22 loopback tests;
file separation alone does not prove compatibility.

## FETCH End-of-Range Framing

Draft 22 Figure 28 includes Object Payload Length, while section 11.4.1.2's
End-of-Range field omissions do not settle whether it is present. The same
ambiguity exists in draft 18. [Working-group issue 1861](https://github.com/moq-wg/moq-transport/issues/1861)
records the question but does not supply a technical resolution.

Draft 22 uses the marker-only form from the initial draft-21 implementation,
without a payload-length field. That is an explicit interoperability choice, not
a claim that the ambiguity has been resolved. Drafts 14/16/18 retain their
existing zero-length field. Literal-byte tests cover both forms and a following
object, so one draft's change cannot silently shift another draft's parser.

Revisit the draft-22 choice when the text is clarified. Do not add a parser that
guesses between both forms: the optional zero would be ambiguous with subsequent
object bytes. Independent peer testing must cover this framing before a release;
same-implementation loopbacks cannot resolve a disagreement between drafts or peers.

Draft 23 changes the End-of-Range IDs (absolute only as the first entry, then
delta-coded, section 11.4.2.1) but leaves the same Payload Length question open:
section 11.4.2 lists only Subgroup ID, Priority and Properties as absent, while
Figure 29 does not mark Object Payload Length optional. Draft 23 keeps draft
22's marker-only form, as the same interoperability choice.

Draft 23 is also silent on End of Group (0x80) or End of Track (0x81) as the
first entry after a FETCH_HEADER. Both are defined by "the prior Object", so this
implementation closes with MALFORMED_OBJECT, as for any other reference to a
missing prior Object. Revisit if the text settles it.

## Draft-23 Interoperability

The draft-23 wire vectors (`packages/transport/vectors/d23`) come from this
implementation alone: re-encoded draft-22 vectors plus vectors built from the
draft text. They pin the encoding but are not interoperability evidence. Before
a release that depends on draft 23, test against an independent draft-23 peer
and record the result here.

## Draft-23 Limitations

The following are not implemented on draft 23:

- Fills on PUBLISH and SUBSCRIBE_TRACKS. Incoming PUBLISH fill streams are
  discarded with STOP_SENDING / CANCELLED (0x1), before or after PUBLISH_OK;
  the live PUBLISH proceeds without its fill (§3.4.1). Inbound SUBSCRIBE_TRACKS
  carrying FILL_PARAMETERS is refused with REQUEST_ERROR NOT_SUPPORTED (0x3),
  per §§1.6 and 12.3. The public SUBSCRIBE_TRACKS API has authorization-only
  options, with no fill or arbitrary-parameters input. Custom transports must supply the
  existing `createStreamError` hook to encode the cancellation code.
- Timed gaps for FILL_TIMEOUT (§9.19.5). The example relay refuses requests
  requiring it to wait for unavailable Objects; cached requested ranges can
  still be served.
- UNSUPPORTED_PROPERTY details on our own refusals (§9.4.2.2, a SHOULD).
- Relay upstream eligibility checks for LARGEST_OBJECT (§7.5).
- Mandatory-property propagation in the relay (§3.7).
- The persistent existence-contradiction cache (§12.1, item 10).
- PUBLISH_SKIPPED (§9.18).
- Seek, the history-live bridge, quality and DevTools on draft 23.

A received SUBSCRIBE_TRACKS_ID is retained as a PUBLISH parameter but is not
used to look up the originating request. Sections 3.6 and 9.19.21 specify its
origin and value; neither attaches a receiver-side MUST to such a lookup.
Duplicate PUBLISH_NAMESPACE announcements are tracked independently: withdrawing
one leaves the namespace published until the last is withdrawn (§4.1).
