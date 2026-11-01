import { describe, expect, it } from 'vitest';
import { decodeMessage, MAX_MESSAGE_BYTES } from '@openmoq/devtools-protocol';
import { fixtureTarget } from '@openmoq/devtools-protocol/fixtures';
import { TraceExport } from './trace-export.js';

const options = { target: fixtureTarget, requestId: 'export-request', exportId: 'export-1' };
function drain(text: string) {
  const stream = new TraceExport({ ...options, text });
  const chunks = [];
  for (let i = 0; i < 1024; i++) {
    const frame = stream.next();
    if (frame === null) return chunks;
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const decoded = decodeMessage(frame);
    if (!decoded.ok || decoded.message.kind !== 'export.chunk') throw new Error('Expected export chunk');
    chunks.push(decoded.message);
  }
  throw new Error('Export did not terminate');
}

describe('bounded trace export', () => {
  it('returns a correlated final chunk even for an empty trace', () => {
    expect(drain('')).toEqual([expect.objectContaining({ ...options, index: 0, final: true, data: '' })]);
  });

  it('preserves Unicode and qlog record separators across bounded pages', () => {
    const text = '\u001e{"message":"😀é漢字\\\""}\n'.repeat(4000);
    const chunks = drain(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => c.data).join('')).toBe(text);
    chunks.forEach((c, index) => {
      expect(c).toMatchObject({ target: fixtureTarget, requestId: options.requestId, exportId: options.exportId, index });
      expect(c.final).toBe(index === chunks.length - 1);
      expect(new TextEncoder().encode(c.data).byteLength).toBeLessThanOrEqual(16384);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(c.data))).toBe(c.data);
    });
  });

  it('bounds the fully escaped frame too', () => {
    const text = '\u0000"\\'.repeat(10000);
    expect(drain(text).map(c => c.data).join('')).toBe(text);
  });

  it('refuses exports over the UTF-8 byte budget before yielding anything', () => {
    expect(() => new TraceExport({ ...options, text: 'ééé', maxBytes: 5 })).toThrow(/limit/i);
    const accepted = new TraceExport({ ...options, text: 'éé', maxBytes: 4 });
    expect(accepted.next()).not.toBeNull();
  });

  it.each(['\ud800', '\udfff', 'prefix\ud800suffix'])('refuses ill-formed UTF-16 rather than corrupting export bytes', text => {
    expect(() => new TraceExport({ ...options, text })).toThrow(/Unicode/i);
  });

  it('releases an interrupted export without another chunk', () => {
    const stream = new TraceExport({ ...options, text: 'x'.repeat(50000) });
    expect(stream.next()).not.toBeNull();
    stream.close(); stream.close();
    expect(stream.next()).toBeNull();
  });
});
