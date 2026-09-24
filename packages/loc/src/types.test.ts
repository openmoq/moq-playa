import { describe, it, expect } from 'vitest';
import { Loc01PropertyId, Loc04PropertyId, LocExtensionId } from './types.js';
import { LocHeaderError, LocEncodeError } from './errors.js';

describe('LOC property id tables', () => {
    it('LOC-01 ids match draft-ietf-moq-loc-01 §2.3', () => {
        expect(Loc01PropertyId.CAPTURE_TIMESTAMP).toBe(0x02);
        expect(Loc01PropertyId.VIDEO_FRAME_MARKING).toBe(0x04);
        expect(Loc01PropertyId.AUDIO_LEVEL).toBe(0x06);
        expect(Loc01PropertyId.VIDEO_CONFIG).toBe(0x0d);
    });

    it('LOC-04 ids match draft-ietf-moq-loc-04 §6.1', () => {
        expect(Loc04PropertyId.TIMESTAMP).toBe(0x10);
        expect(Loc04PropertyId.TIMESCALE).toBe(0x08);
        expect(Loc04PropertyId.VIDEO_FRAME_MARKING).toBe(0x09);
        expect(Loc04PropertyId.AUDIO_LEVEL).toBe(0x0c);
        expect(Loc04PropertyId.VIDEO_CONFIG).toBe(0x0d);
        expect(Loc04PropertyId.AUDIO_CONFIG).toBe(0x0f);
    });

    it('LocExtensionId is the LOC-01 table (deprecated alias)', () => {
        expect(LocExtensionId).toBe(Loc01PropertyId);
    });

    it('errors are distinguishable and carry the field name', () => {
        const h = new LocHeaderError('timescale', 'Timescale must be non-zero');
        expect(h).toBeInstanceOf(Error);
        expect(h.field).toBe('timescale');
        const e = new LocEncodeError('audioConfig', 'not representable in LOC-01');
        expect(e).toBeInstanceOf(Error);
        expect(e.field).toBe('audioConfig');
        expect(e).not.toBeInstanceOf(LocHeaderError);
    });
});
