import { describe, expect, it } from 'vitest';
import { inspectOpusHead, inspectOpusPacket } from './opus-source-packet.js';

function head({ channels = 1, preSkip = 312, rate = 48000, gain = 0, version = 1, mapping = 0 } = {}): Uint8Array {
  const bytes = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  bytes[8] = version; bytes[9] = channels; bytes[18] = mapping;
  const view = new DataView(bytes.buffer);
  view.setUint16(10, preSkip, true); view.setUint32(12, rate, true); view.setInt16(16, gain, true);
  return bytes;
}
function packet(prefix: number[], payloadBytes: number, paddingBytes = 0): Uint8Array {
  const bytes = new Uint8Array(prefix.length + payloadBytes + paddingBytes);
  bytes.set(prefix); bytes.fill(0xaa, prefix.length, prefix.length + payloadBytes);
  bytes.fill(0xff, prefix.length + payloadBytes);
  return bytes;
}
const samples = (value: number) => ({ codedSamples48k: value });

describe('OpusHead structural proof profile (not decoder capability)', () => {
  it('recognizes the captured mono OpusHead312 without changing any byte', () => {
    const bytes = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 56, 1, 128, 187, 0, 0, 0, 0, 0);
    const before = bytes.slice();
    expect(inspectOpusHead(bytes)).toEqual({ channels: 1, preSkip48k: 312, codedSampleRate: 48000 });
    expect(bytes).toEqual(before);
  });
  it('supports mono/stereo and the full unsigned pre-skip range, not just one packet', () => {
    expect(inspectOpusHead(head({ channels: 2, preSkip: 0 }))).toEqual({ channels: 2, preSkip48k: 0, codedSampleRate: 48000 });
    expect(inspectOpusHead(head({ preSkip: 65535 }))).toEqual({ channels: 1, preSkip48k: 65535, codedSampleRate: 48000 });
  });
  it('never promotes advisory input sample rate into native output rate', () => {
    for (const rate of [0, 8000, 44100, 48000, 0xffffffff]) {
      expect(inspectOpusHead(head({ rate }))).toEqual({ channels: 1, preSkip48k: 312, codedSampleRate: 48000 });
    }
  });
  it('allows output gain without pretending it changes coded duration', () => {
    expect(inspectOpusHead(head({ gain: -32768 }))?.preSkip48k).toBe(312);
    expect(inspectOpusHead(head({ gain: 32767 }))?.preSkip48k).toBe(312);
  });
  it('declines other versions, mapping families and channel counts as unsupported proof', () => {
    for (const version of [0, 2, 15, 16, 255]) expect(inspectOpusHead(head({ version }))).toBeNull();
    for (const mapping of [1, 255]) expect(inspectOpusHead(head({ mapping }))).toBeNull();
    for (const channels of [0, 3, 255]) expect(inspectOpusHead(head({ channels }))).toBeNull();
  });
  it('does not default empty description, accept truncation or permit an extra family0 table', () => {
    const bytes = head();
    for (const length of [0, 8, 18]) expect(inspectOpusHead(bytes.subarray(0, length))).toBeNull();
    const extra = new Uint8Array(20); extra.set(bytes);
    expect(inspectOpusHead(extra)).toBeNull();
    bytes[0] = 0; expect(inspectOpusHead(bytes)).toBeNull();
  });
  it('reads only the supplied view and returns an immutable independent scalar snapshot', () => {
    const backing = new Uint8Array(24); backing.set(head(), 3);
    const view = backing.subarray(3, 22), result = inspectOpusHead(view);
    expect(result).toEqual({ channels: 1, preSkip48k: 312, codedSampleRate: 48000 });
    expect(Object.isFrozen(result)).toBe(true);
    view.fill(0); expect(result?.preSkip48k).toBe(312);
    expect(Object.keys(result ?? {})).toEqual(['channels', 'preSkip48k', 'codedSampleRate']);
  });
});

