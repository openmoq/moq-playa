import assert from 'node:assert/strict';
import { codecDescriptionFromInit } from '../../packages/locmaf/src/index.js';

export function fixtureVideoConfig(alternatives: boolean, options: { videoLevel?: string; expectedCodec?: string } = {}) {
  assert.equal(options.videoLevel === undefined, options.expectedCodec === undefined, 'video level and expected codec must be supplied together');
  const level = options.videoLevel ?? (alternatives ? '4.0' : '3.0');
  const codec = options.expectedCodec ?? (alternatives ? 'avc1.42c028' : 'avc1.42c01e');
  assert.ok(['3.0', '4.0'].includes(level), 'unsupported fixture AVC level');
  return { level, codec };
}

export function validateFixtureAvc(init: Uint8Array, expectedCodec: string): string {
  const avcC = codecDescriptionFromInit(init);
  assert.ok(avcC && avcC.length >= 4 && avcC[0] === 1, 'missing fixture AVC configuration');
  const actual = `avc1.${Buffer.from(avcC.subarray(1, 4)).toString('hex')}`;
  assert.equal(actual, expectedCodec, `AVC init codec differs from expected ${expectedCodec}`);
  return actual;
}
