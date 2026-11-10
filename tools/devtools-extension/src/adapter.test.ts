/**
 * The adapter against the shared protocol fixtures.
 *
 * Every message goes through `decodeMessage` first, as the host does, so
 * these exercise the real boundary: validated, projected messages in; a view
 * model out. Identities stay decimal strings, loss is displayed and kept,
 * unavailable measurements keep their stated reason, and nothing lost is
 * ever drawn as missing media.
 */
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '@openmoq/devtools-protocol';
import type { Message } from '@openmoq/devtools-protocol';
import {
  batchFixture, failureFixture, fixtureTarget, gapFixture, helloFixture, refreshFixtures, scopedRefreshFixture,
  snapshotFixture, sourceEndedFixture,
} from '@openmoq/devtools-protocol/fixtures';
import { ProtocolSource } from './adapter.js';

type VM = Record<string, any>;

/** Round-trip through the codec, exactly as a host would receive it. */
function decoded<T extends Message>(message: T): T {
  const result = decodeMessage(encodeMessage(message));
  if (!result.ok) throw new Error(`${result.error.code} at ${result.error.path}`);
  return result.message as T;
}

function source() {
  let vm: VM = {};
  const src = new ProtocolSource((next: VM) => { vm = next; });
  return { src, vm: () => vm };
}

describe('snapshot → view model', () => {
  it('keeps MOQT identities as exact decimal strings beyond 2^53', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    expect(vm().rows[0].label).toBe('g 9007199254740993');
    expect(vm().rows[0].cells[0]).toMatchObject({ g: 'session-1/100/9007199254740993', o: '0', present: true });
    // A Number would have rounded this to ...992.
    expect(vm().rows[0].label).not.toContain('9007199254740992');
  });

  it('shows the negotiated protocol as not observed, never the offer', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const row = vm().session.find((r: string[]) => r[0] === 'subprotocol');
    expect(row).toEqual(['subprotocol', 'not observed', 'na']);
    const offered = vm().session.find((r: string[]) => r[0] === 'offered');
    expect(offered[1]).toBe('moqt-18');
  });

  it('marks MAX_REQUEST_ID not applicable on draft 18', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const row = vm().session.find((r: string[]) => r[0] === 'max_req_id');
    expect(row).toEqual(['max_req_id', 'not applicable (d18)', 'na']);
  });

  it('keeps an unavailable metric unavailable, with its stated reason', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const latency = vm().sparks.find((s: VM) => s.name === 'end to end latency');
    expect(latency.now).toBe('unavailable');
    expect(latency.na).toMatch(/^unsupported: Capture-to-presentation delay/);
  });

  it('reports the observed count and no denominator', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    expect(vm().rows[0].meta).toBe('1 obs');
    expect(vm().rows[0].meta).not.toMatch(/\//);
  });

  it('shows the synthetic flag the source declares', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    expect(vm().synthetic).toBe(true);
  });

  it('lists hello sources without inferring anything about undeclared ones', () => {
    const { src, vm } = source();
    src.applyHello(decoded(helloFixture));
    expect(vm().instances).toEqual([{ id: 'mock-source-1', name: 'MOCK · example.test', sub: 'probe · SYNTHETIC', on: false }]);
    expect(vm().exposed).toBe(false);
    expect(vm().hookStats).toBe('no exposed sources');
  });
});

