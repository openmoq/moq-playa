/**
 * Data plane codes and flags tests.
 * @see draft-ietf-moq-transport-16 §10
 */

import { describe, it, expect } from 'vitest';
import {
  ObjectStatus,
  DataStreamType,
  SubgroupFlags,
  SubgroupIdMode,
  DatagramFlags,
  FetchFlags,
  FetchSubgroupMode,
  FetchSpecialFlags,
  isSubgroupHeaderType,
  isDatagramType,
  isValidSubgroupIdMode,
  isValidDatagramFlags,
  getSubgroupIdMode,
} from './codes.js';

describe('ObjectStatus', () => {
  it('has correct values per spec §10.2.1.1', () => {
    expect(ObjectStatus.NORMAL).toBe(0x0n);
    expect(ObjectStatus.END_OF_GROUP).toBe(0x3n);
    expect(ObjectStatus.END_OF_TRACK).toBe(0x4n);
  });

  /**
   * draft-ietf-moq-transport-14 §10.2.1.1: "0x1 := Indicates Object Does
   * Not Exist. Indicates that this Object does not exist at any publisher
   * and it will not be published in the future."
   */
  it('has OBJECT_DOES_NOT_EXIST (0x1) for draft-14', () => {
    expect(ObjectStatus.OBJECT_DOES_NOT_EXIST).toBe(0x1n);
  });
});

describe('DataStreamType', () => {
  it('FETCH_HEADER is 0x05', () => {
    expect(DataStreamType.FETCH_HEADER).toBe(0x05);
  });
});

describe('SubgroupFlags', () => {
  it('has correct bit positions', () => {
    expect(SubgroupFlags.EXTENSIONS).toBe(0x01);
    expect(SubgroupFlags.SUBGROUP_ID_MODE_MASK).toBe(0x06);
    expect(SubgroupFlags.END_OF_GROUP).toBe(0x08);
    expect(SubgroupFlags.SUBGROUP_MARKER).toBe(0x10);
    expect(SubgroupFlags.DEFAULT_PRIORITY).toBe(0x20);
  });
});

describe('SubgroupIdMode', () => {
  it('has correct mode values', () => {
    expect(SubgroupIdMode.ZERO).toBe(0b00);
    expect(SubgroupIdMode.FIRST_OBJECT).toBe(0b01);
    expect(SubgroupIdMode.EXPLICIT).toBe(0b10);
    expect(SubgroupIdMode.RESERVED).toBe(0b11);
  });
});

describe('DatagramFlags', () => {
  it('has correct bit positions', () => {
    expect(DatagramFlags.EXTENSIONS).toBe(0x01);
    expect(DatagramFlags.END_OF_GROUP).toBe(0x02);
    expect(DatagramFlags.ZERO_OBJECT_ID).toBe(0x04);
    expect(DatagramFlags.DEFAULT_PRIORITY).toBe(0x08);
    expect(DatagramFlags.STATUS).toBe(0x20);
  });
});

describe('FetchFlags', () => {
  it('has correct bit positions', () => {
    expect(FetchFlags.SUBGROUP_MODE_MASK).toBe(0x03);
    expect(FetchFlags.OBJECT_ID).toBe(0x04);
    expect(FetchFlags.GROUP_ID).toBe(0x08);
    expect(FetchFlags.PRIORITY).toBe(0x10);
    expect(FetchFlags.EXTENSIONS).toBe(0x20);
    expect(FetchFlags.DATAGRAM).toBe(0x40);
  });
});

describe('FetchSubgroupMode', () => {
  it('has correct mode values', () => {
    expect(FetchSubgroupMode.ZERO).toBe(0x00);
    expect(FetchSubgroupMode.PRIOR).toBe(0x01);
    expect(FetchSubgroupMode.PRIOR_PLUS_ONE).toBe(0x02);
    expect(FetchSubgroupMode.EXPLICIT).toBe(0x03);
  });
});

describe('FetchSpecialFlags', () => {
  it('has correct special values', () => {
    expect(FetchSpecialFlags.END_NON_EXISTENT).toBe(0x8c);
    expect(FetchSpecialFlags.END_UNKNOWN).toBe(0x10c);
  });
});

