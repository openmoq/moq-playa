import type { CmafAssemblerLike, MediaSourceLike, MoqtPlayerConfig } from '../../packages/player/src/index.js';
import type {} from '../../examples/_tests/player-acceptance/main.js';

export interface MseProgramSegment {
  seq: number;
  mediaType: 'video' | 'audio';
  trackName: string;
  sourceKey: string | null;
  groupId: string;
  rawPtsTicks: string | null;
  rebasedPtsTicks: string | null;
  endTicks: string | null;
  timescale: number | null;
  offset: number | null;
  submittedAtMs: number | null;
  completedAtMs: number | null;
  state: 'assembled' | 'submitted' | 'appended' | 'discarded' | 'unavailable';
  reason: string | null;
}
export interface MseProgramObserverSnapshot {
  sources: number;
  overflow: boolean;
  failures: string[];
  segments: MseProgramSegment[];
  queues: Array<{ timeMs: number; kind: 'acquire' | 'refused'; roles: ('video' | 'audio')[] }>;
}
export interface MseProgramPageHooks {
  mseProgramSnapshot(): MseProgramObserverSnapshot;
  armMseQueueRefusal(): void;
  selectMseMapped(mode: 'program' | 'view', variant: import('./program-switch.fixture.mjs').ProgramSwitchVariant): Promise<{
    timeline: Awaited<ReturnType<Window['playerAcceptance']['selectProgramMapped']>>; refusal: string | null;
  }>;
}
/** Observe real assembler bytes and native append terminals; never writes offsets or a playhead. */
export function observeMseProgramSwitch(): {
  source<T extends MediaSourceLike>(source: T): T;
  createAssembler: NonNullable<MoqtPlayerConfig['createCmafAssembler']> & ((options: Parameters<NonNullable<MoqtPlayerConfig['createCmafAssembler']>>[0]) => CmafAssemblerLike);
  pageHooks(player: Pick<import('../../packages/playa/src/player.js').Player,
    'programs' | 'views' | 'mediaTimelineReference' | 'selectProgram' | 'selectView'>): MseProgramPageHooks;
  snapshot(): MseProgramObserverSnapshot;
  dispose(): void;
};
