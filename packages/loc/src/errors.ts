/**
 * LOC error types.
 *
 * Both errors name the header field involved so callers can log precisely
 * without parsing message text.
 *
 * @module
 */

/** A property block decoded at the wire layer but is not valid LOC. */
export class LocHeaderError extends Error {
    constructor(readonly field: string, message: string) {
        super(`LOC header ${field}: ${message}`);
        this.name = 'LocHeaderError';
    }
}

/** A header set cannot be represented under the requested LOC version. */
export class LocEncodeError extends Error {
    constructor(readonly field: string, message: string) {
        super(`LOC encode ${field}: ${message}`);
        this.name = 'LocEncodeError';
    }
}
