# Transport Draft Development

Supported transport drafts are 14, 16, 18, and 22. Draft 22 replaces the
experimental draft-21 implementation; the default remains draft 16. Future
drafts should develop on a separate branch until their integration is reviewed.

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
