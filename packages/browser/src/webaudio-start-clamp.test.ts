import { describe, expect, it } from 'vitest';
import type { AudioProducedTiming } from '@openmoq/player';
import { WebAudioOutput } from './webaudio-output.js';

interface BufferModel {
  duration: number;
  getChannelData(): Float32Array;
}

class SourceModel {
  buffer: BufferModel | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  stopped = false;
  requested: number | null = null;
  effective: number | null = null;
  end: number | null = null;

  constructor(private readonly context: ContextModel) {}

  connect(): void { this.context.onConnect?.(); }
  disconnect(): void {}
  stop(): void { this.stopped = true; }
  start(when: number): void {
    if (!this.buffer) throw new Error('Missing buffer');
    this.requested = when;
    // Controlled immediate-start model, not native render-thread evidence.
    this.effective = Math.max(when, this.context.time);
    this.end = this.effective + this.buffer.duration / this.playbackRate.value;
  }
}

class ContextModel {
  time = 0;
  state = 'running';
  destination = {};
  nodes: SourceModel[] = [];
  onRead: (() => void) | undefined;
  onConnect: (() => void) | undefined;

  get currentTime(): number { this.onRead?.(); return this.time; }
  createBuffer(_channels: number, frames: number, rate: number): BufferModel {
    return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
  }
  createBufferSource(): SourceModel {
    const node = new SourceModel(this);
    this.nodes.push(node);
    return node;
  }
}

function audioData(timestamp: number) {
  return {
    timestamp, numberOfChannels: 1, numberOfFrames: 960, sampleRate: 48_000,
    copyTo(destination: Float32Array): void { destination.fill(0.1); },
    close(): void {},
  };
}

function fixture() {
  const context = new ContextModel();
  const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0,
    { now: () => context.time * 1_000_000 });
  const epoch = {};
  const timing = (pts: number, recompute = () => context.time * 1_000_000): AudioProducedTiming => ({
    sourceOffsetUs: 0,
    context: { epoch, sourceTimestampUs: BigInt(pts), presentFromSourceUs: BigInt(pts), recomputeRenderTimeUs: recompute },
  });
  const schedule = (pts: number, evidence?: AudioProducedTiming) => {
    output.schedule(audioData(pts), context.time * 1_000_000, undefined, evidence);
  };
  const node = (index: number): SourceModel => {
    const value = context.nodes[index];
    if (!value) throw new Error(`Missing source ${index}`);
    return value;
  };
  return { context, output, epoch, timing, schedule, node };
}

function expectNoOverlap(first: SourceModel, second: SourceModel): void {
  expect(first.end).not.toBeNull();
  expect(second.effective).not.toBeNull();
  expect(second.effective!).toBeGreaterThanOrEqual(first.end!);
}