describe('batches and the cursor', () => {
  it('applies a contiguous batch and adds the object to the grid', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const result = src.applyBatch(decoded(batchFixture));
    expect(result.kind).toBe('accept');
    expect(vm().rows[0].cells[2]).toMatchObject({ o: '2', present: true });
    expect(vm().rows[0].meta).toMatch(/^2 obs/);
  });

  it('displays accounted loss per lane and never as missing media', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(batchFixture));
    const result = src.applyBatch(decoded(gapFixture));
    expect(result).toMatchObject({ kind: 'accept', lost: true });
    expect(vm().hookStats).toContain('delivery drops: 2 dense · 0 sparse over 1 batch');
    // Objects 3 and 4 were never observed; their cells are empty, not "missing".
    const row = vm().rows[0];
    expect(row.cells[3].present).toBe(false);
    expect(row.cells[3].cls).toBe('');
    expect(row.cells[5].present).toBe(true);
    expect(vm().needsResnapshot).toBeNull();
  });

  it('keeps the loss record across a resnapshot', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(batchFixture));
    src.applyBatch(decoded(gapFixture));
    src.applySnapshot(decoded(snapshotFixture));
    expect(vm().hookStats).toContain('delivery drops: 2 dense');
  });

  it('requests a resnapshot on a sequence gap and does not advance', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const result = src.applyBatch(decoded(gapFixture));   // fromSeq 7 after watermark 5
    expect(result).toMatchObject({ kind: 'resnapshot', reason: 'sequence-gap' });
    expect(vm().needsResnapshot).toBe('sequence-gap');
    // Nothing from the refused batch reached the grid: still only o0.
    expect(vm().rows[0].cells.map((c: VM) => c.o)).toEqual(['0']);
  });

  it('ignores a batch for a different target', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const other = decoded({ ...batchFixture, target: { ...fixtureTarget, attachmentId: 'someone-else' } });
    expect(src.applyBatch(other)).toMatchObject({ kind: 'ignore', reason: 'different-target' });
    expect(vm().rows[0].cells.map((c: VM) => c.o)).toEqual(['0']);
  });

  it('ignores a batch with no cursor yet', () => {
    const { src } = source();
    expect(src.applyBatch(decoded(batchFixture))).toMatchObject({ kind: 'ignore', reason: 'no-cursor' });
  });
});

describe('facts that must not become media evidence', () => {
  it('renders a dial failure as phase · outcome · cause unknown', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(failureFixture));
    expect(vm().events).toContainEqual(expect.objectContaining({ name: 'dial error · cause unknown' }));
  });

  it('counts an unknown fact kind without drawing it', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const unknown = decoded({
      ...batchFixture,
      events: [{ seq: '6', clockId: 'mock-clock', timeMs: 10, fact: { kind: 'future_thing', anything: 1 } as any }],
    });
    expect(src.applyBatch(unknown).kind).toBe('accept');
    expect(vm().hookStats).toContain('1 unknown facts');
    expect(vm().rows[0].cells.filter((c: VM) => c.present)).toHaveLength(1);
  });

  it('treats a stream reset as a stream fact, not an object range', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const reset = decoded({
      ...batchFixture,
      events: [{ seq: '6', clockId: 'mock-clock', timeMs: 10, fact: {
        kind: 'stream', sessionId: 'session-1', streamId: '6', trackAlias: '100', groupId: '9007199254740993',
        subgroupId: '0', state: 'reset', code: '7',
      } }],
    });
    src.applyBatch(reset);
    expect(vm().events).toContainEqual(expect.objectContaining({ name: 'stream 6 reset · code 7' }));
    // No cell became "missing" because of it.
    expect(vm().rows[0].cells.every((c: VM) => !c.cls.includes('miss'))).toBe(true);
  });

  it('shows a terminal bound as its own fact beside the observed count', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const bound = decoded({
      ...batchFixture,
      events: [{ seq: '6', clockId: 'mock-clock', timeMs: 10, fact: {
        kind: 'group_bound', sessionId: 'session-1', trackAlias: '100', groupId: '9007199254740993',
        objectId: '59', bound: 'inclusive', evidence: 'end-of-group',
      } }],
    });
    src.applyBatch(bound);
    expect(vm().rows[0].meta).toBe('1 obs · ends o59');
    // The bound LABELS; it never sizes the grid. One object retained → one cell.
    expect(vm().columns).toBe(1);
    expect(vm().rows[0].window).toEqual({ from: '0', to: '255', beyond: 0 });
  });

  it('distinguishes expected independence from parsed independence', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    const expected = decoded({
      ...batchFixture,
      events: [{ seq: '6', clockId: 'mock-clock', timeMs: 10,
        fact: { ...batchFixture.events[0].fact, deliveryId: 'd-x', objectId: '1', independence: 'expected-independent' } }],
    });
    src.applyBatch(expected);
    expect(vm().rows[0].cells[1].cls).toBe('key expected');
    expect(vm().rows[0].cells[0].cls).not.toContain('key');   // fixture object 0 is 'unknown'
  });
});

describe('panel-local controls', () => {
  it('Pause freezes the view without touching the cursor', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.togglePause();
    expect(src.applyBatch(decoded(batchFixture)).kind).toBe('accept');
    expect(vm().rows[0].cells).toHaveLength(1);           // frozen view: still only o0
    src.togglePause();
    expect(vm().rows[0].cells[2].present).toBe(true);    // caught up, no resnapshot needed
  });
});

