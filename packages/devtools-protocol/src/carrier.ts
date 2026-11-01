import { MAX_MESSAGE_BYTES } from './limits.js';
import { array, InvalidField, oneOf, record, text, uint64 } from './schema.js';
import type { Reader } from './schema.js';

export const CARRIER_CHANNEL = 'openmoq-devtools-carrier';
export const CARRIER_VERSION = 1;
export const MAX_CARRIER_BYTES = 4 * MAX_MESSAGE_BYTES + 2048;

export type RegistryCloseReason = 'owner-closed' | 'registry-disposed' | 'invalid-message'
  | 'unexpected-message' | 'reentrant-request';
export type CarrierClose =
  | { readonly kind: 'closed'; readonly reason: 'registry-closed'; readonly connectionReason: RegistryCloseReason }
  | { readonly kind: 'closed'; readonly reason: 'owner-closed' | 'idle-timeout' | 'page-hidden' | 'bridge-disposed'
      | 'invalid-packet' | 'invalid-receipt' | 'clock-error' | 'internal-error' | 'reentrant-exchange' | 'bridge-unavailable'; readonly connectionReason: null };
export type CarrierRequest =
  | { readonly kind: 'request'; readonly receipt: string; readonly message: string }
  | { readonly kind: 'poll'; readonly receipt: string }
  | { readonly kind: 'close' };
export type CarrierReply =
  | { readonly kind: 'reply'; readonly receipt: string; readonly frames: readonly string[] }
  | CarrierClose;
export type CarrierDecodeResult<T> = { readonly ok: true; readonly packet: T }
  | { readonly ok: false; readonly error: { readonly code: 'invalid-json' | 'invalid-packet' | 'too-large' | 'incompatible-version'; readonly path: string; readonly message: string } };

const receipt: Reader<string> = (value, path) => {
  const result = text(53, /^(0|[1-9][0-9]*)\.[0-9a-f]{32}$/)(value, path);
  uint64(result.slice(0, result.indexOf('.')), path);
  return result;
};
const frame: Reader<string> = (value, path) => {
  const result = text(MAX_MESSAGE_BYTES)(value, path);
  if (new TextEncoder().encode(result).byteLength > MAX_MESSAGE_BYTES) throw new InvalidField(path, 'bounded protocol frame');
  return result;
};
const registryReason = oneOf('owner-closed', 'registry-disposed', 'invalid-message', 'unexpected-message', 'reentrant-request');
const closeReason = oneOf('owner-closed', 'idle-timeout', 'page-hidden', 'bridge-disposed', 'invalid-packet',
  'invalid-receipt', 'clock-error', 'internal-error', 'reentrant-exchange', 'bridge-unavailable');

const request: Reader<CarrierRequest> = (value, path) => {
  const p = record(value, path);
  switch (p.kind) {
    case 'close': return { kind: 'close' };
    case 'poll': return { kind: 'poll', receipt: receipt(p.receipt, `${path}.receipt`) };
    case 'request': return { kind: 'request', receipt: receipt(p.receipt, `${path}.receipt`), message: frame(p.message, `${path}.message`) };
    default: throw new InvalidField(`${path}.kind`, 'reader packet');
  }
};
const reply: Reader<CarrierReply> = (value, path) => {
  const p = record(value, path);
  if (p.kind === 'reply') return { kind: 'reply', receipt: receipt(p.receipt, `${path}.receipt`), frames: array(frame, 2)(p.frames, `${path}.frames`) };
  if (p.kind !== 'closed') throw new InvalidField(`${path}.kind`, 'source packet');
  if (p.reason === 'registry-closed') return { kind: 'closed', reason: 'registry-closed', connectionReason: registryReason(p.connectionReason, `${path}.connectionReason`) };
  if (p.connectionReason !== null) throw new InvalidField(`${path}.connectionReason`, 'null');
  return { kind: 'closed', reason: closeReason(p.reason, `${path}.reason`), connectionReason: null };
};

function decode<T>(input: unknown, read: Reader<T>): CarrierDecodeResult<T> {
  const fail = (code: Extract<CarrierDecodeResult<T>, { ok: false }>['error']['code'], path: string, message: string): CarrierDecodeResult<T> =>
    ({ ok: false, error: { code, path, message } });
  if (typeof input !== 'string') return fail('invalid-packet', '$', 'Expected JSON text');
  if (input.length > MAX_CARRIER_BYTES || new TextEncoder().encode(input).byteLength > MAX_CARRIER_BYTES) {
    return fail('too-large', '$', 'Carrier packet exceeds the byte limit');
  }
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { return fail('invalid-json', '$', 'Invalid JSON'); }
  try {
    const p = record(value, '$');
    if (p.channel !== CARRIER_CHANNEL) throw new InvalidField('$.channel', 'carrier channel');
    if (p.version !== CARRIER_VERSION) return fail('incompatible-version', '$.version', 'Unsupported carrier version');
    return { ok: true, packet: read(p, '$') };
  } catch (error) {
    if (error instanceof InvalidField) return fail('invalid-packet', error.path, error.message);
    return fail('invalid-packet', '$', 'Invalid carrier packet');
  }
}

function encode<T>(packet: T, read: Reader<T>): string {
  const projected = read(packet, '$');
  const encoded = JSON.stringify({ channel: CARRIER_CHANNEL, version: CARRIER_VERSION, ...projected });
  if (new TextEncoder().encode(encoded).byteLength > MAX_CARRIER_BYTES) throw new Error('Carrier packet exceeds the byte limit');
  return encoded;
}

/** Validate direction and outer bounds before forwarding; inner protocol strings remain opaque. */
export function decodeCarrierRequest(input: unknown): CarrierDecodeResult<CarrierRequest> { return decode(input, request); }
export function decodeCarrierReply(input: unknown): CarrierDecodeResult<CarrierReply> { return decode(input, reply); }
export function encodeCarrierRequest(packet: CarrierRequest): string { return encode(packet, request); }
export function encodeCarrierReply(packet: CarrierReply): string { return encode(packet, reply); }
