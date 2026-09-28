/**
 * MoqtConnection at draft 21: the draft-18 stream model (unified SETUP on a uni
 * control pair, one bidi stream per request) with the draft-21 message changes.
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim } from './testkit/stream-sim.js';
import { createControlCodec } from '@moqt/transport';

const codec21 = createControlCodec(21);
const setupBytes = (): Uint8Array => codec21.encode({ type: 'SETUP', setupOptions: new Map() });

describe('MoqtConnection(21) negotiation', () => {
  it('connects with the unified SETUP on a uni control stream', async () => {
    const conn = new MoqtConnection(21);
    const transport = new TransportSim();
    transport.openIncomingUni().push(setupBytes());

    await conn.connect(transport);

    expect(conn.draftVersion).toBe(21);
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
  });

  it('a connection without an explicit draft adopts a negotiated moqt-21', async () => {
    const conn = new MoqtConnection();
    const transport = Object.assign(new TransportSim(), { protocol: 'moqt-21' });
    transport.openIncomingUni().push(setupBytes());

    await conn.connect(transport);

    expect(conn.draftVersion).toBe(21);
  });
});