describe('source refresh and source end (protocol minor 1)', () => {
  /** snapshot, batch, then the shared refresh pair: a drops batch followed by the refreshed snapshot. */
  function refreshed() {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(batchFixture));
    const [pending, refresh] = refreshFixtures;
    expect(src.applyBatch(decoded(pending))).toMatchObject({ kind: 'accept', lost: true });
    expect(src.applySnapshot(decoded(refresh))).toEqual({ applied: true });
    return { src, vm };
  }

  it('takes the drained batch before the refreshed snapshot and keeps the loss it reported', () => {
    const { vm } = refreshed();
    expect(vm().hookStats).toContain('delivery drops: 2 dense · 0 sparse over 1 batch');
    expect(vm().needsResnapshot).toBeNull();
    expect(vm().sourceEnded).toBeNull();
  });

  it('routes a scoped refresh to detail without moving the stream cursor', () => {
    const { src, vm } = refreshed();
    expect(src.applySnapshot(decoded(scopedRefreshFixture))).toEqual({ applied: true, reason: 'detail' });
    expect(vm().detail).toEqual({ scope: { kind: 'delivery', deliveryId: 'delivery-3' }, facts: 1 });
    // The stream cursor is still at the source watermark: the terminal batch at seq 10 is contiguous.
    expect(src.applyBatch(decoded(sourceEndedFixture)).kind).toBe('accept');
  });

  it('shows capture ended with its reason, keeps session facts, and never claims a transport close', () => {
    const { src, vm } = refreshed();
    const stateBefore = vm().session;
    expect(src.applyBatch(decoded(sourceEndedFixture))).toMatchObject({ kind: 'accept', lost: false });
    expect(vm().sourceEnded).toEqual({ reason: 'disposed', timeMs: 21, clockId: 'mock-clock' });
    expect(vm().hookStats).toContain('capture ended · disposed');
    expect(vm().session).toEqual(stateBefore);            // last observed session state, unchanged
    expect(vm().hookStats).toContain('delivery drops: 2 dense');   // same-run loss survives the end
    expect(vm().unknownFacts ?? 0).toBe(0);
    // A replayed terminal batch is already applied, not a new end.
    expect(src.applyBatch(decoded(sourceEndedFixture))).toEqual({ kind: 'ignore', reason: 'already-applied' });
  });

  it('keeps the ended state through a same-run refresh that carries the terminal fact', () => {
    const { src, vm } = refreshed();
    src.applyBatch(decoded(sourceEndedFixture));
    const terminal = sourceEndedFixture.events[0];
    const refresh = decoded({
      ...refreshFixtures[1], requestId: 'refresh-2', watermark: '10',
      facts: [...refreshFixtures[1].facts, { clockId: terminal.clockId, timeMs: terminal.timeMs, fact: terminal.fact }],
      retention: { ...refreshFixtures[1].retention, retainedEvents: 7 },
    });
    expect(src.applySnapshot(refresh)).toEqual({ applied: true });
    expect(vm().sourceEnded).toMatchObject({ reason: 'disposed' });
  });

  it('does not let detail refreshes or view operations resurrect an ended source', () => {
    const { src, vm } = refreshed();
    src.applyBatch(decoded(sourceEndedFixture));
    expect(src.applySnapshot(decoded(scopedRefreshFixture))).toEqual({ applied: true, reason: 'detail' });
    src.selectTrack('video-1'); src.togglePause(); src.togglePause(); src.setMode('probe'); src.setMode('attach');
    expect(vm().sourceEnded).toMatchObject({ reason: 'disposed' });
    expect(vm().hookStats).toContain('capture ended');
  });

  it('starts a new run without the previous run\'s ended state', () => {
    const { src, vm } = refreshed();
    src.applyBatch(decoded(sourceEndedFixture));
    const next = decoded({
      ...snapshotFixture, requestId: 'attach-2', watermark: '0', facts: [], omittedFacts: 0,
      source: { ...snapshotFixture.source, runId: 'run-2' },
      target: { ...fixtureTarget, runId: 'run-2', attachmentId: 'attachment-2' },
      retention: { ...snapshotFixture.retention, retainedEvents: 0, retainedBytes: 0 },
    });
    expect(src.applySnapshot(next)).toEqual({ applied: true });
    expect(vm().sourceEnded).toBeNull();
    expect(vm().hookStats).not.toContain('capture ended');
    expect(vm().hookStats).not.toContain('delivery drops');   // loss belonged to the ended run
  });
});

