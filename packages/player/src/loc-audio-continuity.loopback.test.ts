import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture } from '../test-support/loc-seek.js';
import type { AudioDecoderLike } from './interfaces.js';

beforeEach(() => vi.stubGlobal('document', {
  hidden: false,
  addEventListener() { },
  removeEventListener() { }
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Fixture = Awaited<ReturnType<typeof locSeekFixture>>;

async function setup() {
  const f = await locSeekFixture(18, true, true, {
    audioOnly: true,
    producingOutput: true,
    isLive: true,
    catalogVersion: '1',
    timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0], [5000, [5, 0], 0]]
  });
  await f.player.seek(1000);
  await flush(256);
  expect(f.fetches.map(x => x.name)).toEqual(['audio']);
  const audio = f.audioOutputs[0]!;
  expect(audio).toBeDefined();
  const original = audio.decoder.decode.bind(audio.decoder), pending: Array<Parameters<AudioDecoderLike['decode']>> = [];
  audio.decoder.decode = vi.fn((...args: Parameters<AudioDecoderLike['decode']>) => { pending.push(args); });
  const emit = () => {
    for (const args of pending.splice(0)) original(...args);
  };
  const flushSpy = vi.spyOn(audio.decoder, 'flush');
  return {
    f,
    audio,
    pending,
    emit,
    flushSpy
  };
}

async function page(f: Fixture, index: number, group: bigint, pts: bigint, end = false) {
  const id = f.fetchIds[index]!;
  expect(id).toBeDefined();
  await f.server.acceptFetch(id, {
    endOfTrack: end ? 1 : 0,
    endLocation: {
      group,
      object: 0n
    }
  });
  const stream = await f.server.openFetchStream(id);
  await f.server.sendFetchObject(stream, {
    groupId: group,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
    payload: Uint8Array.of(0xf8, 0xff, 0xfe),
    extensions: encodeLocHeaders({
      timestamp: pts,
      timescale: 1000n
    }, {
      locVersion: 4,
      wireProfile: locWireProfileForDraft(18)
    })
  });
  await f.server.closeFetchStream(stream);
  await flush(1024);
}

it('nonterminal audio group drains without flush and continuation can supply delayed PCM readiness', async () => {
  const h = await setup();
  try {
    await page(h.f, 0, 3n, 1000n);
    expect(h.flushSpy).not.toHaveBeenCalled();
    expect(h.f.seeked).not.toHaveBeenCalled();
    expect(h.audio.output.schedule).not.toHaveBeenCalled();
    expect(h.pending).toHaveLength(1);
    expect(h.f.fetchIds).toHaveLength(2);
    await page(h.f, 1, 4n, 3000n);
    expect(h.pending).toHaveLength(2);
    expect(h.flushSpy).not.toHaveBeenCalled();
    expect(h.f.seeked).not.toHaveBeenCalled();
    h.emit();
    await flush(512);
    expect(h.audio.output.schedule).toHaveBeenCalled();
    const timing = vi.mocked(h.audio.output.schedule).mock.calls[0]![3]!;
    h.audio.head.value = {
      epoch: timing.context.epoch,
      sourceTimestampUs: 1000000n,
      sourceOffsetUs: 0
    };
    h.f.advance(100001);
    await flush(256);
    expect(h.f.seeked).toHaveBeenCalledOnce();
    expect(h.f.errors).toEqual([]);
  }
  finally {
    await h.f.destroy();
  }
});

it('terminal audio input retains native flush and actual PCM gates readiness', async () => {
  const h = await setup();
  try {
    h.flushSpy.mockImplementation(async () => h.emit());
    await page(h.f, 0, 3n, 1000n, true);
    expect(h.flushSpy).toHaveBeenCalled();
    expect(h.audio.output.schedule).toHaveBeenCalled();
    expect(h.f.errors).toEqual([]);
  }
  finally {
    await h.f.destroy();
  }
});

it('cancelling pending audio readiness cannot adopt delayed PCM', async () => {
  const h = await setup();
  try {
    await page(h.f, 0, 3n, 1000n);
    expect(h.f.seeked).not.toHaveBeenCalled();
    await h.f.player.destroy();
    h.emit();
    await flush(512);
    expect(h.f.seeked).not.toHaveBeenCalled();
    expect(h.audio.output.schedule).not.toHaveBeenCalled();
    expect(h.audio.decoder.destroy).toHaveBeenCalledOnce();
  }
  finally {
    await h.f.destroy();
  }
});

it('missing actual PCM expires bounded preparation without adoption or invented schedules', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const h = await setup();
  try {
    await page(h.f, 0, 3n, 1000n);
    expect(h.f.seeked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30001);
    await flush(512);
    expect(h.f.errors.some(error => /timed out/.test(error))).toBe(true);
    expect(h.audio.decoder.destroy).toHaveBeenCalledOnce();
    h.emit();
    await flush(256);
    expect(h.f.seeked).not.toHaveBeenCalled();
    expect(h.audio.output.schedule).not.toHaveBeenCalled();
  }
  finally {
    await h.f.destroy();
  }
});

