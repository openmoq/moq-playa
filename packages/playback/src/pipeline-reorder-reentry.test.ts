/** A callback that replaces playback must not transfer an old input's loss or timeout. */
import { describe, expect, it } from 'vitest';
import { varint, type MoqtObjectData } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { RecoveryController } from './recovery.js';
import type {
    DecoderCommand, PlaybackEvent, PlaybackInputDiscardReason,
} from './types.js';

function fixture(maxBufferDepth = 8) {
    let nowUs = 5_000_000;
    const clock = { now: () => nowUs };
    const commands: DecoderCommand[] = [];
    const events: PlaybackEvent[] = [];
    const discarded: { input: object; reason: PlaybackInputDiscardReason }[] = [];
    let onEvent: (event: PlaybackEvent) => void = () => {};
    let evaluate: RecoveryController['evaluate'] = () => ({ type: 'reduce_quality', reason: 'buffer overflow' });
    const sync = new SyncController({ clock, driftThresholdUs: 10_000_000 });
    sync.setAudioReference(1_000_000_000n);
    const pipeline = new PlaybackPipeline({
        mediaType: 'video', clock, sync,
        config: {
            gapTimeoutUs: 200_000, driftThresholdUs: 10_000_000,
            maxBufferDepth, maxBacklogGroups: 0, maxReleasePerTick: 0,
        },
        recovery: { evaluate: trigger => evaluate(trigger) },
        onCommand: command => commands.push(command),
        onEvent: event => { events.push(event); onEvent(event); },
    });
    pipeline.inputObserver = (input, reason) => { discarded.push({ input, reason }); };
    const push = (group: number, object: number, input: object) => {
        const data: MoqtObjectData = {
            kind: 'data', trackAlias: varint(1), groupId: varint(group),
            subgroupId: varint(object % 2), objectId: varint(object),
            publisherPriority: 128, extensions: undefined,
            payload: new Uint8Array([0xca, 0xfe]),
        };
        const headers: LocHeaders = {
            captureTimestamp: 1_000_000_000n + BigInt(group * 1_000 + object * 100),
            ...(object === 0 ? { videoConfig: new Uint8Array([0x01, 0x64]) } : {}),
            videoFrameMarking: {
                startOfFrame: true, endOfFrame: true, independent: object === 0,
                discardable: false, baseLayerSync: false, temporalId: object % 2,
            },
        };
        pipeline.pushObject(data, headers, input);
    };
    return {
        pipeline, commands, events, discarded, push,
        advance: (us: number) => { nowUs += us; },
        listen: (listener: (event: PlaybackEvent) => void) => { onEvent = listener; },
        recover: (callback: RecoveryController['evaluate']) => { evaluate = callback; },
        decoded: () => commands.filter(c => c.type === 'decode_video').map(c => c.inputToken),
        resets: () => commands.filter(c => c.type === 'reset'),
    };
}

