/**
 * SubscriptionManager tests — red/green TDD.
 *
 * Manages media track subscriptions:
 * - Subscribe/unsubscribe via adapter
 * - Route incoming objects to correct PlaybackPipeline
 * - Apply objectTransform between adapter and pipeline
 * - Map track aliases to pipelines
 *
 * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
 * @see draft-ietf-moq-transport-16 §9.2.2.2 (DELIVERY_TIMEOUT)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { SubscriptionManager } from './subscription-manager.js';
import { varint } from '@moqt/transport';
import type { MoqtObject, MoqtObjectData } from '@moqt/transport';
import type { LocHeaders } from '@moqt/loc';
import { encodeLocHeaders } from '@moqt/loc';
import type { LocHeaderOptions } from '@moqt/loc';

/** Create a mock MoqtObjectData. */
function createMockObject(overrides?: Partial<MoqtObjectData>): MoqtObjectData {
  return {
    kind: 'data',
    trackAlias: varint(1),
    groupId: varint(0),
    subgroupId: varint(0),
    objectId: varint(0),
    publisherPriority: 0,
    extensions: new Uint8Array(0),
    payload: new Uint8Array([0x01, 0x02, 0x03]),
    ...overrides,
  };
}

describe('SubscriptionManager', () => {
  it('registers a track alias mapping', () => {
    const mgr = new SubscriptionManager();
    mgr.registerTrack(1n, 'video', 'video');
    expect(mgr.getMediaType(1n)).toBe('video');
  });

  it('routes object to the registered callback', () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    const obj = createMockObject({ trackAlias: varint(1) });
    mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ kind: 'data' }),
      expect.anything(), // LocHeaders
    );
  });

  it('applies objectTransform before routing', () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Transform that modifies payload
    mgr.objectTransform = (obj) => ({
      ...obj,
      payload: new Uint8Array([0xFF]),
    });

    const obj = createMockObject({ trackAlias: varint(1) });
    mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({
        payload: new Uint8Array([0xFF]),
      }),
      expect.anything(),
    );
  });

  it('objectTransform returning null drops the object', () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    mgr.objectTransform = () => null;

    const obj = createMockObject({ trackAlias: varint(1) });
    mgr.routeObject(0n, obj);

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores objects for unknown track aliases', () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.onObject = callback;

    const obj = createMockObject({ trackAlias: varint(99) });
    mgr.routeObject(0n, obj);

    expect(callback).not.toHaveBeenCalled();
  });

  it('unregisterTrack removes the mapping', () => {
    const mgr = new SubscriptionManager();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.unregisterTrack(1n);
    expect(mgr.getMediaType(1n)).toBeUndefined();
  });

  it('tracks active subscription count', () => {
    const mgr = new SubscriptionManager();
    expect(mgr.activeCount).toBe(0);

    mgr.registerTrack(1n, 'video', 'video');
    mgr.registerTrack(2n, 'audio', 'audio');
    expect(mgr.activeCount).toBe(2);

    mgr.unregisterTrack(1n);
    expect(mgr.activeCount).toBe(1);
  });

  it('routes gap objects correctly', () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    const gapObj: MoqtObject = {
      kind: 'gap',
      trackAlias: varint(1),
      groupId: varint(5),
      subgroupId: varint(0),
      objectId: varint(0),
      status: varint(0x3), // END_OF_GROUP
    };
    mgr.routeObject(0n, gapObj);

    expect(callback).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ kind: 'gap' }),
      expect.anything(),
    );
  });

  // ─── Malformed track detection (§2.4.2) ─────────────────────────

  it('triggers onMalformedTrack on corrupted LOC extensions (§2.4.2)', async () => {
    // §2.4.2: "When a subscriber detects a Malformed Track, it MUST
    // UNSUBSCRIBE [...] and SHOULD deliver an error to the application."
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onMalformedTrack = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = onObject;
    mgr.onMalformedTrack = onMalformedTrack;

    // Corrupted extension bytes — parseLocHeaders will throw
    const obj = createMockObject({
      trackAlias: varint(1),
      extensions: new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    });
    await mgr.routeObject(0n, obj);

    // Spec-correct: malformed track triggered, object NOT routed
    expect(onMalformedTrack).toHaveBeenCalledWith(
      1n,
      'video',
      'video',
      expect.any(Error),
    );
    expect(onObject).not.toHaveBeenCalled();
  });

  it('uses custom extensionParser when set (non-LOC relay interop)', async () => {
    // extensionParser hook: clean separation for non-LOC packaging formats
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = onObject;

    // Custom parser that always returns a fixed timestamp
    mgr.extensionParser = () => ({ captureTimestamp: 42n });

    const obj = createMockObject({
      trackAlias: varint(1),
      extensions: new Uint8Array([0xFF, 0xFF]), // Would fail LOC parsing
    });
    await mgr.routeObject(0n, obj);

    expect(onObject).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ kind: 'data' }),
      expect.objectContaining({ captureTimestamp: 42n }),
    );
  });

  it('does not call onMalformedTrack for valid objects', () => {
    const mgr = new SubscriptionManager();
    const onMalformedTrack = vi.fn();
    const onObject = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = onObject;
    mgr.onMalformedTrack = onMalformedTrack;

    const extensions = encodeLocHeaders({ captureTimestamp: 1000n });
    const obj = createMockObject({
      trackAlias: varint(1),
      extensions,
    });
    mgr.routeObject(0n, obj);

    expect(onMalformedTrack).not.toHaveBeenCalled();
    expect(onObject).toHaveBeenCalled();
  });

  it('calls onMalformedTrack when objectTransform throws (§2.4.2)', () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onMalformedTrack = vi.fn();
    mgr.registerTrack(1n, 'audio', 'audio');
    mgr.onObject = onObject;
    mgr.onMalformedTrack = onMalformedTrack;

    // Transform that throws (e.g., SFrame decryption failure)
    mgr.objectTransform = () => { throw new Error('Decryption failed'); };

    const obj = createMockObject({ trackAlias: varint(1) });
    mgr.routeObject(0n, obj);

    expect(onMalformedTrack).toHaveBeenCalledWith(
      1n,
      'audio',
      'audio',
      expect.any(Error),
    );
    expect(onObject).not.toHaveBeenCalled();
  });

  // ─── Async objectTransform support (Secure Objects / E2EE) ──────

  it('supports async objectTransform (Promise-returning)', async () => {
    // draft-jennings-moq-secure-objects-03: crypto.subtle.decrypt() is async
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Async transform that modifies payload
    mgr.objectTransform = async (obj) => ({
      ...obj,
      payload: new Uint8Array([0xDE, 0xAD]),
    });

    const obj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ payload: new Uint8Array([0xDE, 0xAD]) }),
      expect.anything(),
    );
  });

  it('async objectTransform returning null drops the object', async () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    mgr.objectTransform = async () => null;

    const obj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, obj);

    expect(callback).not.toHaveBeenCalled();
  });

  it('async objectTransform rejection triggers onMalformedTrack (§2.4.2)', async () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onMalformedTrack = vi.fn();
    mgr.registerTrack(1n, 'audio', 'audio');
    mgr.onObject = onObject;
    mgr.onMalformedTrack = onMalformedTrack;

    mgr.objectTransform = async () => { throw new Error('Async decryption failed'); };

    const obj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, obj);

    expect(onMalformedTrack).toHaveBeenCalledWith(
      1n,
      'audio',
      'audio',
      expect.any(Error),
    );
    expect(onObject).not.toHaveBeenCalled();
  });

  it('sync objectTransform still works after making routeObject async', async () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Plain sync transform — backward compat
    mgr.objectTransform = (obj) => ({
      ...obj,
      payload: new Uint8Array([0x42]),
    });

    const obj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ payload: new Uint8Array([0x42]) }),
      expect.anything(),
    );
  });

  it('parseLocHeaders is called for data objects with extensions', () => {
    const mgr = new SubscriptionManager();
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Object with correctly encoded LOC extensions
    const extensions = encodeLocHeaders({ captureTimestamp: 1000n });
    const obj = createMockObject({
      trackAlias: varint(1),
      extensions,
    });
    mgr.routeObject(0n, obj);

    // Callback should receive parsed LocHeaders
    expect(callback).toHaveBeenCalled();
    const headers: LocHeaders = callback.mock.calls[0]![3];
    expect(headers.captureTimestamp).toBe(1000n);
  });

  // ─── CMAF packaging routing (draft-ietf-moq-cmsf-00 §3.3) ────────

  it('routes CMAF objects to onCmafObject, skipping LOC header parsing (§3.3)', async () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onCmafObject = vi.fn();
    mgr.registerTrack(1n, 'video', 'video', 'cmaf');
    mgr.onObject = onObject;
    mgr.onCmafObject = onCmafObject;

    const obj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, obj);

    // CMAF path: onCmafObject called, NOT onObject
    expect(onCmafObject).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ kind: 'data' }),
    );
    expect(onObject).not.toHaveBeenCalled();
  });

  it('LOC tracks still route to onObject when CMAF tracks exist (backward compat)', async () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onCmafObject = vi.fn();
    mgr.onObject = onObject;
    mgr.onCmafObject = onCmafObject;

    // Register both LOC and CMAF tracks
    mgr.registerTrack(1n, 'video-loc', 'video', 'loc');
    mgr.registerTrack(2n, 'video-cmaf', 'video', 'cmaf');

    // Route LOC object
    const locObj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, locObj);

    expect(onObject).toHaveBeenCalledWith(
      'video',
      'video-loc',
      expect.objectContaining({ kind: 'data' }),
      expect.anything(),
    );
    expect(onCmafObject).not.toHaveBeenCalled();
  });

  it('mixed LOC + CMAF tracks route to correct callbacks', async () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onCmafObject = vi.fn();
    mgr.onObject = onObject;
    mgr.onCmafObject = onCmafObject;

    mgr.registerTrack(1n, 'video-loc', 'video', 'loc');
    mgr.registerTrack(2n, 'audio-cmaf', 'audio', 'cmaf');

    // Route to LOC video track
    await mgr.routeObject(0n, createMockObject({ trackAlias: varint(1) }));
    // Route to CMAF audio track
    await mgr.routeObject(0n, createMockObject({ trackAlias: varint(2) }));

    expect(onObject).toHaveBeenCalledTimes(1);
    expect(onObject).toHaveBeenCalledWith('video', 'video-loc', expect.anything(), expect.anything());
    expect(onCmafObject).toHaveBeenCalledTimes(1);
    expect(onCmafObject).toHaveBeenCalledWith('audio', 'audio-cmaf', expect.anything());
  });

  it('objectTransform applies to CMAF objects before routing', async () => {
    const mgr = new SubscriptionManager();
    const onCmafObject = vi.fn();
    mgr.registerTrack(1n, 'video', 'video', 'cmaf');
    mgr.onCmafObject = onCmafObject;

    mgr.objectTransform = (obj) => ({
      ...obj,
      payload: new Uint8Array([0xCA, 0xFE]),
    });

    await mgr.routeObject(0n, createMockObject({ trackAlias: varint(1) }));

    expect(onCmafObject).toHaveBeenCalledWith(
      'video',
      'video',
      expect.objectContaining({ payload: new Uint8Array([0xCA, 0xFE]) }),
    );
  });

  it('objectTransform returning null drops CMAF objects', async () => {
    const mgr = new SubscriptionManager();
    const onCmafObject = vi.fn();
    mgr.registerTrack(1n, 'video', 'video', 'cmaf');
    mgr.onCmafObject = onCmafObject;

    mgr.objectTransform = () => null;

    await mgr.routeObject(0n, createMockObject({ trackAlias: varint(1) }));

    expect(onCmafObject).not.toHaveBeenCalled();
  });

  it('registerTrack defaults to LOC packaging when not specified', () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onCmafObject = vi.fn();
    mgr.onObject = onObject;
    mgr.onCmafObject = onCmafObject;

    // No packaging parameter — should default to 'loc'
    mgr.registerTrack(1n, 'video', 'video');

    mgr.routeObject(0n, createMockObject({ trackAlias: varint(1) }));

    expect(onObject).toHaveBeenCalled();
    expect(onCmafObject).not.toHaveBeenCalled();
  });

  // ─── Mediatimeline packaging routing (draft-ietf-moq-msf-00 §7) ────

  it('routes mediatimeline objects to onTimelineObject callback (§7)', async () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onTimelineObject = vi.fn();
    mgr.registerTrack(1n, 'timeline', 'mediatimeline', 'mediatimeline');
    mgr.onObject = onObject;
    mgr.onTimelineObject = onTimelineObject;

    const payload = new TextEncoder().encode('[[0,[0,0],0]]');
    const obj = createMockObject({ trackAlias: varint(1), payload });
    await mgr.routeObject(0n, obj);

    // Timeline path: onTimelineObject called, NOT onObject
    expect(onTimelineObject).toHaveBeenCalledWith(
      'timeline',
      expect.objectContaining({ kind: 'data', payload }),
    );
    expect(onObject).not.toHaveBeenCalled();
  });

  it('does not attempt LOC parsing for mediatimeline objects (§7)', async () => {
    const mgr = new SubscriptionManager();
    const onTimelineObject = vi.fn();
    mgr.registerTrack(1n, 'timeline', 'mediatimeline', 'mediatimeline');
    mgr.onTimelineObject = onTimelineObject;

    // No extensions — LOC parsing would throw on empty, but timeline skips it
    const obj = createMockObject({
      trackAlias: varint(1),
      extensions: new Uint8Array(0),
      payload: new TextEncoder().encode('[]'),
    });
    await mgr.routeObject(0n, obj);

    // Should route successfully without LOC header parsing errors
    expect(onTimelineObject).toHaveBeenCalled();
  });

  it('mediatimeline objects bypass objectTransform (no E2EE on metadata) (§7)', async () => {
    const mgr = new SubscriptionManager();
    const onTimelineObject = vi.fn();
    const transformFn = vi.fn();
    mgr.registerTrack(1n, 'timeline', 'mediatimeline', 'mediatimeline');
    mgr.onTimelineObject = onTimelineObject;
    mgr.objectTransform = transformFn;

    const payload = new TextEncoder().encode('[[0,[0,0],0]]');
    const obj = createMockObject({ trackAlias: varint(1), payload });
    await mgr.routeObject(0n, obj);

    // objectTransform should NOT be called for timeline tracks
    expect(transformFn).not.toHaveBeenCalled();
    expect(onTimelineObject).toHaveBeenCalled();
  });

  // ─── Init track packaging routing (draft-ietf-moq-cmsf-00 §3.1) ────

  it('routes init-packaged objects to onInitObject callback (§3.1)', async () => {
    const mgr = new SubscriptionManager();
    const onObject = vi.fn();
    const onCmafObject = vi.fn();
    const onInitObject = vi.fn();
    mgr.registerTrack(1n, '0.mp4', 'video', 'init');
    mgr.onObject = onObject;
    mgr.onCmafObject = onCmafObject;
    mgr.onInitObject = onInitObject;

    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x1C]); // ftyp box fragment
    const obj = createMockObject({ trackAlias: varint(1), payload });
    await mgr.routeObject(0n, obj);

    // Init path: onInitObject called, NOT onObject or onCmafObject
    expect(onInitObject).toHaveBeenCalledWith(
      '0.mp4',
      expect.objectContaining({ kind: 'data', payload }),
    );
    expect(onObject).not.toHaveBeenCalled();
    expect(onCmafObject).not.toHaveBeenCalled();
  });

  it('init track objects bypass objectTransform (metadata, not media)', async () => {
    const mgr = new SubscriptionManager();
    const onInitObject = vi.fn();
    const transformFn = vi.fn();
    mgr.registerTrack(1n, '0.mp4', 'video', 'init');
    mgr.onInitObject = onInitObject;
    mgr.objectTransform = transformFn;

    const obj = createMockObject({ trackAlias: varint(1) });
    await mgr.routeObject(0n, obj);

    // objectTransform should NOT be called for init tracks
    expect(transformFn).not.toHaveBeenCalled();
    expect(onInitObject).toHaveBeenCalled();
  });

  it('onMalformedTrack fires for CMAF tracks when transform throws (§2.4.2)', async () => {
    const mgr = new SubscriptionManager();
    const onCmafObject = vi.fn();
    const onMalformedTrack = vi.fn();
    mgr.registerTrack(1n, 'video', 'video', 'cmaf');
    mgr.onCmafObject = onCmafObject;
    mgr.onMalformedTrack = onMalformedTrack;

    mgr.objectTransform = () => { throw new Error('CMAF transform error'); };

    await mgr.routeObject(0n, createMockObject({ trackAlias: varint(1) }));

    expect(onMalformedTrack).toHaveBeenCalledWith(
      1n,
      'video',
      'video',
      expect.any(Error),
    );
    expect(onCmafObject).not.toHaveBeenCalled();
  });

  // ─── Draft-14 absolute KVP encoding (draft-ietf-moq-transport-14 §1.4.2) ──

  it('uses absolute type IDs when draftVersion is 14', async () => {
    const mgr = new SubscriptionManager();
    mgr.draftVersion = 14;
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Encode with absolute type IDs (draft-14)
    const extensions = encodeLocHeaders(
      { captureTimestamp: 42n, audioLevel: { voiceActivity: true, level: 30 } },
      { deltaEncoded: false },
    );
    const obj = createMockObject({ trackAlias: varint(1), extensions });
    await mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalled();
    const headers: LocHeaders = callback.mock.calls[0]![3];
    // With absolute encoding, both extensions should be correctly parsed
    expect(headers.captureTimestamp).toBe(42n);
    expect(headers.audioLevel).toBeDefined();
    expect(headers.audioLevel!.voiceActivity).toBe(true);
    expect(headers.audioLevel!.level).toBe(30);
  });

  it('uses delta type IDs by default (draft-16)', async () => {
    const mgr = new SubscriptionManager();
    // draftVersion not set — defaults to draft-16 delta encoding
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Encode with delta type IDs (draft-16 default)
    const extensions = encodeLocHeaders(
      { captureTimestamp: 42n, audioLevel: { voiceActivity: true, level: 30 } },
    );
    const obj = createMockObject({ trackAlias: varint(1), extensions });
    await mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalled();
    const headers: LocHeaders = callback.mock.calls[0]![3];
    expect(headers.captureTimestamp).toBe(42n);
    expect(headers.audioLevel).toBeDefined();
    expect(headers.audioLevel!.level).toBe(30);
  });

  it('draft-14 absolute encoding misparses under delta decoder (demonstrates the bug)', async () => {
    const mgr = new SubscriptionManager();
    // NO draftVersion set — defaults to delta decoding
    const callback = vi.fn();
    mgr.registerTrack(1n, 'video', 'video');
    mgr.onObject = callback;

    // Encode with absolute type IDs (as draft-14 server would send)
    const extensions = encodeLocHeaders(
      { captureTimestamp: 42n, videoFrameMarking: {
        startOfFrame: true, endOfFrame: true, independent: true,
        discardable: false, baseLayerSync: false, temporalId: 0,
      }},
      { deltaEncoded: false },
    );
    const obj = createMockObject({ trackAlias: varint(1), extensions });
    await mgr.routeObject(0n, obj);

    expect(callback).toHaveBeenCalled();
    const headers: LocHeaders = callback.mock.calls[0]![3];
    // BUG: Without version awareness, delta decoder misreads absolute type=4
    // as delta=4, resolving to type 2+4=6 (AudioLevel) instead of 4 (VideoFrameMarking)
    expect(headers.videoFrameMarking).toBeUndefined(); // wrong!
    expect(headers.audioLevel).toBeDefined(); // misidentified!
  });
});
