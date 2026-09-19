/**
 * DASH event message boxes (`emsg`, ISO/IEC 23009-1 section 5.10.3.3) carried
 * as genBox elements of an event-only track (section 14). LOCMAF passes each
 * emsg through verbatim ahead of the chunk's locmafHeader; this module reads
 * the two box versions so a receiver can dispatch the timed events without
 * reassembling a CMAF chunk first.
 *
 * @see draft-einarsson-moq-locmaf-01 section 8, section 14
 * @module
 */
import { LocmafFormatError } from './errors.js';
import type { GenBox } from './model.js';

/** One parsed `emsg` box. */
export interface EmsgEvent {
    /** Box version: 0 (presentation_time_delta) or 1 (absolute presentation_time). */
    readonly version: 0 | 1;
    readonly schemeIdUri: string;
    readonly value: string;
    /** Timescale of the presentation time and duration fields. */
    readonly timescale: number;
    /**
     * Version 1: the absolute presentation time. Version 0: the delta from the
     * earliest presentation time of the chunk the box arrived with, which for
     * a LOCMAF event-only chunk is its tfdt base media decode time.
     */
    readonly presentationTime: bigint;
    /** Whether {@link presentationTime} is a version-0 delta rather than absolute. */
    readonly presentationTimeIsDelta: boolean;
    /** Event duration in timescale ticks; 0xFFFFFFFF means unknown. */
    readonly eventDuration: number;
    readonly id: number;
    /** Scheme-specific payload, verbatim. */
    readonly messageData: Uint8Array;
}

const SECTION = '14';

function cString(buf: Uint8Array, start: number, end: number): { text: string; next: number } {
    let i = start;
    while (i < end && buf[i] !== 0) i++;
    if (i >= end) throw new LocmafFormatError(SECTION, start, 'emsg string is not NUL-terminated');
    return { text: new TextDecoder().decode(buf.subarray(start, i)), next: i + 1 };
}

/**
 * Parse the payload of an `emsg` box (everything after the box header).
 *
 * @throws {LocmafFormatError} on a truncated box or an unknown version.
 */
export function parseEmsgPayload(payload: Uint8Array): EmsgEvent {
    if (payload.length < 4) throw new LocmafFormatError(SECTION, 0, 'emsg box too short for version and flags');
    const version = payload[0]!;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (version === 0) {
        const scheme = cString(payload, 4, payload.length);
        const value = cString(payload, scheme.next, payload.length);
        const fields = value.next;
        if (fields + 16 > payload.length) throw new LocmafFormatError(SECTION, fields, 'emsg v0 fields truncated');
        return {
            version: 0,
            schemeIdUri: scheme.text,
            value: value.text,
            timescale: view.getUint32(fields),
            presentationTime: BigInt(view.getUint32(fields + 4)),
            presentationTimeIsDelta: true,
            eventDuration: view.getUint32(fields + 8),
            id: view.getUint32(fields + 12),
            messageData: payload.slice(fields + 16),
        };
    }
    if (version === 1) {
        if (payload.length < 24) throw new LocmafFormatError(SECTION, 4, 'emsg v1 fields truncated');
        const scheme = cString(payload, 24, payload.length);
        const value = cString(payload, scheme.next, payload.length);
        return {
            version: 1,
            schemeIdUri: scheme.text,
            value: value.text,
            timescale: view.getUint32(4),
            presentationTime: view.getBigUint64(8),
            presentationTimeIsDelta: false,
            eventDuration: view.getUint32(16),
            id: view.getUint32(20),
            messageData: payload.slice(value.next),
        };
    }
    throw new LocmafFormatError(SECTION, 0, `unknown emsg version ${version}`);
}

/** The parsed `emsg` boxes among a chunk's genBoxes, in order; other box types are skipped. */
export function parseEmsgBoxes(genBoxes: readonly GenBox[]): EmsgEvent[] {
    const events: EmsgEvent[] = [];
    for (const box of genBoxes) {
        if (box.type === 'emsg') events.push(parseEmsgPayload(box.payload));
    }
    return events;
}