describe('video replacement during reorder callbacks', () => {
    for (const reentrant of [true, false]) {
        it(`overflow refusal ${reentrant ? 'inside' : 'before'} replacement cannot abandon the fresh head`, () => {
            const f = fixture(2);
            const oldDelta = {}, oldTail = {}, refusedOldHead = {};
            const freshHead = {}, freshDelta = {};
            f.push(5, 1, oldDelta);
            f.push(5, 2, oldTail);
            let recoveries = 0;
            const replace = () => {
                f.pipeline.resetForTrackSwitch(5n);
                f.push(5, 1, freshDelta);
            };
            f.listen(event => {
                if (event.type !== 'recovery') return;
                recoveries++;
                if (reentrant) replace();
            });
            f.push(5, 0, refusedOldHead);
            expect(recoveries).toBe(1);
            if (!reentrant) replace();
            const resetsAfterReplacement = f.resets().length;
            expect(resetsAfterReplacement).toBe(1);

            f.pipeline.tick();
            f.advance(100_000);
            f.pipeline.tick();
            expect.soft(f.discarded.filter(row => row.input === freshDelta)).toEqual([]);
            expect.soft(f.resets()).toHaveLength(resetsAfterReplacement);
            expect.soft(f.decoded()).toEqual([]);

            f.push(5, 0, freshHead);
            f.pipeline.tick();
            expect.soft(f.decoded()).toEqual([freshHead, freshDelta]);
            expect.soft(f.decoded()[0]).toBe(freshHead);
            expect.soft(f.decoded()[1]).toBe(freshDelta);
            expect.soft(f.pipeline.currentGroupId).toBe(5n);
            expect.soft(f.discarded.filter(row => row.input === freshHead || row.input === freshDelta)).toEqual([]);
        });
    }

    for (const reentrant of [true, false]) {
        it(`partial-group timeout ${reentrant ? 'callback' : 'completion'} preserves replacement commands and inputs`, () => {
            const f = fixture();
            const oldHead = {}, oldFuture = {}, freshHead = {};
            f.push(0, 0, oldHead);
            f.pipeline.tick();
            expect(f.decoded()).toEqual([oldHead]);
            f.push(1, 0, oldFuture);
            f.pipeline.tick();
            expect(f.decoded()).toEqual([oldHead]);
            let timeouts = 0;
            const replace = () => {
                f.pipeline.resetForTrackSwitch(20n);
                f.push(20, 0, freshHead);
            };
            f.listen(event => {
                if (event.type !== 'partial_group_abandoned' || event.reason !== 'intra-group timeout') return;
                timeouts++;
                if (reentrant) replace();
            });
            f.commands.length = 0;
            f.advance(200_001);
            f.pipeline.tick();
            expect(timeouts).toBe(1);
            if (!reentrant) {
                expect(f.resets()).toHaveLength(1);
                f.commands.length = 0;
                replace();
            }
            f.pipeline.tick();
            expect.soft(f.resets()).toHaveLength(1);
            expect.soft(f.decoded()).toEqual([freshHead]);
            expect.soft(f.decoded()[0]).toBe(freshHead);
            expect.soft(f.pipeline.currentGroupId).toBe(20n);
            expect.soft(f.discarded.filter(row => row.input === freshHead)).toEqual([]);
        });
    }

    for (const boundary of ['buffer_overflow', 'gap'] as const) {
        for (const reentrant of [true, false]) {
            it(`${boundary} evaluate ${reentrant ? 'replacement suppresses the old action' : 'without replacement publishes its action'}`, () => {
                const f = fixture(boundary === 'buffer_overflow' ? 1 : 8);
                const oldHead = {}, oldPending = {}, refusedHead = {}, freshHead = {};
                const oldAction = { type: 'pause_subscription', reason: 'old input recovery' } as const;
                let evaluations = 0;
                const replace = () => {
                    f.pipeline.resetForTrackSwitch(20n);
                    f.push(20, 0, freshHead);
                };
                f.recover(trigger => {
                    expect(trigger.type).toBe(boundary);
                    evaluations++;
                    if (reentrant) replace();
                    return oldAction;
                });

                if (boundary === 'buffer_overflow') {
                    f.push(5, 1, oldPending);
                    f.push(5, 0, refusedHead);
                } else {
                    f.push(0, 0, oldHead);
                    f.pipeline.tick();
                    expect(f.decoded()[0]).toBe(oldHead);
                    f.push(2, 0, oldPending);
                    f.pipeline.tick();
                    expect(evaluations).toBe(0);
                    f.advance(200_001);
                    f.pipeline.tick();
                }
                expect(evaluations).toBe(1);
                expect.soft(f.events.filter(event => event.type === 'recovery' && event.action === oldAction))
                    .toHaveLength(reentrant ? 0 : 1);
                if (!reentrant) replace();
                f.pipeline.tick();

                expect.soft(f.decoded().filter(input => input === freshHead)).toHaveLength(1);
                expect.soft(f.decoded().at(-1)).toBe(freshHead);
                expect.soft(f.pipeline.currentGroupId).toBe(20n);
                expect.soft(f.discarded.filter(row => row.input === freshHead)).toEqual([]);
                expect.soft(f.resets()).toHaveLength(boundary === 'gap' && !reentrant ? 2 : 1);
                const terminalCount = (input: object) => f.decoded().filter(token => token === input).length
                    + f.discarded.filter(row => row.input === input).length;
                expect.soft(terminalCount(oldPending)).toBe(1);
                if (boundary === 'buffer_overflow') {
                    expect.soft(f.discarded.filter(row => row.input === refusedHead))
                        .toEqual([{ input: refusedHead, reason: 'buffer full' }]);
                    expect.soft(terminalCount(refusedHead)).toBe(1);
                } else {
                    expect.soft(terminalCount(oldHead)).toBe(1);
                }
            });
        }
    }
});
