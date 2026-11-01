import { describe, expect, it } from 'vitest';
import { TraceRecorder } from './trace-recorder.js';
const silent = { error() {}, warn() {}, info() {}, debug() {} };

describe('explicit logger retention lane', () => {
  it('keeps high-rate observation logs out of the sparse diagnostic window', () => {
    const recorder = new TraceRecorder({ runId: 'run', clock: { clock_id: 'test', clock_type: 'monotonic', now: () => 1 }, eventSchemas: [],
      limits: { denseMaxEvents: 2, sparseMaxEvents: 2 } });
    const ordinary = recorder.logger(silent);
    const dense = recorder.logger(silent, {lane:'dense'});
    recorder.start(); ordinary.info('important state');
    for (let i = 0; i < 4; i++) dense.info(`object ${i}`);
    recorder.stop();
    const records = recorder.dump().split('\x1e').filter(v=>v.trim()).map(v=>JSON.parse(v));
    expect(records.filter(r=>r.name==='loglevel:info').map(r=>r.data.message)).toEqual(['important state','object 2','object 3']);
    const window = records.find(r=>r.name==='playa:trace_window').data;
    expect(window.dense).toMatchObject({retained:2,evicted_events:2});
    expect(window.sparse).toMatchObject({retained:1,evicted_events:0});
  });
});
