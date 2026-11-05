import type { MoqtConnection } from '../../packages/webtransport/src/index.js';
export type ProgramWireConnection = Pick<MoqtConnection, 'subscribe' | 'observeQlogEvents'>;
export interface ProgramWireSnapshot {
  connections: number;
  overflow: boolean;
  subscriptions: Array<{ timeMs: number; requestId: string; namespace: string[]; name: string }>;
}
/** API subscription identity plus matched, parsed peer acceptance; not a raw packet-byte sensor. */
export function observeProgramSwitchWire(): {
  connection(connection: ProgramWireConnection): void;
  snapshot(): ProgramWireSnapshot;
  dispose(): void;
};
