/**
 * Error-code registry conformance: the legacy (draft-14/16) tables stay frozen,
 * and the draft-18 tables carry the renumbered §15.10 values. The divergent
 * entries are pinned explicitly because mixing the two is a real interop bug
 * (e.g. PUBLISH_DONE TOO_FAR_BEHIND is 0x6 on draft-16 but 0x5 on draft-18).
 */
import { describe, it, expect } from 'vitest';
import {
  RequestError,
  PublishDoneCode,
  DataStreamError,
  RequestError18,
  PublishDoneCode18,
  StreamResetCode18,
  DataStreamError18,
} from './errors.js';

describe('legacy (draft-14/16) registries stay frozen', () => {
  it('PUBLISH_DONE: EXPIRED=0x5, TOO_FAR_BEHIND=0x6', () => {
    expect(PublishDoneCode.EXPIRED).toBe(0x5n);
    expect(PublishDoneCode.TOO_FAR_BEHIND).toBe(0x6n);
  });

  it('Data Stream Reset: UNKNOWN_OBJECT_STATUS=0x4 (no GOING_AWAY)', () => {
    expect(DataStreamError.UNKNOWN_OBJECT_STATUS).toBe(0x4n);
    expect('GOING_AWAY' in DataStreamError).toBe(false);
  });

  it('REQUEST_ERROR has no GOING_AWAY / EXCESSIVE_LOAD (draft-18 additions)', () => {
    expect('GOING_AWAY' in RequestError).toBe(false);
    expect('EXCESSIVE_LOAD' in RequestError).toBe(false);
  });
});

describe('draft-18 registries (§15.10)', () => {
  it('REQUEST_ERROR18 (§15.10.2): GOING_AWAY=0x6, EXCESSIVE_LOAD=0x9, REDIRECT=0x34', () => {
    expect(RequestError18.GOING_AWAY).toBe(0x6n);
    expect(RequestError18.EXCESSIVE_LOAD).toBe(0x9n);
    expect(RequestError18.UNSUPPORTED_EXTENSION).toBe(0x33n);
    expect(RequestError18.REDIRECT).toBe(0x34n);
  });

  it('PUBLISH_DONE18 (§15.10.3): TOO_FAR_BEHIND=0x5, EXPIRED=0x6 (swapped vs legacy), EXCESSIVE_LOAD=0x9', () => {
    expect(PublishDoneCode18.TOO_FAR_BEHIND).toBe(0x5n);
    expect(PublishDoneCode18.EXPIRED).toBe(0x6n);
    expect(PublishDoneCode18.GOING_AWAY).toBe(0x4n);
    expect(PublishDoneCode18.EXCESSIVE_LOAD).toBe(0x9n);
    // The swap is the whole point: the two values are NOT what the legacy table has.
    expect(PublishDoneCode18.TOO_FAR_BEHIND).not.toBe(PublishDoneCode.TOO_FAR_BEHIND);
    expect(PublishDoneCode18.EXPIRED).not.toBe(PublishDoneCode.EXPIRED);
  });

  it('StreamResetCode18 (§15.10.4): GOING_AWAY=0x4, TOO_FAR_BEHIND=0x5, UNKNOWN_OBJECT_STATUS=0x6, EXPIRED_AUTH_TOKEN=0x7, EXCESSIVE_LOAD=0x9', () => {
    expect(StreamResetCode18.GOING_AWAY).toBe(0x4n);
    expect(StreamResetCode18.TOO_FAR_BEHIND).toBe(0x5n);
    expect(StreamResetCode18.UNKNOWN_OBJECT_STATUS).toBe(0x6n); // moved off 0x4 to clear GOING_AWAY
    expect(StreamResetCode18.EXPIRED_AUTH_TOKEN).toBe(0x7n);
    expect(StreamResetCode18.EXCESSIVE_LOAD).toBe(0x9n);
    expect(StreamResetCode18.CANCELLED).toBe(0x1n);
  });

  it('DataStreamError18 is a deprecated alias of StreamResetCode18', () => {
    expect(DataStreamError18).toBe(StreamResetCode18);
  });
});