describe('fresh audio scheduling boundary', () => {
  for (const producing of [false, true]) {
    it(`chains from adjusted start after connect advances time (${producing ? 'producing' : 'legacy'})`, () => {
      const f = fixture();
      f.context.time = 11.406666666666666 - 0.02;
      f.context.onConnect = () => { f.context.time = 11.392; };
      f.schedule(11_880_000, producing ? f.timing(11_880_000) : undefined);
      f.context.onConnect = undefined;
      f.context.time = 11.397333333333334;
      f.schedule(11_900_000, producing ? f.timing(11_900_000) : undefined);
      expect(f.node(0).effective).toBe(11.392);
      expectNoOverlap(f.node(0), f.node(1));
      expect(f.node(0).stopped || f.node(1).stopped).toBe(false);
      expect(f.node(0).playbackRate.value).toBe(1);
      expect(f.node(1).playbackRate.value).toBe(1);
      if (producing) {
        const position = f.output.sampleSourcePosition(f.epoch);
        expect(position?.sourceTimestampUs).toBe(11_880_000n);
        expect(position?.sourceOffsetUs).toBeCloseTo((f.context.time - 11.392) * 1_000_000, 6);
      } else {
        expect(f.output.playheadCaptureUs()).toBeCloseTo(11_880_000 + (f.context.time - 11.392) * 1_000_000, 6);
      }
    });
  }

  it('chains contiguously without setup advancement', () => {
    const f = fixture(); f.context.time = 11.386666666666667; f.schedule(11_880_000);
    f.context.time = 11.397333333333334; f.schedule(11_900_000);
    expect(f.node(1).effective).toBe(f.node(0).end);
  });

  it('advancement between calls preserves a still-live predecessor', () => {
    const f = fixture(); f.context.time = 11.392; f.schedule(11_880_000);
    f.context.time = 11.397333333333334; f.schedule(11_900_000);
    expect(f.node(1).effective).toBe(f.node(0).end);
  });

  it('genuine underrun reanchors after the completed predecessor', () => {
    const f = fixture(); f.context.time = 11.3; f.schedule(11_800_000);
    f.context.time = 11.392; f.schedule(11_880_000);
    expect(f.node(1).effective!).toBeGreaterThan(f.node(0).end!);
    expect(f.node(1).effective).toBe(11.392);
  });

  it('flush recovery stops the old source before restarting', () => {
    const f = fixture(); f.context.time = 11.392; f.schedule(11_880_000);
    f.context.time = 11.397333333333334; f.output.flush(); f.schedule(11_900_000);
    expect(f.node(0).stopped).toBe(true);
    expect(f.node(1).effective).toBe(f.context.time);
  });

  it('preserves a future anchor while setup advances before that anchor', () => {
    const f = fixture(); f.context.time = 11.3;
    f.context.onConnect = () => { f.context.time = 11.305333333333333; };
    f.output.schedule(audioData(11_880_000), 11_320_000);
    expect(f.node(0).effective).toBe(11.32);
    f.context.onConnect = undefined; f.schedule(11_900_000);
    expect(f.node(1).effective).toBe(f.node(0).end);
  });

  it('clamps after the final pre-start producing-time callback advances the clock', () => {
    const f = fixture(); let calls = 0;
    f.context.time = 11.386666666666667;
    const evidence = f.timing(11_880_000, () => {
      if (++calls === 3) f.context.time = 11.392;
      return f.context.time * 1_000_000;
    });
    f.schedule(11_880_000, evidence);
    expect(calls).toBe(4);
    expect(f.node(0).requested).toBe(11.392);
    f.context.time = 11.397333333333334;
    f.schedule(11_900_000, f.timing(11_900_000));
    expectNoOverlap(f.node(0), f.node(1));
  });

  for (const retire of ['flush', 'destroy'] as const) {
    it(`does not start a retired source when the fresh clock getter invokes ${retire}`, () => {
      const f = fixture(); f.context.time = 11.392;
      f.context.onConnect = () => {
        f.context.onRead = () => {
          f.context.onRead = undefined;
          f.output[retire]();
        };
      };
      f.schedule(11_880_000);
      expect(f.node(0).requested).toBeNull();
      expect(f.node(0).stopped).toBe(true);
      expect(f.output.playheadCaptureUs()).toBeNull();
    });
  }

  it('render-frame model keeps a late buffer at offset zero rather than retroactively consuming PCM', () => {
    // Explicit model processing times; these are not native onset measurements.
    const render = (requested: number, messageFrame: number): Map<number, number> => {
      const occupied = new Map<number, number>(); let cursor = 0;
      for (let frame = messageFrame; frame < messageFrame + 2_000; frame++) {
        if (frame < requested) continue;
        if (cursor < 960) occupied.set(frame, cursor);
        cursor++;
      }
      return occupied;
    };
    const first = render(546560, 546816), second = render(547520, 547456);
    expect(first.get(546816)).toBe(0);
    expect(first.size).toBe(960); expect(second.size).toBe(960);
    expect([...first.keys()].filter(frame => second.has(frame))).toHaveLength(256);
  });
});
