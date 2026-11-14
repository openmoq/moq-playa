import { expect, it } from 'vitest';
import { connectedPair } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

// Draft 23 §11.2.1: PROPERTIES with Length 0 is MALFORMED_OBJECT.
for (const draft of [18, 22, 23] as const) for (const bytes of [
  [0x01, 0, 0, 0, 0x80, 0], // explicit priority
  [0x09, 0, 0, 0, 0], // DEFAULT_PRIORITY
]) it(`draft ${draft} rejects empty datagram properties (${bytes[0]}) with its specified code`, async () => {
  const pair = await connectedPair(draft);
  try {
    let code: number | undefined;
    pair.client.onClose = value => { code = value; };
    const writer = pair.b.datagrams.writable.getWriter();
    try { await writer.write(Uint8Array.from(bytes)); } finally { writer.releaseLock(); }
    await flush(128);
    expect(code).toBe(draft === 23 ? 0x201 : 3);
  } finally { await pair.client.close(); await pair.server.close(); }
});