describe('ordinary single-stream Opus packet framing', () => {
  it('counts all32 configuration durations from RFC6716 Table2, per channel', () => {
    const expected = [480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
      480, 960, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960];
    expected.forEach((count, config) => {
      expect(inspectOpusPacket(Uint8Array.of(config * 8, 0xaa))).toEqual(samples(count));
      expect(inspectOpusPacket(Uint8Array.of(config * 8 + 4, 0xaa))).toEqual(samples(count));
    });
  });
  it.each([
    { name: 'code0 one20ms frame / RFC Figure8', bytes: [0x08, 0xaa], count: 960 },
    { name: 'code1 two5ms CBR frames / Figure9', bytes: [0xe9, 0x11, 0x22], count: 480 },
    { name: 'code2 VBR two2.5ms frames', bytes: [0x82, 1, 0x11, 0x22, 0x33], count: 240 },
    { name: 'code3 VBR two20ms frames / Figure10', bytes: [0x7b, 0x82, 1, 0x11, 0x22, 0x33], count: 1920 },
    { name: 'code3 CBR four20ms stereo frames / Figure11', bytes: [0xff, 4, 1, 2, 3, 4], count: 3840 },
    { name: 'valid silence packet used by adapter replay, not captured native payload', bytes: [0xf8, 0xff, 0xfe], count: 960 },
  ])('$name', ({ bytes, count }) => {
    expect(inspectOpusPacket(Uint8Array.from(bytes))).toEqual(samples(count));
  });
  it('enforces code0 and code1 implicit frame bounds and CBR divisibility', () => {
    expect(inspectOpusPacket(packet([0x80], 1275))).toEqual(samples(120));
    expect(inspectOpusPacket(packet([0x80], 1276))).toBeNull();
    expect(inspectOpusPacket(packet([0x81], 2550))).toEqual(samples(240));
    expect(inspectOpusPacket(packet([0x81], 2551))).toBeNull();
    expect(inspectOpusPacket(packet([0x81], 2552))).toBeNull();
  });
  it.each([
    { length: 251, word: [251] }, { length: 252, word: [252, 0] },
    { length: 255, word: [255, 0] }, { length: 256, word: [252, 1] }, { length: 1275, word: [255, 255] },
  ])('reads VBR frame length$length with its actual one/two-byte word', ({ length, word }) => {
    expect(inspectOpusPacket(packet([0x82, ...word], length + 1))).toEqual(samples(240));
  });
  it('bounds the second implicit VBR frame separately', () => {
    expect(inspectOpusPacket(packet([0x82, 1], 1276))).toEqual(samples(240));
    expect(inspectOpusPacket(packet([0x82, 1], 1277))).toBeNull();
  });
  it('parses every VBR length before payload and checks the last implicit frame', () => {
    expect(inspectOpusPacket(packet([0x83, 0x83, 1, 2], 6))).toEqual(samples(360));
    expect(inspectOpusPacket(packet([0x83, 0x83, 1, 2], 3))).toBeNull();
    expect(inspectOpusPacket(packet([0x83, 0x82, 1], 1277))).toBeNull();
    expect(inspectOpusPacket(packet([0x83, 0x82, 255, 255], 1276))).toEqual(samples(240));
  });
  it('supports code3 count1 with either VBR or CBR', () => {
    expect(inspectOpusPacket(Uint8Array.of(0x83, 1, 0xaa))).toEqual(samples(120));
    expect(inspectOpusPacket(Uint8Array.of(0x83, 0x81, 0xaa))).toEqual(samples(120));
  });
  it('permits exactly120ms including48short frames and two60ms frames, never more', () => {
    expect(inspectOpusPacket(packet([0x83, 48], 48))).toEqual(samples(5760));
    expect(inspectOpusPacket(packet([0x83, 49], 49))).toBeNull();
    expect(inspectOpusPacket(packet([0x1b, 2], 2))).toEqual(samples(5760));
    expect(inspectOpusPacket(packet([0x1b, 3], 3))).toBeNull();
    expect(inspectOpusPacket(packet([0x83, 0xb0, ...Array<number>(47).fill(1)], 48))).toEqual(samples(5760));
  });
  it('accepts arbitrary padding bytes and subtracts255 continuation as254', () => {
    expect(inspectOpusPacket(packet([0x83, 0x41, 1], 1, 1))).toEqual(samples(120));
    expect(inspectOpusPacket(packet([0x83, 0x41, 0], 1))).toEqual(samples(120));
    expect(inspectOpusPacket(packet([0x83, 0x41, 254], 1, 254))).toEqual(samples(120));
    expect(inspectOpusPacket(packet([0x83, 0x41, 255, 0], 1, 254))).toEqual(samples(120));
    expect(inspectOpusPacket(packet([0x83, 0x41, 255, 255, 1], 1, 509))).toEqual(samples(120));
  });
  it('separates padding from VBR length words and both frame payloads', () => {
    expect(inspectOpusPacket(packet([0x83, 0xc2, 1, 1], 2, 1))).toEqual(samples(240));
    expect(inspectOpusPacket(packet([0x83, 0xc2, 1, 2], 2, 1))).toBeNull();
    expect(inspectOpusPacket(Uint8Array.of(0x83, 0xc2, 1, 252, 0))).toBeNull();
  });
  it.each([
    { name: 'empty packet', bytes: [] }, { name: 'code1 odd payload', bytes: [0x81, 1] },
    { name: 'code2 missing size', bytes: [0x82] }, { name: 'code2 missing extended size', bytes: [0x82, 252] },
    { name: 'code2 size past data', bytes: [0x82, 3, 1, 2] }, { name: 'code3 missing control', bytes: [0x83] },
    { name: 'code3 count0 CBR', bytes: [0x83, 0, 1] }, { name: 'code3 count0 VBR', bytes: [0x83, 128, 1] },
    { name: 'code3 missing padding size', bytes: [0x83, 0x41] },
    { name: 'code3 padding overflow', bytes: [0x83, 0x41, 2, 1] },
    { name: 'code3 unterminated padding chain', bytes: [0x83, 0x41, 255] },
    { name: 'code3 CBR indivisible payload', bytes: [0x83, 2, 1, 2, 3] },
    { name: 'code3 missing VBR word', bytes: [0x83, 0x82] },
    { name: 'code3 truncated VBR extended word', bytes: [0x83, 0x82, 252] },
    { name: 'code3 VBR sum exceeds remaining payload', bytes: [0x83, 0x83, 2, 2, 1, 2, 3] },
  ])('declines malformed framing: $name', ({ bytes }) => {
    expect(inspectOpusPacket(Uint8Array.from(bytes))).toBeNull();
  });
  it('bounds code3 CBR frame size independently of valid duration', () => {
    expect(inspectOpusPacket(packet([0x83, 2], 2550))).toEqual(samples(240));
    expect(inspectOpusPacket(packet([0x83, 2], 2552))).toBeNull();
  });
  it.each([
    [0x80], [0x81], [0x82, 0], [0x82, 0, 1], [0x82, 1, 1],
    [0x83, 1], [0x83, 2], [0x83, 0x82, 0, 1], [0x83, 0x82, 1, 1], [0x83, 0x41, 1, 0],
  ])('excludes RFC-valid zero-length DTX/loss frames from proof: %j', (...bytes) => {
    expect(inspectOpusPacket(Uint8Array.from(bytes))).toBeNull();
  });
  it('returns frozen scalar duration without mutation, alias retention or backing-view leakage', () => {
    const backing = Uint8Array.of(9, 0xf8, 0xff, 0xfe, 8), view = backing.subarray(1, 4), before = backing.slice();
    const result = inspectOpusPacket(view);
    expect(result).toEqual(samples(960)); expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result ?? {})).toEqual(['codedSamples48k']); expect(backing).toEqual(before);
    view.fill(0); expect(result).toEqual(samples(960));
  });
});
