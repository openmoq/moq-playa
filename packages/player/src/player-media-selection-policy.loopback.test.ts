import { expect, it } from 'vitest';
import { mediaSelectionFixture, mediaRefs } from '../test-support/media-selection.js';

it.each([true, false])('adopts a current-video pin without another subscription: pin=%s', async pin => {
  const f = await mediaSelectionFixture(18, { automaticVideo: true });
  try {
    expect(f.player.selection.autoQuality).toBe(true);
    const before = f.player.selection, requests = f.wire.requests.length, changes = f.selections.length;
    await f.player.selectMedia(pin ? { videoTrack: mediaRefs.oldVideo } : { videoAltGroup: 11 });
    expect(f.player.selection.autoQuality).toBe(!pin);
    expect(f.player.selection.video).toEqual(before.video); expect(f.player.selection.audio).toEqual(before.audio);
    expect(f.wire.requests).toHaveLength(requests); expect(f.wire.stopped).toEqual([]);
    expect(f.player.selection.revision).toBe(before.revision + (pin ? 1 : 0));
    expect(f.selections).toHaveLength(changes + (pin ? 1 : 0)); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});
