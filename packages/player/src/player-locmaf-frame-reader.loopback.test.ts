import { expect, it, vi } from 'vitest';
import { serializeLocmafObject } from '@openmoq/locmaf';
import type { MoqtObject } from '@openmoq/transport';
import type { PlaybackPipeline } from '@openmoq/playback';
import type { SubscriptionManager } from './subscription-manager.js';
import type { MoqtPlayer } from './player.js';
import { buildChunk, buildInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { concat } from '../../locmaf/test-support/bytes.js';
import { fixture, sequence } from '../test-support/locmaf-replay.js';

type Owner = {videoPipeline: PlaybackPipeline; subscriptionManager: SubscriptionManager;
  mediaKey(name:string,role:string,alias:bigint):string; initSegmentByTrack:Map<string,Uint8Array>};
const ownerOf = (player: MoqtPlayer) => player as unknown as Owner;
it('one real multi-chunk carrier keeps its wire Object identity, bytes and Location through sample admission', async () => {
  const h = await fixture(true), owner = ownerOf(h.player), push = vi.spyOn(owner.videoPipeline,'pushSampleObject');
  const wire: MoqtObject[] = [], receipts: {id:bigint; payload:Uint8Array|undefined}[] = [];
  try {
    owner.subscriptionManager.objectTransform = object => { wire.push(object); return object; };
    h.player.on('media_object', event => { if (event.mediaType === 'video') receipts.push({id:event.objectId,payload:event.payload}); });
    const chunk = (bmdt:number) => buildChunk({trackId:11,bmdt,samples:[
      {duration:3000,size:4,flags:SYNC_FLAGS},{duration:3000,size:4,flags:NON_SYNC_FLAGS}],mdat:Uint8Array.of(5,2,3,4,1,2,3,4)});
    const payload = serializeLocmafObject({kind:'rawBoxes',boxes:concat(chunk(90000),chunk(96000))});
    const before = h.player.stats.bytesReceived;
    await h.send('video',37n,payload,7n);
    expect(wire).toHaveLength(1); expect(push).toHaveBeenCalledOnce();
    const [object,samples] = push.mock.calls[0]!;
    expect(object).toBe(wire[0]); expect(object).toMatchObject({groupId:7n,objectId:37n,payload});
    expect(receipts).toEqual([{id:37n,payload}]);
    expect(h.player.stats.bytesReceived - before).toBe(payload.byteLength);
    expect(samples.map(sample=>sample.sampleIndex)).toEqual([0,1,2,3]);
    expect(samples.map(sample=>sample.chunk.sourceTimestamp?.ticks)).toEqual([90000n,93000n,96000n,99000n]);
    expect(samples.map(sample=>sample.chunk.type)).toEqual(['key','delta','key','delta']);
    expect(owner.videoPipeline.bufferedGroupCount).toBe(1);
    expect(h.errors).toEqual([]);
  } finally { owner.subscriptionManager.objectTransform = null; push.mockRestore(); await h.destroy(); }
});

it('real replay on one alias leaves the next delta reference usable', async () => {
  const h = await fixture(true), owner = ownerOf(h.player), push = vi.spyOn(owner.videoPipeline,'pushSampleObject');
  try {
    const [full,delta] = sequence('video');
    await h.send('video',0n,full!.payload);
    const second = await h.registerSecondAlias(); await second(0n,full!.payload);
    await h.send('video',1n,delta!.payload);
    expect(push.mock.calls.map(([object])=>BigInt(object.objectId))).toEqual([0n,1n]);
    expect(push.mock.calls[1]?.[1]).toHaveLength(1); expect(h.errors).toEqual([]);
  } finally { push.mockRestore(); await h.destroy(); }
});

it('real failed future delta from a shared consumer alias cannot prevent a lower successful full header', async () => {
  const h = await fixture(true), owner = ownerOf(h.player), push = vi.spyOn(owner.videoPipeline,'pushSampleObject');
  try {
    const [full,delta] = sequence('video');
    await h.send('video',0n,full!.payload);
    const second = await h.registerSecondAlias(); await second(99n,delta!.payload);
    expect(push.mock.calls.map(([object])=>BigInt(object.objectId))).toEqual([0n]);
    await h.send('video',1n,full!.payload);
    expect(push.mock.calls.map(([object])=>BigInt(object.objectId))).toEqual([0n,1n]); expect(h.errors).toEqual([]);
  } finally { push.mockRestore(); await h.destroy(); }
});

it('a validated replacement Header retires held old-epoch work even when its media fails validation', async () => {
  const h = await fixture(true), owner = ownerOf(h.player), push = vi.spyOn(owner.videoPipeline,'pushSampleObject');
  const reset = vi.spyOn(owner.videoPipeline,'resetForTrackSwitch');
  let release!: () => void; const gate = new Promise<void>(resolve => {release=resolve;});
  try {
    const [full] = sequence('video'); await h.send('video',0n,full!.payload,1n);
    const second = await h.registerSecondAlias(); let held=false;
    owner.subscriptionManager.objectTransform = async object => {
      if(object.trackAlias===202n){held=true;await gate;}return object;
    };
    await second(0n,full!.payload,2n); expect(held).toBe(true); push.mockClear();
    const header = buildInit({trackId:11,timescale:180000,handler:'vide',trex:{duration:3000,flags:SYNC_FLAGS}});
    const foreign = buildChunk({trackId:99,bmdt:180000,samples:[{duration:3000,size:4,flags:SYNC_FLAGS}],mdat:Uint8Array.of(5,2,3,4)});
    await h.send('video',0n,serializeLocmafObject({kind:'rawBoxes',boxes:concat(header,foreign)}),3n);
    expect(push).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledExactlyOnceWith(3n);
    expect(owner.videoPipeline.bufferedGroupCount).toBe(0);
    expect(owner.initSegmentByTrack.get(owner.mediaKey('shared','video',200n))).toEqual(header);
    release(); await flush(256); owner.subscriptionManager.objectTransform=null;
    expect(push,'old accepted metadata must not seed a replacement Header epoch').not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  } finally {release();owner.subscriptionManager.objectTransform=null;push.mockRestore();reset.mockRestore();await h.destroy();}
});