describe('sparkline history', () => {
  /** One metric observation in its own contiguous batch (the fixture snapshot's watermark is 5). */
  const metric = (value: number | null, timeMs: number, seq: number, over: Record<string, unknown> = {}) => ({
    ...batchFixture, fromSeq: String(seq), toSeq: String(seq),
    events: [{ seq: String(seq), clockId: 'mock-clock', timeMs, fact: {
      kind: 'metric', name: 'receive_bitrate', sessionId: 'session-1', trackId: null, value, unavailable: value === null ? 'not-observed' : null,
      unit: 'bps', definition: 'bytes received per second', windowMs: 1000, uncertaintyMs: null, ...over,
    } }],
  } as const);
  const bitrate = (vm: VM) => vm.sparks.find((s: VM) => s.name === 'receive bitrate');

  it('retains one sample per observation and scales bars to the series peak', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    for (const [v, t, q] of [[100, 20, 6], [400, 30, 7], [200, 40, 8]] as const) expect(src.applyBatch(decoded(metric(v, t, q))).kind).toBe('accept');
    const s = bitrate(vm());
    expect(s.now).toBe('200 bps');
    expect(s.bars.map((b: VM) => b.h)).toEqual([9, 34, 17]);
    expect(s.range).toBe('3 samples · peak 400 bps');
    expect(s.bars.at(-1).op).toBe(1);
  });

  it('bounds the series by the sparkSamples budget, oldest out first', () => {
    let vm: VM = {};
    const src = new ProtocolSource((next: VM) => { vm = next; }, { budgets: { sparkSamples: 3 } });
    src.applySnapshot(decoded(snapshotFixture));
    for (let i = 1; i <= 5; i++) src.applyBatch(decoded(metric(i * 10, 20 + i, 5 + i)));
    expect(bitrate(vm).bars).toHaveLength(3);
    expect(bitrate(vm).range).toBe('3 samples · peak 50 bps');
  });

  it('keeps exact latest and retained peak inspectable beside rounded labels', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(metric(2738306.4848224605, 20, 6)));
    src.applyBatch(decoded(metric(96000, 30, 7)));
    const s = bitrate(vm());
    expect(s.now).toBe('96.0 kbps');
    expect(s.range).toBe('2 samples · peak 2.74 Mbps');
    expect(s.definition).toContain('exact 96000 bps');
    expect(s.definition).toContain('exact retained peak 2738306.4848224605 bps');
  });

  it('keeps the exact retained peak inspectable when the latest sample is unavailable', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(metric(2738306.4848224605, 20, 6)));
    src.applyBatch(decoded(metric(null, 30, 7)));
    const s = bitrate(vm());
    expect(s.now).toBe('unavailable');
    expect(s.range).toBe('1 sample · peak 2.74 Mbps');
    expect(s.definition).toContain('exact retained peak 2738306.4848224605 bps');
    expect(s.definition).not.toContain('exact null');
  });

  it('keeps history across a same-run refresh without duplicating the re-delivered sample, and clears it for a new run', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(metric(100, 20, 6)));
    src.applyBatch(decoded(metric(300, 30, 7)));
    const refresh = decoded({ ...snapshotFixture, requestId: 'refresh-x', watermark: '7',
      facts: [...snapshotFixture.facts, { clockId: 'mock-clock', timeMs: 30, fact: metric(300, 30, 7).events[0].fact }] });
    expect(src.applySnapshot(refresh)).toEqual({ applied: true });
    expect(bitrate(vm()).bars).toHaveLength(2);
    const next = decoded({ ...snapshotFixture, requestId: 'attach-2', watermark: '0', facts: [], omittedFacts: 0,
      source: { ...snapshotFixture.source, runId: 'run-2' }, target: { ...fixtureTarget, runId: 'run-2', attachmentId: 'attachment-2' },
      retention: { ...snapshotFixture.retention, retainedEvents: 0, retainedBytes: 0 } });
    src.applySnapshot(next);
    expect(bitrate(vm()).bars).toHaveLength(0);
  });

  it('keeps an unavailable sample out of the series but shows the history that exists', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(metric(100, 20, 6)));
    src.applyBatch(decoded(metric(null, 30, 7)));
    const s = bitrate(vm());
    expect(s.now).toBe('unavailable');
    expect(s.bars).toHaveLength(1);
    expect(s.range).toBe('1 sample · peak 100 bps');
  });

  it('drops a series with its metric when the metrics budget evicts it', () => {
    let vm: VM = {};
    const src = new ProtocolSource((next: VM) => { vm = next; }, { budgets: { metrics: 1 } });
    src.applySnapshot(decoded(snapshotFixture));
    src.applyBatch(decoded(metric(100, 20, 6)));
    src.applyBatch(decoded(metric(5, 21, 7, { name: 'arrival_jitter', unit: 'ms' })));   // evicts receive_bitrate
    expect(bitrate(vm).bars).toHaveLength(0);
    expect(src.metricHistory.size).toBe(1);
  });
});

