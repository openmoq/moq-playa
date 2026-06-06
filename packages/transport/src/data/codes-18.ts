/**
 * draft-18 data-plane wire codes: unidirectional stream types and the
 * SUBGROUP_HEADER / OBJECT_DATAGRAM type-byte layouts.
 *
 * Differs from draft-16 (`./codes.ts`): the SUBGROUP_HEADER range expands to
 * 0b0XX1XXXX with the new FIRST_OBJECT bit (0x40), and stream types are read as
 * vi64 values (so the multi-byte SETUP 0x2F00 and PADDING 0x132B3E28 fit).
 *
 * @see draft-ietf-moq-transport-18 §3.4 (stream types), §11.3–§11.4 (data)
 * @module
 */

/** draft-18 unidirectional stream types (§3.4 Table 3). Read as a vi64 value. */
export const StreamType18 = {
  FETCH_HEADER: 0x05,
  SETUP: 0x2f00,
  /** Padding STREAM (§11.5.1). */
  PADDING: 0x132b3e28,
} as const;

/**
 * Padding DATAGRAM type (§11.5.2) — a datagram, NOT a unidirectional stream
 * type, so it lives outside {@link StreamType18}.
 */
export const PADDING_DATAGRAM_TYPE = 0x132b3e29;

/**
 * SUBGROUP_HEADER type-byte bit flags (§11.4.2). Type form: 0b0XX1XXXX.
 * draft-18 adds FIRST_OBJECT (0x40), expanding the range beyond draft-16's 0x3F.
 */
export const SubgroupFlags18 = {
  /** Object Properties present in all objects on this stream. */
  PROPERTIES: 0x01,
  /** Subgroup ID mode (bits 1–2). */
  SUBGROUP_ID_MODE_MASK: 0x06,
  /** Subgroup contains the largest object in the group. */
  END_OF_GROUP: 0x08,
  /** Publisher Priority field omitted; use subscription priority. */
  DEFAULT_PRIORITY: 0x20,
  /** First object on the stream is the first ever published in the subgroup. */
  FIRST_OBJECT: 0x40,
} as const;

/** OBJECT_DATAGRAM type-byte bit flags (§11.3.1). Type form: 0b00X0XXXX. */
export const DatagramFlags18 = {
  PROPERTIES: 0x01,
  END_OF_GROUP: 0x02,
  ZERO_OBJECT_ID: 0x04,
  DEFAULT_PRIORITY: 0x08,
  STATUS: 0x20,
} as const;

/** Reserved subgroup-ID mode (bits 1–2 == 0b11); using it is a PROTOCOL_VIOLATION. */
export const SUBGROUP_ID_MODE_RESERVED = 0b11;

/** Extract the subgroup-ID mode (bits 1–2) from a SUBGROUP_HEADER type byte. */
export function subgroupIdMode18(type: number): number {
  return (type & SubgroupFlags18.SUBGROUP_ID_MODE_MASK) >> 1;
}

/**
 * Whether a type byte MATCHES the SUBGROUP_HEADER form 0b0XX1XXXX (bit 4 set,
 * bit 7 clear → 0x10–0x1F, 0x30–0x3F, 0x50–0x5F, 0x70–0x7F). The 0x50/0x70 bands
 * are new (FIRST_OBJECT bit). This is a *form* test for stream classification —
 * it does NOT validate the subgroup-ID mode; use {@link isValidSubgroupHeaderType18}
 * for that.
 */
export function isSubgroupHeaderForm18(type: number): boolean {
  return type >= 0x10 && type <= 0x7f && (type & 0x10) !== 0;
}

/**
 * Whether a SUBGROUP_HEADER type byte is fully valid: matches the form AND does
 * not use the reserved subgroup-ID mode 0b11 (§11.4.2).
 */
export function isValidSubgroupHeaderType18(type: number): boolean {
  return isSubgroupHeaderForm18(type) && subgroupIdMode18(type) !== SUBGROUP_ID_MODE_RESERVED;
}

/**
 * Whether a type byte MATCHES the OBJECT_DATAGRAM form 0b00X0XXXX (bit 4 clear,
 * bits 6–7 clear → 0x00–0x0F, 0x20–0x2F). Form test only; does not reject the
 * invalid STATUS+END_OF_GROUP combinations — use {@link isValidDatagramType18}.
 */
export function isDatagramForm18(type: number): boolean {
  return type <= 0x2f && (type & 0x10) === 0 && (type & 0xc0) === 0;
}

/**
 * Whether an OBJECT_DATAGRAM type byte is fully valid: matches the form AND does
 * not set both STATUS (0x20) and END_OF_GROUP (0x02) — those combinations
 * (0x22, 0x23, 0x26, 0x27, 0x2A, 0x2B, 0x2E, 0x2F) are a PROTOCOL_VIOLATION
 * (§11.3.1, Figure 23).
 */
export function isValidDatagramType18(type: number): boolean {
  if (!isDatagramForm18(type)) return false;
  const hasStatus = (type & DatagramFlags18.STATUS) !== 0;
  const hasEndOfGroup = (type & DatagramFlags18.END_OF_GROUP) !== 0;
  return !(hasStatus && hasEndOfGroup);
}