describe('isSubgroupHeaderType', () => {
  it('returns true for valid subgroup header types (0x10-0x1F)', () => {
    for (let i = 0x10; i <= 0x1f; i++) {
      expect(isSubgroupHeaderType(i)).toBe(true);
    }
  });

  it('returns true for valid subgroup header types (0x30-0x3F)', () => {
    for (let i = 0x30; i <= 0x3f; i++) {
      expect(isSubgroupHeaderType(i)).toBe(true);
    }
  });

  it('returns false for datagram types (0x00-0x0F)', () => {
    for (let i = 0x00; i <= 0x0f; i++) {
      expect(isSubgroupHeaderType(i)).toBe(false);
    }
  });

  it('returns false for datagram types (0x20-0x2F)', () => {
    for (let i = 0x20; i <= 0x2f; i++) {
      expect(isSubgroupHeaderType(i)).toBe(false);
    }
  });

  it('returns false for types with high bits set (0x40+)', () => {
    expect(isSubgroupHeaderType(0x40)).toBe(false);
    expect(isSubgroupHeaderType(0x50)).toBe(false);
    expect(isSubgroupHeaderType(0xff)).toBe(false);
  });
});

describe('isDatagramType', () => {
  it('returns true for valid datagram types (0x00-0x0F)', () => {
    for (let i = 0x00; i <= 0x0f; i++) {
      expect(isDatagramType(i)).toBe(true);
    }
  });

  it('returns true for valid datagram types (0x20-0x2F)', () => {
    for (let i = 0x20; i <= 0x2f; i++) {
      expect(isDatagramType(i)).toBe(true);
    }
  });

  it('returns false for subgroup header types (0x10-0x1F)', () => {
    for (let i = 0x10; i <= 0x1f; i++) {
      expect(isDatagramType(i)).toBe(false);
    }
  });

  it('returns false for subgroup header types (0x30-0x3F)', () => {
    for (let i = 0x30; i <= 0x3f; i++) {
      expect(isDatagramType(i)).toBe(false);
    }
  });

  it('returns false for types with high bits set (0x40+)', () => {
    expect(isDatagramType(0x40)).toBe(false);
    expect(isDatagramType(0x60)).toBe(false);
    expect(isDatagramType(0xff)).toBe(false);
  });
});

describe('isValidSubgroupIdMode', () => {
  it('returns true for mode 0 (ZERO)', () => {
    // Type 0x10: mode bits = 00
    expect(isValidSubgroupIdMode(0x10)).toBe(true);
  });

  it('returns true for mode 1 (FIRST_OBJECT)', () => {
    // Type 0x12: mode bits = 01
    expect(isValidSubgroupIdMode(0x12)).toBe(true);
  });

  it('returns true for mode 2 (EXPLICIT)', () => {
    // Type 0x14: mode bits = 10
    expect(isValidSubgroupIdMode(0x14)).toBe(true);
  });

  it('returns false for mode 3 (RESERVED)', () => {
    // Type 0x16: mode bits = 11
    expect(isValidSubgroupIdMode(0x16)).toBe(false);
    expect(isValidSubgroupIdMode(0x17)).toBe(false);
    expect(isValidSubgroupIdMode(0x1e)).toBe(false);
    expect(isValidSubgroupIdMode(0x1f)).toBe(false);
  });
});

describe('isValidDatagramFlags', () => {
  it('returns true for normal datagrams', () => {
    expect(isValidDatagramFlags(0x00)).toBe(true);
    expect(isValidDatagramFlags(0x01)).toBe(true); // EXTENSIONS
    expect(isValidDatagramFlags(0x08)).toBe(true); // DEFAULT_PRIORITY
  });

  it('returns true for END_OF_GROUP alone', () => {
    expect(isValidDatagramFlags(0x02)).toBe(true);
    expect(isValidDatagramFlags(0x0a)).toBe(true); // END_OF_GROUP | DEFAULT_PRIORITY
  });

  it('returns true for STATUS alone', () => {
    expect(isValidDatagramFlags(0x20)).toBe(true);
    expect(isValidDatagramFlags(0x28)).toBe(true); // STATUS | DEFAULT_PRIORITY
  });

  it('returns false for STATUS + END_OF_GROUP together', () => {
    // 0x22 = STATUS | END_OF_GROUP
    expect(isValidDatagramFlags(0x22)).toBe(false);
    expect(isValidDatagramFlags(0x23)).toBe(false);
    expect(isValidDatagramFlags(0x26)).toBe(false);
    expect(isValidDatagramFlags(0x27)).toBe(false);
    expect(isValidDatagramFlags(0x2a)).toBe(false);
    expect(isValidDatagramFlags(0x2b)).toBe(false);
    expect(isValidDatagramFlags(0x2e)).toBe(false);
    expect(isValidDatagramFlags(0x2f)).toBe(false);
  });
});

