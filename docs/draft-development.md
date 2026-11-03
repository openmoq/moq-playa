# Transport Draft Development

Supported transport drafts are 14, 16, 18, 22 and 23. The default remains draft
16 (`DEFAULT_DRAFT_VERSION` in `@openmoq/transport`); drafts 22 and 23 are
opt-in. Draft 22 replaced the experimental draft-21 implementation. Future drafts should develop on a separate
branch until their integration is reviewed.

Drafts 22 and 23 share the draft-18 codec, session and adapter. Draft-23 rules
branch on `isDraft23`; checks written as `isDraft22` (draft 22 or later) cover
draft 23 too. A new draft must not rely on checks for one exact version.

## Keeping Draft Branches Aligned

- Land fixes for existing drafts on main first, then merge main into draft branches.
- Keep draft-only codecs, parameter definitions, and conformance tests separate.
- Share lifecycle machinery where the ownership model is the same. Gate changed
  wire rules by draft and test both sides of each boundary.
- Avoid broad renames, formatting changes, or duplicate session implementations.
- Merge main regularly, including its regression tests. Do not wait for a draft
  release to bring in player, browser, or catalog fixes.
- Keep draft-specific fixes separate from maintenance commits where practical.
  Updating the experimental draft does not authorize changes to older drafts.

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
