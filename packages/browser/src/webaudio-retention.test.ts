import { expect, it } from 'vitest';
import { WebAudioOutput } from './webaudio-output.js';

it.each([100, 3000])('releases completed PCM without position polling across %i buffers', count => {
  for (const timed of [false, true]) {
    let nowUs = 0;
    const nodes: Array<{ onended: (() => void) | null; when: number }> = [];
    const context = { state: 'running', destination: {}, get currentTime() { return nowUs / 1e6; },
      createBuffer(_channels: number, length: number, rate: number) {
        return { duration: length / rate, getChannelData: () => new Float32Array(length) };
      },
      createBufferSource() {
        const node = { buffer: null as unknown, onended: null as (() => void) | null, when: 0,
          playbackRate: { value: 1 }, connect() {}, disconnect() {},
          start(when: number) { node.when = when; }, stop() {} };
        nodes.push(node); return node;
      } };
    const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, { now: () => nowUs });
    const epoch = {};
    const complete = () => { for (const node of nodes.splice(0)) {
      if (node.when * 1e6 <= nowUs - 20_001) node.onended?.(); else nodes.push(node);
    } };
    try {
      for (let i = 0; i < count; i++) {
        const render = nowUs + 100_000;
        output.schedule({ timestamp: i * 20_000, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 960,
          copyTo() {}, close() {} }, render, undefined, timed ? { sourceOffsetUs: 0, context: {
          epoch, sourceTimestampUs: BigInt(i * 20_000), presentFromSourceUs: BigInt(i * 20_000),
          recomputeRenderTimeUs: offset => render + offset } } : undefined);
        nowUs += 20_000; complete();
      }
      // Inspect retained ownership without calling either diagnostic position reader.
      const state = output as unknown as { scheduledRing: Array<{ source?: { buffer: unknown } }>; hasOwnedSources: boolean };
      expect(state.scheduledRing.filter(entry => entry.source?.buffer).length).toBeLessThanOrEqual(nodes.length);
      if (!timed) expect(state.hasOwnedSources).toBe(false);
      nowUs += 1_000_000; complete();
      expect(nodes).toHaveLength(0);
      expect(state.scheduledRing.filter(entry => entry.source?.buffer)).toEqual([]);
    } finally { output.destroy(); }
  }
});
