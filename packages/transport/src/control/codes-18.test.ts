/**
 * draft-18 wire code tables + classification helpers.
 * Codes verified against draft-ietf-moq-transport-18 IANA registries (§16).
 */
import { describe, it, expect } from 'vitest';
import {
  ControlMessageType18,
  isMandatoryProperty,
  PropertyRange18,
} from './codes-18.js';
import {
  StreamType18,
  PADDING_DATAGRAM_TYPE,
  SubgroupFlags18,
  DatagramFlags18,
  isSubgroupHeaderForm18,
  isValidSubgroupHeaderType18,
  isDatagramForm18,
  isValidDatagramType18,
} from '../data/codes-18.js';

describe('ControlMessageType18', () => {
  it('matches the draft-18 message type registry', () => {
    expect(ControlMessageType18.REQUEST_UPDATE).toBe(0x02);
    expect(ControlMessageType18.SUBSCRIBE).toBe(0x03);
    expect(ControlMessageType18.SUBSCRIBE_OK).toBe(0x04);
    expect(ControlMessageType18.REQUEST_ERROR).toBe(0x05);
    expect(ControlMessageType18.PUBLISH_NAMESPACE).toBe(0x06);
    expect(ControlMessageType18.REQUEST_OK).toBe(0x07);
    expect(ControlMessageType18.NAMESPACE).toBe(0x08);
    expect(ControlMessageType18.PUBLISH_DONE).toBe(0x0b);
    expect(ControlMessageType18.TRACK_STATUS).toBe(0x0d);
    expect(ControlMessageType18.NAMESPACE_DONE).toBe(0x0e);
    expect(ControlMessageType18.PUBLISH_BLOCKED).toBe(0x0f);
    expect(ControlMessageType18.GOAWAY).toBe(0x10);
    expect(ControlMessageType18.FETCH).toBe(0x16);
    expect(ControlMessageType18.FETCH_OK).toBe(0x18);
    expect(ControlMessageType18.PUBLISH).toBe(0x1d);
    // draft-18 accepts a PUBLISH with the REQUEST_OK shorthand (0x07, §10.5); the
    // standalone 0x1E PUBLISH_OK message of draft-14/16 was removed in the
    // changelog, so there is intentionally NO draft-18 PUBLISH_OK code here.
    expect('PUBLISH_OK' in ControlMessageType18).toBe(false);
    expect(ControlMessageType18.SETUP).toBe(0x2f00);
    expect(ControlMessageType18.SUBSCRIBE_NAMESPACE).toBe(0x50);
    expect(ControlMessageType18.SUBSCRIBE_TRACKS).toBe(0x51);
  });

  it('drops messages removed in draft-18', () => {
    expect('CLIENT_SETUP' in ControlMessageType18).toBe(false);
    expect('SERVER_SETUP' in ControlMessageType18).toBe(false);
    expect('UNSUBSCRIBE' in ControlMessageType18).toBe(false);
    expect('FETCH_CANCEL' in ControlMessageType18).toBe(false);
    expect('MAX_REQUEST_ID' in ControlMessageType18).toBe(false);
    expect('REQUESTS_BLOCKED' in ControlMessageType18).toBe(false);
  });
});

describe('StreamType18', () => {
  it('matches the §3.4 unidirectional stream type table', () => {
    expect(StreamType18.FETCH_HEADER).toBe(0x05);
    expect(StreamType18.SETUP).toBe(0x2f00);
    expect(StreamType18.PADDING).toBe(0x132b3e28);
  });
  it('does NOT include the padding datagram (that is a datagram, §11.5.2)', () => {
    expect('PADDING_DATAGRAM' in StreamType18).toBe(false);
    expect(PADDING_DATAGRAM_TYPE).toBe(0x132b3e29);
  });
});

describe('subgroup header form vs validity (§11.4.2)', () => {
  it('form accepts the four 16-wide bands 0b0XX1XXXX', () => {
    for (const base of [0x10, 0x30, 0x50, 0x70]) {
      for (let i = 0; i < 16; i++) expect(isSubgroupHeaderForm18(base + i)).toBe(true);
    }
  });
  it('form rejects bands with bit 4 clear and values >0x7F', () => {
    for (const base of [0x00, 0x20, 0x40, 0x60]) {
      for (let i = 0; i < 16; i++) expect(isSubgroupHeaderForm18(base + i)).toBe(false);
    }
    expect(isSubgroupHeaderForm18(0x90)).toBe(false);
    expect(isSubgroupHeaderForm18(0xff)).toBe(false);
  });
  it('FIRST_OBJECT (0x40) expands the form beyond draft-16 0x3F', () => {
    expect(SubgroupFlags18.FIRST_OBJECT).toBe(0x40);
    expect(isSubgroupHeaderForm18(0x14)).toBe(true);
    expect(isSubgroupHeaderForm18(0x54)).toBe(true); // 0x14 | FIRST_OBJECT
  });
  it('validity rejects the reserved subgroup-ID mode 0b11 even though the form matches', () => {
    // mode bits 1–2 == 0b11 → e.g. 0x16, 0x17, 0x1E, 0x1F, 0x36, ...
    for (const t of [0x16, 0x17, 0x1e, 0x1f, 0x36, 0x56, 0x76]) {
      expect(isSubgroupHeaderForm18(t)).toBe(true);
      expect(isValidSubgroupHeaderType18(t)).toBe(false);
    }
    // mode 0b00/0b01/0b10 are valid
    for (const t of [0x10, 0x12, 0x14, 0x54]) {
      expect(isValidSubgroupHeaderType18(t)).toBe(true);
    }
  });
});

describe('datagram form vs validity (§11.3.1)', () => {
  it('form accepts 0x00–0x0F and 0x20–0x2F, rejects bit 4 / bit 7', () => {
    for (let t = 0x00; t <= 0x0f; t++) expect(isDatagramForm18(t)).toBe(true);
    for (let t = 0x20; t <= 0x2f; t++) expect(isDatagramForm18(t)).toBe(true);
    for (let t = 0x10; t <= 0x1f; t++) expect(isDatagramForm18(t)).toBe(false);
    expect(isDatagramForm18(0x80)).toBe(false);
  });
  it('validity rejects STATUS+END_OF_GROUP combinations (Figure 23)', () => {
    for (const t of [0x22, 0x23, 0x26, 0x27, 0x2a, 0x2b, 0x2e, 0x2f]) {
      expect(isDatagramForm18(t)).toBe(true);
      expect(isValidDatagramType18(t)).toBe(false);
    }
    // STATUS without END_OF_GROUP (0x20, 0x21, 0x24, 0x25...) stays valid
    for (const t of [0x00, 0x20, 0x21, 0x24, 0x28]) {
      expect(isValidDatagramType18(t)).toBe(true);
    }
  });
  it('exposes STATUS and END_OF_GROUP flags', () => {
    expect(DatagramFlags18.STATUS).toBe(0x20);
    expect(DatagramFlags18.END_OF_GROUP).toBe(0x02);
  });
});

describe('isMandatoryProperty', () => {
  it('is true only within 0x4000–0x7FFF', () => {
    expect(isMandatoryProperty(PropertyRange18.MANDATORY_MIN)).toBe(true);
    expect(isMandatoryProperty(0x4000)).toBe(true);
    expect(isMandatoryProperty(0x7fff)).toBe(true);
    expect(isMandatoryProperty(0x3fff)).toBe(false);
    expect(isMandatoryProperty(0x8000)).toBe(false);
  });
});
