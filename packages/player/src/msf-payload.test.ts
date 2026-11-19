import { expect, it, vi } from 'vitest';
import * as loc from '@openmoq/loc';
import { gzipSync } from 'node:zlib';
import { encodePropertyBlock } from '@openmoq/transport';
import { MsfPayloadSource, prepareMsfPayload } from './msf-payload.js';
const enc = new TextEncoder();
const property = (value: bigint, draft = 23) => encodePropertyBlock([{ id: 0x78n, value }], draft === 14 ? 'd14-absolute-varint' : draft === 16 ? 'd16-delta-varint' : 'd18-delta-vi64');

it('bounds expanded GZIP and rejects invalid compressed bytes', async () => {
  await expect(prepareMsfPayload(gzipSync(new Uint8Array(8 * 1024 * 1024 + 1)), property(1n), new Map(), 23, true)).rejects.toThrow(/MSF_COMPRESSION 1.*8 MiB/);
  await expect(prepareMsfPayload(Uint8Array.of(1), property(1n), new Map(), 23, true)).rejects.toThrow(/MSF_COMPRESSION 1/);
});

it('waits for the matching FETCH response and lets track compression govern object compression', async () => {
  const source = new MsfPayloadSource(23), bytes = gzipSync(enc.encode('[]'));
  source.stream(10n, 42n); source.observe(bytes, 0n, 10n); source.closeStream(10n);
  let delivered = false;
  const result = Promise.resolve(source.read(bytes, property(99n), true, false)).then(value => { delivered = true; return value; });
  await Promise.resolve(); expect(delivered).toBe(false);
  source.accept(41n, new Map([[0x78n, [0n]]])); await Promise.resolve(); expect(delivered).toBe(false);
  source.accept(42n, new Map([[0x78n, [1n]]]));
  expect(await result).toEqual(enc.encode('[]'));
});

it.each([14, 16])('uses only object compression on MoQT draft %i', async draft => {
  const source = new MsfPayloadSource(draft), bytes = gzipSync(enc.encode('[]'));
  source.observe(bytes, 1n); source.accept(0n, new Map([[0x78n, [99n]]]), 1n);
  expect(await source.read(bytes, property(1n, draft), true, false)).toEqual(enc.encode('[]'));
});

it('honors MSF-01 and CMSF-01 compression without changing older declared formats', async () => {
  for (const version of ['1', 'draft-01', 'draft-02']) {
    const bytes = enc.encode(JSON.stringify({ version, tracks: [] }));
    expect(await prepareMsfPayload(gzipSync(bytes), property(1n), new Map(), 23, undefined, true)).toEqual(bytes);
  }
  for (const document of [{ version: 1, tracks: [] }, { version: 1, streamingFormat: 1, tracks: [] }]) {
    const bytes = enc.encode(JSON.stringify(document));
    expect(prepareMsfPayload(bytes, property(99n), new Map(), 23, undefined, true)).toBe(bytes);
  }
  expect(() => prepareMsfPayload(enc.encode('[]'), property(99n), new Map(), 23, true)).toThrow(/MSF_COMPRESSION 99/);
});

it('refuses the owning track once and does not reuse properties across a retired alias', async () => {
  const refused: [bigint, boolean][] = [];
  const source = new MsfPayloadSource(23, (id, subscription) => { refused.push([id, subscription]); });
  const bytes = enc.encode('[]'); source.observe(bytes, 5n);
  source.accept(7n, new Map([[0x78n, [9n]]]), 5n);
  expect(() => source.read(bytes, undefined, true, false)).toThrow(/MSF_COMPRESSION 9/);
  expect(() => source.read(bytes, undefined, true, false)).toThrow(/MSF_COMPRESSION 9/);
  expect(refused).toEqual([[7n, true]]);
  source.forget(7n, 5n);
  const next = enc.encode('[]'); source.observe(next, 5n);
  const pending = source.read(next, undefined, true, false);
  expect(pending).toBeInstanceOf(Promise);
  source.accept(8n, new Map(), 5n); expect(await pending).toEqual(next);
});

it('bounds the property response wait by the configured connection timeout', async () => {
  vi.useFakeTimers();
  try {
    const source = new MsfPayloadSource(23, undefined, 25), bytes = enc.encode('[]');
    source.observe(bytes, 1n);
    const outcome = Promise.resolve(source.read(bytes, undefined, true, false)).catch(error => error);
    let settled = false; void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(24); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
  } finally { vi.useRealTimers(); }
});

it('uses the shared LOC wire profile selector for compression properties', () => {
  const profile = vi.spyOn(loc, 'locWireProfileForDraft');
  try {
    expect(() => prepareMsfPayload(enc.encode('[]'), property(99n, 16), new Map(), 16, true)).toThrow(/MSF_COMPRESSION 99/);
    expect(profile).toHaveBeenCalledWith(16);
  } finally { profile.mockRestore(); }
});
