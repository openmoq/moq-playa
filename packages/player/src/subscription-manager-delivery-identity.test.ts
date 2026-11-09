import { expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { SubscriptionManager, type ObjectDeliveryOptions, type ObjectDeliveryAdmission } from './subscription-manager.js';
const object = (id = 0n): MoqtObject => ({kind:'data',trackAlias:varint(1n),groupId:varint(0n),subgroupId:varint(0n),objectId:varint(id),publisherPriority:128,payload:Uint8Array.of(1),extensions:undefined});

it('exact initiating wrapper preserves only itself even when nested routes share the original delivery options', async () => {
  const m=new SubscriptionManager();m.registerTrack(1n,'video','video','locmaf');
  let policy=true, sourceLive=true;
  m.routeStillValid=()=>sourceLive;
  const original={isLive:()=>policy,backfill:true};
  let first: ObjectDeliveryOptions | undefined, second: ObjectDeliveryOptions | undefined;
  let nested: Promise<void> | undefined;
  m.onLocmafObject=(_type,_name,obj,_input,delivery)=>{
    expect(delivery).toBeDefined();expect(delivery).not.toBe(original);
    expect(delivery?.backfill).toBe(true);
    if(obj.objectId===0n){first=delivery;nested=m.routeObject(2n,object(1n),18,{},undefined,original);}
    else {second=delivery;expect(second).not.toBe(first);m.resetMediaConsumer(1n,0n,second);expect(second?.isLive?.()).toBe(true);}
  };
  await m.routeObject(1n,object(),18,{},undefined,original);await nested;
  expect(first?.isLive?.()).toBe(false);expect(second?.isLive?.()).toBe(true);
  policy=false;expect(second?.isLive?.()).toBe(false);policy=true;
  sourceLive=false;expect(second?.isLive?.()).toBe(false);sourceLive=true;
  expect(second?.isLive?.()).toBe(true);
  m.unregisterTrack(1n);m.registerTrack(1n,'video','video','locmaf');
  expect(second?.isLive?.()).toBe(false);
});

it('retired deferred admission still owns its terminal barrier and cannot be preserved by unrelated delivery identity', async () => {
  const m=new SubscriptionManager();m.registerTrack(1n,'video','video','locmaf');
  let admit!: (a:ObjectDeliveryAdmission)=>void;
  const admission=new Promise<ObjectDeliveryAdmission>(resolve=>{admit=resolve;});
  const delivered=vi.fn();m.onLocmafObject=delivered;
  const registration=m.captureRoute(1n),idle=m.captureTrackIdle(1n);
  const pending=m.routeObject(1n,object(),18,{},undefined,{admission});
  const drained=vi.fn();const barrier=idle()?.then(drained);
  m.resetMediaConsumer(1n,0n,{isLive:()=>true});
  await Promise.resolve();expect(registration?.()).toBe(true);expect(drained).not.toHaveBeenCalled();
  admit({kind:'deliver',backfill:false,isLive:()=>true});await pending;await barrier;
  expect(delivered).not.toHaveBeenCalled();expect(drained).toHaveBeenCalledOnce();
});

it('preserves distinct prepared-input identities through deferred admission and LOCMAF liveness wrappers', async () => {
  const manager = new SubscriptionManager();
  manager.registerTrack(1n, 'video', 'video', 'locmaf');
  const inputs = [object(0n), object(1n)];
  const identities = [{}, {}];
  const originalPolicy = () => true;
  let admittedLive = true;
  const admittedPolicy = () => admittedLive;
  // Both routes receive the same admission result and policy. Neither is an
  // input identity, and completion order must not decide which owner survives.
  const accepted: ObjectDeliveryAdmission = { kind: 'deliver', isLive: admittedPolicy, backfill: true };
  const releases: Array<(result: ObjectDeliveryAdmission) => void> = [];
  const received: Array<{ input: MoqtObject; delivery: ObjectDeliveryOptions | undefined }> = [];
  manager.onLocmafObject = (_type, _name, input, _context, delivery) => {
    received.push({ input, delivery });
  };
  const pending = inputs.map((input, index) => {
    const admission = new Promise<ObjectDeliveryAdmission>(resolve => { releases.push(resolve); });
    return manager.routeObject(BigInt(index), input, 18, undefined, undefined,
      { admission, isLive: originalPolicy, identity: identities[index]! });
  });
  expect(received).toHaveLength(0);
  releases[1]!(accepted); await pending[1];
  expect(received).toHaveLength(1);
  expect(received[0]!.input).toBe(inputs[1]);
  expect(received[0]!.delivery?.identity).toBe(identities[1]);
  releases[0]!(accepted); await pending[0];
  expect(received).toHaveLength(2);
  expect(received[1]!.input).toBe(inputs[0]);
  expect(received[1]!.delivery?.identity).toBe(identities[0]);
  expect(received[0]!.delivery?.identity).not.toBe(received[1]!.delivery?.identity);
  expect(received[0]!.delivery).not.toBe(received[1]!.delivery);
  for (const { delivery } of received) {
    expect(delivery).not.toBe(accepted);
    expect(delivery?.backfill).toBe(true);
    expect(delivery?.isLive).not.toBe(originalPolicy);
    expect(delivery?.isLive).not.toBe(admittedPolicy);
    expect(delivery?.isLive?.()).toBe(true);
  }
  admittedLive = false;
  for (const { delivery } of received) expect(delivery?.isLive?.()).toBe(false);
  admittedLive = true;
  for (const { delivery } of received) expect(delivery?.isLive?.()).toBe(true);
  manager.invalidateMediaInputs();
  for (const { delivery } of received) expect(delivery?.isLive?.()).toBe(false);
});
