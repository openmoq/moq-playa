import { describe, expect, it } from 'vitest';
import { activePcmSpan, assessAudioOrder } from './mse-audio-order.assessment.mjs';

function row(kind: string, span = 10240) {
  const nativeOrder = kind === 'omitted-tail' ? [0, 1, 2, 3, 4, 5, 6, 7, 9, 10] : Array.from({ length: 11 }, (_, i) => i);
  return { kind, failures: [], assertions: [{ name: 'native byte identity', passed: true }],
    rate: 8000, playbackRate: 1, ended: true, currentTime: 1.408, duration: 1.408,
    samples: 16384, pcmBytes: 65536, quanta: Array.from({ length: 128 }, (_, i) => ({ frame: i * 128, length: 128 })),
    endedAtFrame: 12288, lastEndFrame: 16384, drainSamples: 4096,
    active: { first: 1025, last: 1025 + span, span }, nativeOrder, elementEvents: [{ type: 'ended' }],
    tokens: kind === 'candidate' ? nativeOrder.map(index => ({ index, terminals: [{ state: 'appended', reason: null }] })) : [] };
}
const healthy = () => [row('in-order'), row('in-order-repeat'), row('candidate'), row('omitted-tail', 9216)];

describe('native audio PCM gate assessment', () => {
  it('uses actual finite f32le samples, including surrounding silence', () => {
    const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
    view.setFloat32(2 * 4, 0.01, true); view.setFloat32(6 * 4, -0.01, true);
    expect(activePcmSpan(bytes)).toEqual({ first: 2, last: 6, span: 4 });
    view.setFloat32(4 * 4, NaN, true);
    expect(() => activePcmSpan(bytes)).toThrow('non-finite');
  });
  it('accepts healthy repeat and candidate only with a discriminating omission control', () => {
    expect(assessAudioOrder(healthy()).passed).toBe(true);
    const rows = healthy(); rows[3] = row('omitted-tail');
    expect(assessAudioOrder(rows).failures).toContain('mandatory omission control distinguishes a 1024-sample deficit');
    expect(assessAudioOrder(rows.slice(0, 3)).passed).toBe(false);
  });
  it('rejects a one-packet candidate loss while healthy controls still pass', () => {
    const rows = healthy(); rows[2] = row('candidate', 9216);
    expect(assessAudioOrder(rows).failures).toContain('candidate span matches healthy within 16 samples');
  });
  it('enforces the 16-sample limit without widening it to a packet', () => {
    const rows = healthy(); rows[2] = row('candidate', 10224);
    expect(assessAudioOrder(rows).passed).toBe(true);
    rows[2] = row('candidate', 10223);
    expect(assessAudioOrder(rows).passed).toBe(false);
  });
  it('rejects missing worklet quanta and insufficient clock drain even with matching spans', () => {
    const rows = healthy(); rows[2]!.quanta[64]!.frame += 128;
    expect(assessAudioOrder(rows).failures).toContain('candidate: contiguous quanta');
    const short = healthy(); short[2]!.endedAtFrame++;
    expect(assessAudioOrder(short).failures).toContain('candidate: measured post-ended clock drain');
  });
  it('rejects overtaken native bytes and duplicate terminal outcomes', () => {
    const rows = healthy(); [rows[2]!.nativeOrder[8], rows[2]!.nativeOrder[9]] = [9, 8];
    expect(assessAudioOrder(rows).failures).toContain('candidate: exact native byte order');
    const duplicate = healthy(); duplicate[2]!.tokens[0]!.terminals.push({ state: 'appended', reason: null });
    expect(assessAudioOrder(duplicate).failures).toContain('candidate: exactly-once token outcomes');
  });
});
