# Local diagnostic carrier

This envelope carries the diagnostic protocol across a page MessagePort and an
extension runtime Port. It adds bounded reader credit, not MOQT wire messages,
network authority, clock synchronization or playback control. Source observations
and their cursors are unchanged. Both hops carry JSON strings.

Use `encodeCarrierRequest` / `decodeCarrierRequest` toward the source and
`encodeCarrierReply` / `decodeCarrierReply` toward the reader. The helpers add
and validate `channel: openmoq-devtools-carrier` and integer `version: 1`.
Decoded packets contain only declared fields. Version mismatch refuses the
connection; carrier compatibility is separate from diagnostic major/minor.

| Reader packet | Meaning |
| --- | --- |
| `{kind: 'request', receipt, message}` | One encoded diagnostic command |
| `{kind: 'poll', receipt}` | Drain at most one pending delivery frame |
| `{kind: 'close'}` | Release this port's connection, even if a reply is unread |

| Source packet | Meaning |
| --- | --- |
| `{kind: 'reply', receipt, frames}` | Zero to two encoded protocol frames, consumed in order |
| `{kind: 'closed', reason, connectionReason}` | Terminal carrier outcome; no later packet |

One receipt covers the entire exchange, including both frames of a source
refresh (pending batch then snapshot) or withdrawal plus command reply. Empty
polls return a new receipt too. A reader processes all frames before returning
the receipt in its next request/poll. It never pipelines requests. Replayed or
wrong receipts terminate this connection before another registry operation.
`close` needs no receipt because it only relinquishes the bound port's authority.

A receipt is opaque: a uint64 serial plus 128 freshly random bits, separated
by a dot. Readers echo it, never generate or increment it. The serial prevents
reuse even if entropy repeats; fresh randomness prevents predicting credit for
unread replies. A receipt is not authentication or a credential. Source/run and
attachment identities, command correlations, and the actual port binding still
apply. Same-origin scripts are not isolated from the application's diagnostics.

`MAX_CARRIER_BYTES` is 4 × `MAX_MESSAGE_BYTES` + 2048 UTF-8 bytes, allowing JSON
escaping of two full protocol frames. Each inner string separately obeys
`MAX_MESSAGE_BYTES`. The content relay validates outer direction, shape and
byte limits before forwarding, without decoding/reordering inner frames. The
DevTools owner decodes each protocol frame and checks correlations and cursors.
Unknown outer fields are discarded; invalid input is never echoed in errors.

Only one data reply may be outstanding. Idle expiry, pagehide or explicit
closure may add one small terminal packet after it. No observer can push extra
data while credit is held. The reader must bound its own pending commands and
continue consuming/crediting while the panel is paused or hidden. It must also
have its own timeout for a silent page; a failed carrier must not look healthy.

`closed` reasons are owner-closed, idle-timeout, page-hidden, bridge-disposed,
invalid-packet, invalid-receipt, clock-error, internal-error,
reentrant-exchange, bridge-unavailable, and registry-closed. A registry refusing
admission (for example a duplicate active owner or a limit) returns
bridge-unavailable without touching the existing owner. `connectionReason` is null except for
registry-closed, which includes the registry's precise local reason. These are
not a MoQ connection close and do not synthesize `source_state`. An attachment
withdrawal is an inner protocol error, while a capture ending is an inner fact.
Port disconnect without a terminal packet is carrier loss with unknown reason.

## Bootstrap and host binding

The application explicitly installs one page endpoint around its registry.
The content script creates a MessageChannel and transfers one end with the
initial encoded diagnostic `discover` in a same-document `window.postMessage`.
The page checks source window, origin and exactly one transferred port. It
answers only on that port, with a carrier reply containing `hello` and its first
receipt. No port, descriptors or snapshots are broadcast on window.

Subsequent packets travel over that port. The extension DevTools document
initiates `tabs.connect(inspectedTabId, {frameId: 0, name: ...})` to the injected
top-frame relay; the relay checks the extension sender identity and channel.
The selected tab/frame and actual port are authority, never a supplied ownerId.
Injection requires explicit user action and optional permission for that origin.
A constant DevTools expression may read the top document's location.origin for
the permission UI, with no application access or interpolated code. Treat that
result as untrusted text and verify the actual tab URL after permission, before
injection. Pin the top document and expected origin so navigation cannot redirect
an attachment. No page-world injection, broad installed content script, or Probe
control belongs on this path. Navigation/reopen establishes a fresh owner/channel.

API availability in DevTools documents must be checked at runtime. Missing APIs
produce an explicit unsupported state; permission is not broadened as a fallback.
Source-list refresh is another discover inside a credited request. After expiry
or closure, a fresh MessageChannel may reuse the living DevTools document's
ownerId, with a fresh attachment/cursor. Discard all replies from the old channel.
Late background timers can cause legitimate idle expiry; it is not itself a
diagnosis of an owner implementation bug.

`DiagnosticCarrier` in `@openmoq/devtools` is the pure source-side state machine.
The endpoint calls `start(discover)` once, forwards each returned string once,
then uses `receive`, `expire`, `close` and `deadlineMs`. Its timer must run even
without more reader messages. Idle timeout defaults to 15 s (configurable from
1 to 600000 integer ms). Late credit cannot renew an already expired lease.
Timers may run late in background pages; expiry is also checked on receipt.
pagehide/uninstall and port failure release the lease; a content-script
disconnect explicitly sends `close` before closing its MessagePort, rather than
depending on a browser-specific close event. Cleanup is idempotent and no
transport/player is stopped. Uninstalled endpoints do not announce themselves.
