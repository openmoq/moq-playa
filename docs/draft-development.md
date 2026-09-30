# Transport Draft Development

Main supports transport drafts 14, 16, and 18. This branch adds experimental
draft-21 support without changing the default draft. Later drafts can develop
here without making main an experimental release channel.

## Keeping Main and This Branch Aligned

- Land fixes for existing drafts on main first, then merge main into this branch.
- Keep draft-only codecs, parameter definitions, and conformance tests separate.
- Share lifecycle machinery where the ownership model is the same. Gate changed
  wire rules by draft and test both sides of each boundary.
- Avoid broad renames, formatting changes, or duplicate session implementations.
- Merge main regularly, including its regression tests. Do not wait for a draft
  release to bring in player, browser, or catalog fixes.
- Keep draft-specific fixes separate from maintenance commits where practical.
  Updating the experimental draft does not authorize changes to older drafts.

The session and transport adapter still share stream ownership and cancellation
logic. Changes there need the old-draft suites as well as draft-21 loopback tests;
file separation alone does not prove compatibility.

## FETCH End-of-Range Framing

Draft 21 Figure 28 includes Object Payload Length, while section 11.4.1.2's
End-of-Range field omissions do not settle whether it is present. The same
ambiguity exists in draft 18. [Working-group issue 1861](https://github.com/moq-wg/moq-transport/issues/1861)
records the question but does not supply a technical resolution.

This branch uses the marker-only draft-21 form from the initial implementation,
without a payload-length field. That is an explicit interoperability choice, not
a claim that the ambiguity has been resolved. Drafts 14/16/18 retain their
existing zero-length field. Literal-byte tests cover both forms and a following
object, so one draft's change cannot silently shift another draft's parser.

Revisit the draft-21 choice when the text is clarified. Do not add a parser that
guesses between both forms: the optional zero would be ambiguous with subsequent
object bytes. Independent peer testing is still required before promoting the
experimental draft to main or a stable release.