it('video target preparation retains its decoder flush for delayed target output', async () => {
  const f = await locSeekFixture(18, false, true, {
    producingOutput: true,
    reorderVideoOutput: true,
    isLive: true,
    catalogVersion: '1',
    timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0]]
  });
  try {
    await f.player.seek(1000);
    await flush(256);
    const video = f.outputs[0]!, flushed = vi.spyOn(video.decoder, 'flush');
    const id = f.fetchIds[0]!;
    await f.server.acceptFetch(id, {
      endOfTrack: 0,
      endLocation: {
        group: 4n,
        object: 1n
      }
    });
    const stream = await f.server.openFetchStream(id);
    await f.server.sendFetchObject(stream, {
      groupId: 3n,
      subgroupId: 0n,
      objectId: 0n,
      publisherPriority: 128,
      payload: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
      extensions: encodeLocHeaders({
        timestamp: 1000n,
        timescale: 1000n,
        videoFrameMarking: {
          independent: true,
          startOfFrame: true,
          endOfFrame: true,
          discardable: false,
          baseLayerSync: false,
          temporalId: 0
        }
      }, {
        locVersion: 4,
        wireProfile: locWireProfileForDraft(18)
      })
    });
    await f.server.sendFetchObject(stream, {
      groupId: 4n,
      subgroupId: 0n,
      objectId: 0n,
      publisherPriority: 128,
      payload: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
      extensions: encodeLocHeaders({
        timestamp: 3000n,
        timescale: 1000n,
        videoFrameMarking: {
          independent: true,
          startOfFrame: true,
          endOfFrame: true,
          discardable: false,
          baseLayerSync: false,
          temporalId: 0
        }
      }, {
        locVersion: 4,
        wireProfile: locWireProfileForDraft(18)
      })
    });
    await flush(1024);
    expect(flushed).toHaveBeenCalled();
    expect(video.draw).toHaveBeenCalled();
    expect(f.seeked).toHaveBeenCalledOnce();
    expect(f.errors.join(" | ")).toBe("");
  }
  finally {
    await f.destroy();
  }
});

it('data and FIN before FETCH_OK cannot seed PCM readiness or bypass page admission', async () => {
  const h = await setup();
  try {
    const id = h.f.fetchIds[0]!, stream = await h.f.server.openFetchStream(id);
    await h.f.server.sendFetchObject(stream, {
      groupId: 3n,
      subgroupId: 0n,
      objectId: 0n,
      publisherPriority: 128,
      payload: Uint8Array.of(0xf8, 0xff, 0xfe),
      extensions: encodeLocHeaders({
        timestamp: 1000n,
        timescale: 1000n
      }, {
        locVersion: 4,
        wireProfile: locWireProfileForDraft(18)
      })
    });
    await h.f.server.closeFetchStream(stream);
    await flush(512);
    expect(h.pending).toHaveLength(0);
    expect(h.audio.decoder.decode).not.toHaveBeenCalled();
    expect(h.flushSpy).not.toHaveBeenCalled();
    expect(h.f.seeked).not.toHaveBeenCalled();
    await h.f.server.acceptFetch(id, {
      endOfTrack: 0,
      endLocation: {
        group: 3n,
        object: 0n
      }
    });
    await flush(1024);
    expect(h.pending).toHaveLength(1);
    expect(h.flushSpy).not.toHaveBeenCalled();
    expect(h.f.fetchIds).toHaveLength(2);
    expect(h.f.seeked).not.toHaveBeenCalled();
    expect(h.f.errors).toEqual([]);
  }
  finally {
    await h.f.destroy();
  }
});
