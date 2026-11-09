/** Real selected wire warmup; private boolean decision guard, not an issued switch transaction. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BufferBasedController } from '@openmoq/playback';
import { fixture, readRate } from '../test-support/received-payload-fixture.js';
beforeEach(() => vi.useFakeTimers());afterEach(() => vi.useRealTimers());
async function warmGuarded() {
  const f=await fixture('cmaf',true);
  const owner=f.player as unknown as {switchInProgress:boolean;bufferAbrController:BufferBasedController|null};
  try {
    await f.accept();expect(owner.bufferAbrController,'real two-rung catalog installed ABR controller').not.toBeNull();
    if(!owner.bufferAbrController)throw new Error('Fixture expected ABR controller');
    owner.switchInProgress=true;
    for(let i=0;i<251;i++){f.setNow(1_000_000+i*40_000);await f.send(i,20_000);f.player.tick();}
    expect(f.receipts).toHaveLength(251);expect(f.appended).toHaveLength(251);expect(readRate(f.player)).toBeCloseTo(4000,1);
    expect(f.requests).toHaveLength(1);expect(f.player.selection.video?.name).toBe('v');
    const evaluate=vi.spyOn(owner.bufferAbrController,'evaluate');
    return {...f,owner,evaluate};
  }catch(error){owner.switchInProgress=false;await f.close();throw error;}
}
it('ordinary ticks observe silence while a controlled switchInProgress guard suppresses ABR decisions',async()=>{
  const f=await warmGuarded();
  try{
    // No intermediate read: only the actual player.tick can advance these six observations.
    for(let i=1;i<=6;i++){f.setNow(11_000_000+i*1_000_000);f.player.tick();}
    expect(f.evaluate).not.toHaveBeenCalled();expect(f.requests).toHaveLength(1);
    expect(readRate(f.player),'observed silence decays, rather than becoming an unobserved >5s gap').toBeCloseTo(4000*0.7**6,6);
    expect(f.receipts).toHaveLength(251);expect(f.errors).toEqual([]);expect(f.transportErrors).toEqual([]);
  }finally{f.evaluate.mockRestore();f.owner.switchInProgress=false;await f.close();}
});
it('six seconds without ticks or payload remains an unobserved gap, even with the same controlled guard',async()=>{
  const f=await warmGuarded();
  try{
    f.setNow(17_000_000);
    expect(f.evaluate).not.toHaveBeenCalled();expect(readRate(f.player)).toBeNull();
    expect(f.receipts).toHaveLength(251);expect(f.requests).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{f.evaluate.mockRestore();f.owner.switchInProgress=false;await f.close();}
});
