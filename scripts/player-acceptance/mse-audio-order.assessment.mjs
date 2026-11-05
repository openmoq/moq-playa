/** Fixed-fixture PCM assessment. No packet-identity inference from PCM labels. */
export const PCM_TOLERANCE_SAMPLES = 16;
export const PCM_THRESHOLD = 0.005;

export function activePcmSpan(bytes) {
  if (bytes.byteLength % 4) throw new Error('truncated f32le PCM');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let first = -1, last = -1;
  for (let i = 0; i < bytes.byteLength / 4; i++) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) throw new Error('non-finite captured PCM');
    if (Math.abs(value) > PCM_THRESHOLD) { if (first < 0) first = i; last = i; }
  }
  return { first, last, span: first < 0 ? 0 : last - first };
}

/** Contiguous quanta a realtime clock must deliver before measured playback may start. */
export const CLOCK_SETTLE_QUANTA = 8;

/**
 * Gates PCM capture on a settled realtime clock. Chrome's realtime destination
 * may advance AudioWorklet currentFrame without calling process() while its
 * output device starts (0 -> 384 at 8 kHz on fake/headless output). Those gaps
 * precede play(), so only paused-element silence is lost. Once armed and
 * settled, every quantum is recorded and any gap is a measurement failure.
 */
export function createQuantumGate(settleQuanta = CLOCK_SETTLE_QUANTA) {
  let previous = null, run = 0, armed = false, recording = false;
  const preroll = { quanta: 0, discontinuities: [] };
  return {
    preroll,
    get recording() { return recording; },
    arm() { armed = true; },
    /** 'preroll' (not measured), 'record', or 'gap' (measured discontinuity). */
    accept(frame, length) {
      const contiguous = previous === null || frame === previous.frame + previous.length;
      const expectedFrame = previous === null ? null : previous.frame + previous.length;
      previous = { frame, length };
      if (recording) return contiguous ? 'record' : 'gap';
      preroll.quanta++;
      if (!contiguous) preroll.discontinuities.push({ expectedFrame, frame });
      run = contiguous ? run + 1 : 1;
      if (armed && run >= settleQuanta) recording = true;
      return 'preroll';
    },
  };
}

export function assessAudioOrder(cases) {
  const failures = [];
  const check = (ok, name) => { if (!ok) failures.push(name); };
  for (const kind of ['in-order', 'in-order-repeat', 'candidate', 'omitted-tail']) {
    check(cases.filter(row => row.kind === kind).length === 1, `mandatory case: ${kind}`);
  }
  for (const row of cases) {
    const tag = row.kind;
    check(!row.failure && !row.failures?.length, `${tag}: runtime/callback errors`);
    check(Array.isArray(row.assertions) && row.assertions.length > 0 && row.assertions.every(a => a.passed), `${tag}: native assertions`);
    check(row.rate === 8000 && row.playbackRate === 1, `${tag}: actual rate`);
    check(row.ended === true && Math.abs(row.currentTime - 1.408) <= 1e-6 && Math.abs(row.duration - 1.408) <= 1e-6, `${tag}: complete media endpoint`);
    const quanta = row.quanta ?? [];
    check(quanta.length > 0 && quanta.every((q, i) => Number.isSafeInteger(q.frame) && q.length === 128
      && (i === 0 || q.frame === quanta[i - 1].frame + quanta[i - 1].length)), `${tag}: contiguous quanta`);
    check(row.samples > 0 && row.samples <= 64000 && row.pcmBytes === row.samples * 4
      && row.pcmBytes <= 256000 && quanta.reduce((sum, q) => sum + q.length, 0) === row.samples, `${tag}: sample/byte caps and completeness`);
    check(Number.isSafeInteger(row.endedAtFrame) && row.lastEndFrame === quanta.at(-1)?.frame + 128
      && row.drainSamples === row.lastEndFrame - row.endedAtFrame && row.drainSamples >= 4096, `${tag}: measured post-ended clock drain`);
    check(row.active?.first >= 0 && row.active?.last > row.active?.first && row.active.last < row.samples, `${tag}: active native PCM`);
    check(!row.elementEvents?.some(event => ['error', 'seeking', 'seeked'].includes(event.type)), `${tag}: no errors or seeks`);
    const expected = tag === 'native-reordered' ? [0, 1, 2, 3, 4, 5, 6, 7, 9, 8, 10]
      : ['omitted-tail', 'zero-window'].includes(tag) ? [0, 1, 2, 3, 4, 5, 6, 7, 9, 10]
        : Array.from({ length: 11 }, (_, i) => i);
    check(JSON.stringify(row.nativeOrder) === JSON.stringify(expected), `${tag}: exact native byte order`);
    if (tag === 'candidate' || tag === 'zero-window') {
      const tokens = row.tokens ?? [];
      check(tokens.length === 11 && new Set(tokens.map(token => token.index)).size === 11 && tokens.every(token => {
        const dropped = tag === 'zero-window' && token.index === 8;
        return token.terminals.length === 1 && token.terminals[0].state === (dropped ? 'discarded' : 'appended')
          && token.terminals[0].reason === (dropped ? 'stale group' : null);
      }), `${tag}: exactly-once token outcomes`);
    }
  }
  const find = kind => cases.find(row => row.kind === kind);
  const reference = find('in-order')?.active?.span;
  const delta = kind => reference - find(kind)?.active?.span;
  check(Number.isFinite(reference) && reference > 1024, 'usable healthy PCM reference');
  check(Math.abs(delta('in-order-repeat')) <= PCM_TOLERANCE_SAMPLES, 'healthy repeat span stable within 16 samples');
  check(Math.abs(delta('candidate')) <= PCM_TOLERANCE_SAMPLES, 'candidate span matches healthy within 16 samples');
  check(Math.abs(delta('omitted-tail') - 1024) <= PCM_TOLERANCE_SAMPLES, 'mandatory omission control distinguishes a 1024-sample deficit');
  if (find('zero-window')) check(Math.abs(delta('zero-window') - 1024) <= PCM_TOLERANCE_SAMPLES, 'zero-window control distinguishes a 1024-sample deficit');
  return { passed: failures.length === 0, failures, threshold: PCM_THRESHOLD, toleranceSamples: PCM_TOLERANCE_SAMPLES,
    spans: cases.map(row => ({ kind: row.kind, ...row.active, lossFromHealthy: reference - row.active?.span })),
    scope: 'Native active PCM span plus exact native append byte order; no coded-packet identity claim from PCM.' };
}
