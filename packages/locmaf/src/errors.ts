/**
 * LOCMAF error type.
 *
 * @see draft-einarsson-moq-locmaf-01
 * @module
 */

/**
 * A LOCMAF payload, CMAF Header, or source chunk violated a requirement of
 * draft-einarsson-moq-locmaf-01. Carries the draft section that states the
 * violated rule and the byte offset (within the input being parsed) where it
 * was detected; reconstruction-stage errors that are not tied to one byte use
 * offset 0.
 */
export class LocmafFormatError extends Error {
    /** Draft section of the violated rule, e.g. `"7.1"` or `"11.2"`. */
    readonly section: string;
    /** Byte offset in the parsed input, or 0 when not byte-specific. */
    readonly offset: number;

    constructor(section: string, offset: number, message: string) {
        super(`LOCMAF section ${section} at offset ${offset}: ${message}`);
        this.name = 'LocmafFormatError';
        this.section = section;
        this.offset = offset;
    }
}
