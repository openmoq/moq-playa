import { expect, it } from 'vitest';
import { createTimelineState, findEncodeAnchor, processTimelineObject } from './timeline-manager.js';
import type { CatalogTrack } from '@openmoq/msf';
const state=()=>createTimelineState({name:'timeline',packaging:'mediatimeline',isLive:true,depends:['video']} as CatalogTrack);
it('exact locations keep bigint identity; unsafe JSON locations cannot alias a nearby object',()=>{
 const s=processTimelineObject(state(),new TextEncoder().encode('[[1000,[9007199254740993,0],1759924160000]]'));
 expect(findEncodeAnchor(s,9007199254740992n,0n)).toBeUndefined();
 expect(findEncodeAnchor(s,9007199254740993n,0n)).toBeUndefined();
});
it.each([0,-1,Infinity,NaN])('unknown or invalid encoded wallclock %s supplies no anchor',wallclockTime=>{
 const s=state();s.entries=[{mediaPts:1000,location:[1,0],wallclockTime}];expect(findEncodeAnchor(s,1n,0n)).toBeUndefined();
});
it('invalid PTS and duplicate exact entries supply no anchor',()=>{
 const s=state();s.entries=[{mediaPts:Infinity,location:[1,0],wallclockTime:1000}];expect(findEncodeAnchor(s,1n,0n)).toBeUndefined();
 s.entries=[{mediaPts:1,location:[1,0],wallclockTime:1000},{mediaPts:2,location:[1,0],wallclockTime:1100}];expect(findEncodeAnchor(s,1n,0n)).toBeUndefined();
});
