interface Item { seq: number; alias: string; group: string; object: string }
interface Received extends Item { source: 'prefix' | 'live'; request: string | null }
interface PeerEvent { receiverAcknowledged?: number; type: string; request?: string; joining?: string | null; alias?: string; name?: string; group?: string | null; object?: string | null }
export function assessWarmStart(observed: { received: Received[]; processed: Item[] }, peer: { events: PeerEvent[]; errors: string[] }, enabled: boolean): { passed: boolean; failures: string[] };
