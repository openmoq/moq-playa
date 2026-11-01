// Content relay, injected by the DevTools owner into the ISOLATED world of
// the inspected TOP frame only, and only after the user granted this origin.
//
// It owns no diagnostics. For each DevTools owner that connects it creates a
// MessageChannel, transfers one end to the page with the owner's encoded
// `discover` (same-document postMessage, as the page bridge requires), and
// relays carrier packets between the extension Port and that MessagePort.
// Inner protocol strings are forwarded byte for byte; only the OUTER carrier
// shape, direction and size are validated here with the shared decoders, so
// hostile page input cannot reach the extension unchecked and a page command
// cannot be smuggled toward the owner.
import { decodeCarrierReply, decodeCarrierRequest, decodeMessage, encodeCarrierRequest } from '@openmoq/devtools-protocol';

(() => {
  if (globalThis.__playaRelayInstalled) return;
  globalThis.__playaRelayInstalled = true;

  chrome.runtime.onConnect.addListener(port => {
    // Only this extension, from an extension context (no sender.tab), on the expected channel.
    if (port.name !== 'playa-carrier' || port.sender?.id !== chrome.runtime.id || port.sender?.tab) {
      try { port.disconnect(); } catch { /* already gone */ }
      return;
    }
    let channel = null;
    let generation = 0;
    /** Source reply credit: one data reply per owner exchange (bootstrap, request or poll). */
    let credit = 0;

    const end = (sendClose) => {
      if (!channel) return;
      const c = channel; channel = null;
      if (sendClose) { try { c.port1.postMessage(encodeCarrierRequest({ kind: 'close' })); } catch { /* page gone */ } }
      try { c.port1.close(); } catch { /* already closed */ }
    };
    const refuse = (g, why) => { try { port.postMessage({ t: 'refused', g, why }); } catch { /* owner gone */ } };

    port.onMessage.addListener(m => {
      if (!m || typeof m !== 'object' || typeof m.g !== 'number') return;
      if (m.t === 'bootstrap') {
        if (window !== window.top) { refuse(m.g, 'not-top-frame'); return; }
        if (typeof m.origin !== 'string' || location.origin !== m.origin) { refuse(m.g, 'origin-mismatch'); return; }
        const d = typeof m.discover === 'string' ? decodeMessage(m.discover) : null;
        if (!d || !d.ok || d.message.kind !== 'discover') { refuse(m.g, 'invalid-discover'); return; }
        end(true);                                   // an older channel is closed, never reused
        generation = m.g;
        const c = new MessageChannel(); channel = c;
        credit = 1;
        c.port1.onmessage = e => {
          if (channel !== c) return;
          const r = decodeCarrierReply(e.data);
          if (!r.ok) { refuse(generation, `invalid-reply:${r.error.code}`); end(true); return; }
          if (r.packet.kind === 'reply') {
            // Only one data reply may be outstanding per exchange; excess is a page fault, never forwarded.
            if (credit === 0) { refuse(generation, 'excess-reply'); end(true); return; }
            credit = 0;
          }
          try { port.postMessage({ t: 'packet', g: generation, data: e.data }); } catch { end(true); return; }
          if (r.packet.kind === 'closed') { end(false); try { port.postMessage({ t: 'ended', g: generation }); } catch { /* owner gone */ } }
        };
        c.port1.onmessageerror = () => { refuse(generation, 'messageerror'); end(true); };
        c.port1.start();
        window.postMessage(m.discover, location.origin, [c.port2]);
        return;
      }
      if (m.t === 'packet') {
        if (!channel || m.g !== generation) return;
        const r = decodeCarrierRequest(m.data);
        if (!r.ok) return;                           // never forward an invalid owner packet either
        if (r.packet.kind !== 'close') credit = 1;   // each owner exchange grants exactly one data reply
        channel.port1.postMessage(m.data);
        if (r.packet.kind === 'close') end(false);
      }
    });
    port.onDisconnect.addListener(() => end(true));   // explicit close packet before the MessagePort goes
    try { port.postMessage({ t: 'relay-ready' }); } catch { /* owner gone */ }
  });
})();
