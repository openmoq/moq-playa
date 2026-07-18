# Joining FETCH — field interop findings

This documents the joining-FETCH transport/adapter, node-relay, and player
warm-start behavior implemented in this repo, and the results of field
verification against real deployments (2026-07-19).

## Findings

1. **node-relay (this repo) serves joining FETCH.** The toy relay answers
   relative joining FETCH from its latest-group cache: a late viewer with a
   Largest Object subscription receives the current group's head on the FETCH
   stream immediately, contiguous with live delivery and with zero duplicate
   objects (`relay-fetch-smoke`). This is the **repo's reference example
   behavior** for the feature (toy scope: latest-group cache only).

2. **The tested moqx deployment did not accept joining FETCH.** Against a
   live moqx relay (draft-16), a spec-valid relative joining FETCH
   referencing an established subscription was refused with
   `REQUEST_ERROR 0x10 "track not found"` for every track in this
   configuration.

3. **Playa degrades correctly on refusal.** The warm-start fetch failure path
   is non-fatal by design and was exercised live: warning logged, fetch
   bookkeeping cleaned up, playback continued live-only with zero dropped
   frames (first frame ~574 ms). A relay without joining-FETCH support costs
   nothing but the missed pre-roll.

4. **`night-loc` declares `isLive: false`.** The test stream's catalog marks
   every track non-live (with `trackDuration`, consistent MSF §5.1.15/§5.1.37
   VOD semantics), so Playa intentionally skips `warmStartCurrentGroup` and
   subscribes AbsoluteStart `{0,0}`. If that stream is meant to behave as a
   live channel, the publisher should set `isLive: true` (and drop
   `trackDuration`); this is a publisher/catalog issue, not a player one.

## Questions for moqx (Will)

1. Is joining FETCH (fetch types 0x2/0x3, draft-16 §9.16.2) on the roadmap?
   Playa now issues it for warm start when enabled; the refusal path is
   handled, but the feature only pays off with relay support.
2. The refusal is `0x10 "track not found"` — for an unsupported *fetch type*,
   `NOT_SUPPORTED` (or `INVALID_JOINING_REQUEST_ID` when the reference is the
   problem) would be more accurate than a track-existence error.
3. Standalone FETCH against the same relay: earlier testing showed catalog
   SUBSCRIBE never answered and FETCH behavior unverified — what is the
   intended FETCH support matrix?
4. Previously queued (separate): announce replay to late `SUBSCRIBE_NAMESPACE`
   interest never happens, and late-joining sessions' subscribes are refused
   until in-session retry; both still reproduce.

## Release notes (0.6.0 recommendation)

Joining FETCH belongs in the 0.6.0 notes as: public `joiningFetch()` API
(transport/adapter), node-relay FETCH serving, and opt-in
`warmStartCurrentGroup` (LOC, initial tune-in only) with graceful degradation
on relays that lack support. The moqx refusal and `isLive` gating are worth a
"known interop notes" bullet so users aren't surprised when warm start is a
no-op against today's public relays.
