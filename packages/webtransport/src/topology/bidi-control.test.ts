/**
 * BidiControlTopology — verifies the per-version codec bundle used by the
 * draft-14/16 single-bidi control-stream topology.
 */
import { describe, it, expect } from 'vitest';
import { createBidiControlTopology } from './bidi-control.js';

describe('createBidiControlTopology', () => {
  for (const version of [14, 16] as const) {
    it(`bundles matching control + data codecs for draft-${version}`, () => {
      const topo = createBidiControlTopology(version);
      expect(topo.version).toBe(version);
      expect(topo.control.version).toBe(version);
      expect(topo.data.version).toBe(version);
      expect(topo.framer).toBeDefined();
    });
  }

  it('defaults to draft-16', () => {
    expect(createBidiControlTopology().version).toBe(16);
  });

  it('the control codec frames a zero-length SERVER_SETUP (type + uint16 len)', () => {
    const topo = createBidiControlTopology(16);
    const frame = new Uint8Array([0x21, 0x00, 0x00]);
    expect(topo.control.peekFrameSize(frame)).toBe(3);
  });

  it('throws for draft-18 (uni-pair topology lands in Slice C)', () => {
    expect(() => createBidiControlTopology(18)).toThrow(/draft-18|not.*implement/i);
  });
});