describe('reported extra metrics', () => {
  const metricBatch = (name: string, unit: 'ms' | 'seconds' | 'count', value: number, seq: number) => ({
    ...batchFixture, fromSeq: String(seq), toSeq: String(seq),
    events: [{ seq: String(seq), clockId: 'mock-clock', timeMs: 20 + seq, fact: {
      kind: 'metric', name, sessionId: 'session-1', trackId: null, value, unavailable: null, unit, definition: `${name} as reported`, windowMs: 250, uncertaintyMs: null,
    } }],
  } as const);

  it('shows a reported extra metric after the three canonical charts and never an unreported one', () => {
    const { src, vm } = source();
    src.applySnapshot(decoded(snapshotFixture));
    expect(vm().sparks.map((s: VM) => s.name)).toEqual(['end to end latency', 'arrival jitter', 'receive bitrate']);
    src.applyBatch(decoded(metricBatch('av_skew', 'ms', 12, 6)));
    src.applyBatch(decoded(metricBatch('video_buffer_ahead', 'seconds', 1.5, 7)));
    const names = vm().sparks.map((s: VM) => s.name);
    expect(names).toEqual(['end to end latency', 'arrival jitter', 'receive bitrate', 'av skew', 'video buffer ahead']);
    expect(vm().sparks.find((s: VM) => s.name === 'av skew').now).toBe('12 ms');
    expect(names).not.toContain('frames decoded');
  });
});

describe('stage legend wording', () => {
  const withCapabilities = (capabilities: readonly string[]) => decoded({
    ...snapshotFixture, source: { ...snapshotFixture.source, capabilities: [...capabilities] },
  } as unknown as Message);
  const counter = (name: string, value: number, seq: number) => decoded({
    ...batchFixture, fromSeq: String(seq), toSeq: String(seq),
    events: [{ seq: String(seq), clockId: 'mock-clock', timeMs: 20 + seq, fact: {
      kind: 'metric', name, sessionId: 'session-1', trackId: null, value, unavailable: null,
      unit: 'count', definition: 'coverage counter', windowMs: null, uncertaintyMs: null,
    } }],
  } as unknown as Message);

  it('says nothing when no stage capability is declared', () => {
    const { src, vm } = source();
    src.applySnapshot(withCapabilities(['session', 'requests', 'objects']) as any);
    expect(vm().legendNote).toBeNull();
  });

  it('explains each declared stage capability, and that audio presentation is never inferred', () => {
    const { src, vm } = source();
    src.applySnapshot(withCapabilities(['session', 'objects', 'cmaf-append-stages', 'loc-video-stages', 'loc-audio-stages']) as any);
    expect(vm().legendNote).toContain('append stages reported');
    expect(vm().legendNote).toContain('presented reported from the renderer');
    expect(vm().legendNote).toContain('presentation is not observable');
  });

  it('names the unobservable component and its count instead of inferring a stage', () => {
    const { src, vm } = source();
    src.applySnapshot(withCapabilities(['session', 'objects', 'cmaf-append-stages', 'loc-video-stages', 'loc-audio-stages']) as any);
    src.applyBatch(counter('diagnostic_unobservable_appends', 3, 6) as any);
    src.applyBatch(counter('diagnostic_unobservable_video_outputs', 2, 7) as any);
    src.applyBatch(counter('diagnostic_unobservable_audio_outputs', 0, 8) as any);
    expect(vm().legendNote).toContain('appends unobservable (3)');
    expect(vm().legendNote).toContain('video presentation unobservable (2)');
    expect(vm().legendNote).toContain('audio: decoded · scheduled reported');
    expect(vm().legendNote).not.toContain('audio scheduling unobservable');
  });
});
