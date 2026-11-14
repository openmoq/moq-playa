/**
 * Draft-23 wire vectors (`packages/transport/vectors/d23/wire-vectors.txt`).
 *
 * Unlike the draft-22 set, these come from Playa alone: the `converted-from-d22`
 * lines re-encode the shared draft-22 vectors with the draft-23 codec, and the
 * `draft-text` lines are hand-built from the draft. They pin the encoding; they
 * are not interoperability evidence until another implementation decodes them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vectorsDir, bytesToHex, hexToBytes } from './load-vectors.js';
import { createControlCodec } from '../control/codec.js';
import { decodeMessageParams18, DRAFT23_MESSAGE_PARAM_REGISTRY } from '../control/message-params-18.js';
import { decodeFetchObject18, type FetchObjectPrior18 } from '../data/decoder-18.js';
import type { DecodedFetchItem } from '../data/decoder.js';
import type { ControlMessage, PublishStateNotify, RequestErrorMsg } from '../control/messages.js';

interface Vector {
  readonly name: string;
  readonly kind: 'control' | 'parameter' | 'stream';
  readonly source: string;
  readonly bytes: Uint8Array;
}

function load(draft: 'd22' | 'd23'): Map<string, Vector> {
  const text = readFileSync(join(vectorsDir(draft), 'wire-vectors.txt'), 'utf8');
  const vectors = new Map<string, Vector>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [name, kind, source, hex] = trimmed.split(/\s+/);
    vectors.set(name!, { name: name!, kind: kind as Vector['kind'], source: source!, bytes: hexToBytes(hex!) });
  }
  return vectors;
}

const VECTORS = load('d23');
const D22 = load('d22');
const codec22 = createControlCodec(22);
const codec23 = createControlCodec(23);
const vector = (name: string): Uint8Array => {
  const v = VECTORS.get(name);
  if (v === undefined) throw new Error(`no draft-23 vector ${name}`);
  return v.bytes;
};
const decode = <T extends ControlMessage>(name: string): T => codec23.decode(vector(name), 0).message as T;

function decodeStream(bytes: Uint8Array): DecodedFetchItem[] {
  const items: DecodedFetchItem[] = [];
  let prior: FetchObjectPrior18 | undefined;
  for (let p = 0; p < bytes.length;) {
    const r = decodeFetchObject18(bytes, p, prior, items.length === 0, 'ascending', 23);
    items.push(r.item);
    prior = r.nextPrior;
    p += r.bytesRead;
  }
  return items;
}

describe('draft-23 wire vectors', () => {
  it('loads the full set', () => {
    expect(VECTORS.size).toBeGreaterThanOrEqual(38);
  });

  for (const v of VECTORS.values()) {
    if (v.kind !== 'control') continue;
    it(`${v.name} decodes and re-encodes byte for byte`, () => {
      const { message, bytesRead } = codec23.decode(v.bytes, 0);
      expect(bytesRead).toBe(v.bytes.length);
      expect(bytesToHex(codec23.encode({ requestId: 0n, ...message } as ControlMessage))).toBe(bytesToHex(v.bytes));
    });
  }

  it('every converted vector means what its draft-22 original means', () => {
    for (const v of VECTORS.values()) {
      if (v.source !== 'converted-from-d22') continue;
      const original = D22.get(v.name.replace('paused_1', 'forward_0'));
      expect(original, v.name).toBeDefined();
      expect(codec23.decode(v.bytes, 0).message, v.name).toEqual(codec22.decode(original!.bytes, 0).message);
    }
  });

  it('PUBLISH_STATE_NOTIFY carries PAUSED 1 for a draft-22 FORWARD 0', () => {
    expect(bytesToHex(vector('publish_state_notify_largest_3_7_paused_1')).endsWith('0801')).toBe(true);
    expect(decode<PublishStateNotify>('publish_state_notify_largest_3_7_paused_1').parameters.get(0x10n)).toEqual([0n]);
  });

  it('REQUEST_ERROR Error Details', () => {
    expect(decode<RequestErrorMsg>('request_error_redirect_empty_uri_namespace_and_name').redirect).toEqual({
      connectUri: new Uint8Array(), trackNamespace: [], trackName: new Uint8Array(),
    });
    expect(decode<RequestErrorMsg>('request_error_unsupported_extension_props_3e_10').unsupportedProperties)
      .toEqual([0x3en, 0x10n]);
  });

  it('SETUP MAX_CONTROL_MESSAGE_SIZE holds a vi64 in its bytes', () => {
    const setup = decode<{ type: 'SETUP'; setupOptions: Map<bigint, unknown[]> } & ControlMessage>('setup_max_control_message_size_70000');
    expect(setup.setupOptions.get(0x09n)).toEqual([new Uint8Array([0xc1, 0x11, 0x70])]);
  });

  it('FETCH stream entries', () => {
    const at = (items: DecodedFetchItem[]) => items.map((i) => [i.groupId, i.objectId]);
    expect(at(decodeStream(vector('fetch_objects_g1_o0_o3_o4')))).toEqual([[1n, 0n], [1n, 3n], [1n, 4n]]);
    expect(decodeStream(vector('fetch_end_of_unknown_range_first_g2_o5'))).toMatchObject([{ kind: 'unknown', groupId: 2n, objectId: 5n }]);
    expect(decodeStream(vector('fetch_object_g2_o3_then_end_of_non_existent_range_g2_o7'))[1])
      .toMatchObject({ kind: 'non-existent', groupId: 2n, objectId: 7n });
    expect(decodeStream(vector('fetch_object_g2_o3_then_end_of_gone_range_g5_o1'))[1])
      .toMatchObject({ kind: 'gone', groupId: 5n, objectId: 1n });
    expect(decodeStream(vector('fetch_object_g1_o0_end_of_group_object_g2_o0_end_of_track'))).toMatchObject([
      { groupId: 1n, objectId: 0n }, { marker: 'end-of-group' }, { groupId: 2n, objectId: 0n }, { marker: 'end-of-track' },
    ]);
    expect(decodeStream(vector('fetch_object_end_of_timed_out_range_g2_o4'))).toMatchObject([{ kind: 'timed-out' }]);
  });

  it('parameter vectors are known to the draft-23 registry', () => {
    for (const v of VECTORS.values()) {
      if (v.kind !== 'parameter') continue;
      const counted = new Uint8Array([1, ...v.bytes]);
      expect(decodeMessageParams18(counted, 0, DRAFT23_MESSAGE_PARAM_REGISTRY).bytesRead, v.name).toBe(counted.length);
    }
  });
});
