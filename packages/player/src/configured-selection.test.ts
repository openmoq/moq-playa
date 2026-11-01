import { describe, expect, it } from 'vitest';
import type { MoqtPlayerConfig } from './config.js';
import { selectionIntentFromConfig } from './configured-selection.js';

const base: MoqtPlayerConfig = { url: 'https://relay.example/moq', namespace: 'live/show' };

describe('selectionIntentFromConfig', () => {
  it('leaves omitted selectors to the composition defaults', () => {
    expect(selectionIntentFromConfig(base)).toBeUndefined();
    expect(selectionIntentFromConfig({ ...base, selection: {} })).toBeUndefined();
  });

  it.each([
    [0, { kind: 'render-group', renderGroup: 0 }],
    [null, { kind: 'unassigned' }],
  ] as const)('preserves render scope %s', (renderGroup, scope) => {
    expect(selectionIntentFromConfig({ ...base, selection: { renderGroup } })).toEqual({ scope });
  });

  it('keeps group zero and the legacy video group alias', () => {
    expect(selectionIntentFromConfig({ ...base, videoAltGroup: 0 })).toEqual({ videoAltGroup: 0 });
    expect(selectionIntentFromConfig({ ...base, selection: { videoAltGroup: 0, audioAltGroup: 0 } }))
      .toEqual({ videoAltGroup: 0, audioAltGroup: 0 });
  });

  it('resolves omitted reference namespaces from the configured tuple', () => {
    expect(selectionIntentFromConfig({ ...base, namespace: ['live/show'], selection: {
      videoTrack: { name: 'video' }, audioTrack: { name: 'audio' },
    } })).toEqual({
      videoTrack: { namespaceFields: ['live/show'], name: 'video' },
      audioTrack: { namespaceFields: ['live/show'], name: 'audio' },
    });
  });

  it('distinguishes an explicit text namespace from a one-field namespace tuple', () => {
    expect(selectionIntentFromConfig({ ...base, selection: {
      videoTrack: { name: 'same', namespace: 'other/show' },
      audioTrack: { name: 'same', namespace: ['other/show'] },
    } })).toEqual({
      videoTrack: { namespaceFields: ['other', 'show'], name: 'same' },
      audioTrack: { namespaceFields: ['other/show'], name: 'same' },
    });
  });

  it.each(['video', 'audio'] as const)('ignores selectors for disabled %s while keeping scope and the other output', role => {
    const intent = selectionIntentFromConfig({ ...base, disableVideo: role === 'video', disableAudio: role === 'audio',
      selection: { renderGroup: 0, videoAltGroup: 0, audioAltGroup: 0,
        videoTrack: { name: 'v' }, audioTrack: { name: 'a' } },
    });
    expect(intent?.scope).toEqual({ kind: 'render-group', renderGroup: 0 });
    expect(intent?.[`${role}Track`]).toBeUndefined();
    expect(intent?.[`${role}AltGroup`]).toBeUndefined();
    expect(intent?.[role === 'video' ? 'disableVideo' : 'disableAudio']).toBe(true);
    expect(intent?.[role === 'video' ? 'audioTrack' : 'videoTrack']).toEqual({
      name: role === 'video' ? 'a' : 'v', namespaceFields: ['live', 'show'],
    });
  });

  it('preserves frozen configuration and copies namespace tuples', () => {
    const namespace = Object.freeze(['live/show']);
    const referenceNamespace = Object.freeze(['other/show']);
    const config = Object.freeze({ ...base, namespace, selection: Object.freeze({
      videoTrack: Object.freeze({ name: 'v', namespace: referenceNamespace }),
      audioTrack: Object.freeze({ name: 'a' }),
    }) });
    const snapshot = structuredClone(config);
    const intent = selectionIntentFromConfig(config);
    expect(config).toEqual(snapshot);
    expect(intent?.videoTrack?.namespaceFields).toEqual(referenceNamespace);
    expect(intent?.videoTrack?.namespaceFields).not.toBe(referenceNamespace);
    expect(intent?.audioTrack?.namespaceFields).toEqual(namespace);
    expect(intent?.audioTrack?.namespaceFields).not.toBe(namespace);
  });
});