describe('getSubgroupIdMode', () => {
  it('extracts mode 0 from type bytes', () => {
    expect(getSubgroupIdMode(0x10)).toBe(0); // 0b00
    expect(getSubgroupIdMode(0x11)).toBe(0); // 0b00 (bit 0 is EXTENSIONS)
    expect(getSubgroupIdMode(0x18)).toBe(0); // 0b00 (bit 3 is END_OF_GROUP)
  });

  it('extracts mode 1 from type bytes', () => {
    expect(getSubgroupIdMode(0x12)).toBe(1); // 0b01
    expect(getSubgroupIdMode(0x13)).toBe(1);
  });

  it('extracts mode 2 from type bytes', () => {
    expect(getSubgroupIdMode(0x14)).toBe(2); // 0b10
    expect(getSubgroupIdMode(0x15)).toBe(2);
  });

  it('extracts mode 3 from type bytes', () => {
    expect(getSubgroupIdMode(0x16)).toBe(3); // 0b11
    expect(getSubgroupIdMode(0x17)).toBe(3);
  });
});

describe('draft-14 type validation', () => {
  /**
   * draft-ietf-moq-transport-14 §10.4.2: SUBGROUP_HEADER Type = 0x10..0x1D
   * (12 defined types). The 0x30-0x3F range (DEFAULT_PRIORITY) does not exist.
   */
  describe('isSubgroupHeaderType with version=14', () => {
    it('accepts the 12 defined types in 0x10-0x1D (excluding mode 0b11)', () => {
      // Mode 0b11 = bits 1-2 both set = 0x16, 0x17 are reserved
      const valid = [
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, // modes 0b00, 0b01, 0b10
        0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, // + END_OF_GROUP flag
      ];
      for (const t of valid) {
        expect(isSubgroupHeaderType(t, 14)).toBe(true);
      }
    });

    it('rejects 0x16-0x17 (reserved mode 0b11) and 0x1E-0x1F', () => {
      expect(isSubgroupHeaderType(0x16, 14)).toBe(false);
      expect(isSubgroupHeaderType(0x17, 14)).toBe(false);
      expect(isSubgroupHeaderType(0x1e, 14)).toBe(false);
      expect(isSubgroupHeaderType(0x1f, 14)).toBe(false);
    });

    it('rejects 0x30-0x3F (no DEFAULT_PRIORITY in draft-14)', () => {
      for (let t = 0x30; t <= 0x3f; t++) {
        expect(isSubgroupHeaderType(t, 14)).toBe(false);
      }
    });
  });

  /**
   * draft-ietf-moq-transport-14 §10.3.1: OBJECT_DATAGRAM Type = 0x0-0x7, 0x20-0x21
   * (10 defined types). No DEFAULT_PRIORITY bit.
   */
  describe('isDatagramType with version=14', () => {
    it('accepts 0x00-0x07', () => {
      for (let t = 0x00; t <= 0x07; t++) {
        expect(isDatagramType(t, 14)).toBe(true);
      }
    });

    it('accepts 0x20-0x21', () => {
      expect(isDatagramType(0x20, 14)).toBe(true);
      expect(isDatagramType(0x21, 14)).toBe(true);
    });

    it('rejects 0x08-0x0F (DEFAULT_PRIORITY range)', () => {
      for (let t = 0x08; t <= 0x0f; t++) {
        expect(isDatagramType(t, 14)).toBe(false);
      }
    });

    it('rejects 0x22-0x2F', () => {
      for (let t = 0x22; t <= 0x2f; t++) {
        expect(isDatagramType(t, 14)).toBe(false);
      }
    });
  });
});
