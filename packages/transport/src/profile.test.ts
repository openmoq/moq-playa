/**
 * ProtocolProfile selector — bundles the per-draft control codec, data codec,
 * and request policy behind a single version-keyed lookup.
 */
import { describe, it, expect } from 'vitest';
import { getProtocolProfile } from './profile.js';
import { createControlCodec } from './control/codec.js';
import { createDataCodec } from './data/data-codec.js';
import { getRequestPolicy } from './session/request-policy.js';

describe('getProtocolProfile', () => {
  for (const version of [14, 16, 18] as const) {
    it(`bundles control + data + policy for draft-${version}`, () => {
      const profile = getProtocolProfile(version);
      expect(profile.version).toBe(version);
      expect(profile.control.version).toBe(version);
      expect(profile.data.version).toBe(version);
      expect(profile.requestPolicy).toEqual(getRequestPolicy(version));
    });
  }

  it('defaults to draft-16', () => {
    expect(getProtocolProfile().version).toBe(16);
  });
});

describe('ProfileCapabilities — per-draft semantic flags', () => {
  it('draft-14 uses the legacy (bidi control, inline request ID) capabilities', () => {
    expect(getProtocolProfile(14).capabilities).toEqual({
      usesUnifiedSetup: false,
      usesRequestStreams: false,
      responsesOmitRequestId: false,
      usesFetchCancelMessage: true,
      usesPublishNamespaceDoneMessage: true,
    });
  });

  it('draft-16 matches draft-14 capabilities', () => {
    expect(getProtocolProfile(16).capabilities).toEqual(getProtocolProfile(14).capabilities);
  });

  it('draft-18 uses the unified-setup / request-stream capabilities', () => {
    expect(getProtocolProfile(18).capabilities).toEqual({
      usesUnifiedSetup: true,
      usesRequestStreams: true,
      responsesOmitRequestId: true,
      usesFetchCancelMessage: false,
      usesPublishNamespaceDoneMessage: false,
    });
  });
});

describe('createControlCodec — version selection', () => {
  it('constructs 14, 16, and 18', () => {
    expect(createControlCodec(14).version).toBe(14);
    expect(createControlCodec(16).version).toBe(16);
    // draft-18 control codec is now wired (SUBSCRIBE/SUBSCRIBE_OK increment).
    expect(createControlCodec(18).version).toBe(18);
  });
});

describe('createDataCodec — version selection', () => {
  it('constructs 14, 16, and 18', () => {
    expect(createDataCodec(14).version).toBe(14);
    expect(createDataCodec(16).version).toBe(16);
    // draft-18 data codec is now wired (subgroup + datagram decode increment).
    expect(createDataCodec(18).version).toBe(18);
  });
});
