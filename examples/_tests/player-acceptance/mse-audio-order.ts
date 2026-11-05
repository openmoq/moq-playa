/** Native PCM gate; TimeRanges is diagnostic, not a sample-residency oracle. */
import { MseMediaSource } from '../../../packages/browser/src/mse-adapter.js';
import { createQuantumGate } from '../../../scripts/player-acceptance/mse-audio-order.assessment.mjs';

type Kind = 'in-order' | 'in-order-repeat' | 'candidate' | 'omitted-tail' | 'native-reordered' | 'zero-window';
type Frame = { index: number; group: string; bmd: string; duration: number };
type Fixture = { codec: string; timescale: number; frames: Frame[]; prefix: number[]; tail: number; head: number; next: number; init: string; data: string[] };
type Operation = { id: number; index: number | 'init' | 'unknown'; bytes: number; updates: number; terminals: number; errors: string[] };
type Quantum = { frame: number; length: number };
const video = document.querySelector('video')!;
const rate = 8000, drainSamples = 4096, maxSamples = rate * 8, maxPcmBytes = maxSamples * 4;
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const ranges = (sb: SourceBuffer) => Array.from({ length: sb.buffered.length }, (_, i) => [sb.buffered.start(i), sb.buffered.end(i)]);

async function prepare(kind: Kind, fixture: Fixture) {
  const operations: Operation[] = [], events: { type: string; operation: number | null; index: Operation['index'] | null; ranges: number[][]; offset: number; atMs: number }[] = [];
  const assertions: { name: string; passed: boolean; actual?: unknown }[] = [];
  const tokens: { index: number; terminals: { state: string; reason: string | null }[] }[] = [];
  const quantumDiagnostics: unknown[] = [], captureIssues: unknown[] = [];
  const gate = createQuantumGate();
  let settle: (() => void) | undefined;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const elementEvents: { type: string; mediaTime: number; contextFrame: number | null }[] = [];
  const buffers: SourceBuffer[] = [], active = new Map<SourceBuffer, Operation>(), failures: string[] = [];
  const assert = (name: string, passed: boolean, actual?: unknown) => assertions.push({ name, passed, actual });
  const known = [{ index: 'init' as const, data: decode(fixture.init) },
    ...fixture.frames.slice(0, fixture.next + 1).map((_, index) => ({ index, data: decode(fixture.data[index]!) }))];
  const nativeAdd = MediaSource.prototype.addSourceBuffer, nativeAppend = SourceBuffer.prototype.appendBuffer;
  let ms: MediaSource | undefined, source: MseMediaSource | undefined, mediaUrl: string | undefined;
  let context: AudioContext | undefined, node: AudioWorkletNode | undefined, input: MediaElementAudioSourceNode | undefined, sink: GainNode | undefined;
  let unobserve: (() => void) | undefined, started = false, playback = false, captureReject: ((reason: Error) => void) | undefined;
  const tokenOwners = new Map<object, { row: typeof tokens[number]; resolve: () => void }>();
  const timed = async <T>(promise: Promise<T>, name: string, timeoutMs = 3000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: timeout`)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  const wait = async (predicate: () => boolean, name: string) => {
    const deadline = performance.now() + 3000;
    while (!predicate()) {
      if (failures.length) throw new Error(failures.join('; '));
      if (performance.now() > deadline) throw new Error(`${name}: timeout`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    if (failures.length) throw new Error(failures.join('; '));
  };
  const fail = (message: string) => { failures.push(message); captureReject?.(new Error(message)); };
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, ...args: Parameters<typeof nativeAdd>) {
    const sb = Reflect.apply(nativeAdd, this, args) as SourceBuffer;
    ms = this; buffers.push(sb);
    for (const type of ['updatestart', 'update', 'updateend', 'error', 'abort']) sb.addEventListener(type, () => {
      try {
        const operation = active.get(sb);
        events.push({ type, operation: operation?.id ?? null, index: operation?.index ?? null,
          ranges: ranges(sb), offset: sb.timestampOffset, atMs: performance.now() });
        if (!operation) { fail(`unowned native ${type}`); return; }
        if (type === 'update') operation.updates++;
        if (type === 'error' || type === 'abort') { operation.errors.push(type); fail(`native ${type}, operation ${operation.id}`); }
        if (type === 'updateend') { operation.terminals++; active.delete(sb); }
      } catch (error) { fail(`native observer: ${String(error)}`); }
    });
    return sb;
  };
  // Exact byte comparison observes identity, never filters or changes appends.
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, ...args: Parameters<typeof nativeAppend>) {
    if (!buffers.includes(this)) return Reflect.apply(nativeAppend, this, args);
    const value = args[0];
    const data = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
    const match = known.find(entry => equal(data, entry.data));
    const operation: Operation = { id: operations.length + 1, index: match?.index ?? 'unknown', bytes: data.length, updates: 0, terminals: 0, errors: [] };
    operations.push(operation);
    if (active.has(this)) fail('overlapping native operations');
    active.set(this, operation);
    try { return Reflect.apply(nativeAppend, this, args); }
    catch (error) { operation.errors.push(String(error)); active.delete(this); throw error; }
  };
  const onElement = (event: Event) => {
    elementEvents.push({ type: event.type, mediaTime: video.currentTime, contextFrame: context ? Math.round(context.currentTime * rate) : null });
    if (event.type === 'error') fail(`element error ${video.error?.code}: ${video.error?.message}`);
    if (event.type === 'seeking' || event.type === 'seeked') fail(`unexpected ${event.type}`);
    if (playback && (event.type === 'waiting' || event.type === 'stalled')) fail(`playback ${event.type}`);
  };
  const observedEvents = ['play', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'error', 'ended'];
  for (const type of observedEvents) video.addEventListener(type, onElement);
  const cleanup = async () => {
    for (const type of observedEvents) video.removeEventListener(type, onElement);
    unobserve?.(); source?.destroy();
    video.pause(); video.removeAttribute('src'); video.load();
    input?.disconnect(); node?.disconnect(); sink?.disconnect();
    if (node) { node.port.onmessage = null; node.port.onmessageerror = null; node.onprocessorerror = null; }
    if (context && context.state !== 'closed') await context.close();
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    MediaSource.prototype.addSourceBuffer = nativeAdd;
    SourceBuffer.prototype.appendBuffer = nativeAppend;
  };
  const metadata = () => ({ kind, assertions, failures, operations, events, tokens, elementEvents,
    quantumDiagnostics, captureIssues, preroll: gate.preroll, actualContextSampleRate: context?.sampleRate,
    contextRenderQuantumSize: context ? (context as AudioContext & { renderQuantumSize?: number }).renderQuantumSize ?? null : null });
  try {
    if (fixture.timescale !== rate) throw new Error('fixture rate must be exactly 8000 Hz');
    if (!MediaSource.isTypeSupported(`audio/mp4; codecs="${fixture.codec}"`)) throw new Error('CAPABILITY: native AAC LC unavailable');
    if (known.reduce((sum, entry) => sum + entry.data.length, 0) > 1024 * 1024) throw new Error('coded fixture byte cap');
    video.pause();
    const candidate = kind === 'candidate' || kind === 'zero-window';
    if (candidate) {
      const options: NonNullable<ConstructorParameters<typeof MseMediaSource>[1]> = {
        mseImplementation: 'standard', mseAttachment: 'object-url', ...(kind === 'zero-window' ? { reorderWindowMs: 0 } : {}),
      };
      source = new MseMediaSource(video, options);
      source.setPlaybackIntent(false); // Also stays false during direct test-button play.
      source.onError = error => fail(String(error));
      assert('standard native MSE', source.selectedImplementation === 'standard');
      unobserve = source.observeAppends(event => {
        try {
          const owner = tokenOwners.get(event.token);
          if (!owner) { fail('unknown append token'); return; }
          owner.row.terminals.push({ state: event.state, reason: event.reason });
          if (owner.row.terminals.length !== 1) fail(`duplicate append outcome for ${owner.row.index}`);
          owner.resolve();
        } catch (error) { fail(`append callback: ${String(error)}`); }
      });
      if (!source.initialize({ audio: { codec: fixture.codec, initData: known[0]!.data } })) throw new Error('adapter initialization refused');
      await wait(() => source!.attached && operations.length === 1 && active.size === 0, 'adapter init');
    } else {
      ms = new MediaSource(); mediaUrl = URL.createObjectURL(ms); video.src = mediaUrl;
      await wait(() => ms!.readyState === 'open', 'sourceopen');
      const sb = ms.addSourceBuffer(`audio/mp4; codecs="${fixture.codec}"`);
      sb.mode = 'segments'; sb.appendBuffer(known[0]!.data);
      await wait(() => active.size === 0, 'native init');
    }
    if (buffers.length !== 1 || !ms) throw new Error('exactly one native SourceBuffer required');
    const sb = buffers[0]!;
    const issue = (index: number): Promise<void> => {
      const data = known[index + 1]!.data;
      if (source) {
        const token = {}, row: typeof tokens[number] = { index, terminals: [] };
        tokens.push(row);
        const done = new Promise<void>(resolve => tokenOwners.set(token, { row, resolve }));
        source.appendChunk('audio', data, 'audio-8k', BigInt(fixture.frames[index]!.group), token);
        return timed(done, `append token ${index}`);
      }
      sb.appendBuffer(data);
      return wait(() => active.size === 0, `native append ${index}`);
    };
    for (const index of fixture.prefix) await issue(index);
    if (candidate) {
      // No await between these submissions: awaiting head would expire its hold.
      const head = issue(fixture.head);
      const tail = issue(fixture.tail);
      await Promise.all([head, tail]);
    } else if (kind === 'native-reordered') { await issue(fixture.head); await issue(fixture.tail); }
    else if (kind === 'omitted-tail') await issue(fixture.head);
    else { await issue(fixture.tail); await issue(fixture.head); }
    await issue(fixture.next);
    await wait(() => active.size === 0, 'final native terminal');
    assert('preparation stayed paused at zero', video.paused && video.currentTime === 0);
    assert('no offset change', sb.timestampOffset === 0 && events.every(event => event.offset === 0));
    assert('native operations complete successfully once', operations.every(op => op.updates === 1 && op.terminals === 1 && op.errors.length === 0));
    assert('one exact-byte init', operations.filter(op => op.index === 'init').length === 1);
    assert('no unrecognized native bytes', operations.every(op => op.index !== 'unknown'));
    const nativeOrder = operations.filter(op => typeof op.index === 'number').map(op => op.index);
    const fullOrder = Array.from({ length: fixture.next + 1 }, (_, i) => i);
    const expectedOrder = kind === 'native-reordered' ? [...fixture.prefix, fixture.head, fixture.tail, fixture.next]
      : kind === 'omitted-tail' || kind === 'zero-window' ? [...fixture.prefix, fixture.head, fixture.next] : fullOrder;
    assert('exact native byte order', JSON.stringify(nativeOrder) === JSON.stringify(expectedOrder), { nativeOrder, expectedOrder });
    if (source) {
      assert('retained committed audio GROUP floor', source.getCommittedGroupFloor('audio', 'audio-8k') === 8n);
      assert('one token per submitted packet', tokens.length === fixture.next + 1);
      for (const row of tokens) {
        const dropped = kind === 'zero-window' && row.index === fixture.tail;
        assert(`packet ${row.index}: exactly one terminal`, row.terminals.length === 1);
        assert(`packet ${row.index}: terminal state`, row.terminals[0]?.state === (dropped ? 'discarded' : 'appended')
          && row.terminals[0]?.reason === (dropped ? 'stale group' : null), row.terminals);
      }
    }
    const diagnosticRanges = ranges(sb);
    ms.endOfStream();
    assert('media duration is 1.408 seconds', Math.abs(video.duration - 1.408) <= 1e-6, video.duration);
    context = new AudioContext({ sampleRate: rate });
    if (context.sampleRate !== rate) throw new Error('CAPABILITY: exact 8 kHz AudioContext unavailable');
    await timed(context.suspend(), 'audio context suspend');
    if (context.state !== 'suspended') throw new Error('audio context must be suspended before graph construction');
    await context.audioWorklet.addModule(new URL('./mse-audio-order.worklet.js', import.meta.url));
    node = new AudioWorkletNode(context, 'mse-audio-order-capture');
    input = context.createMediaElementSource(video); sink = context.createGain(); sink.gain.value = 0;
    input.connect(node).connect(sink).connect(context.destination);
    const quanta: Quantum[] = [], chunks: Float32Array[] = [];
    let samples = 0, endedAtFrame: number | null = null, lastEndFrame = 0;
    const capture = new Promise<void>((resolve, reject) => {
      captureReject = reject;
      node!.onprocessorerror = () => fail('AudioWorklet processor error');
      node!.port.onmessageerror = () => fail('AudioWorklet message error');
      node!.port.onmessage = ({ data }) => {
        const previous = quanta.at(-1);
        const diagnostic = { sequence: quantumDiagnostics.length, previousFrame: previous?.frame ?? null,
          previousCopiedLength: previous?.length ?? null, expectedFrame: previous ? previous.frame + previous.length : null,
          currentFrame: data.frame, copiedLength: data.samples instanceof Float32Array ? data.samples.length : null,
          inputLengths: data.inputLengths, outputLengths: data.outputLengths, workletSampleRate: data.workletSampleRate,
          workletRenderQuantumSize: data.renderQuantumSize, actualContextSampleRate: context!.sampleRate,
          contextRenderQuantumSize: (context as AudioContext & { renderQuantumSize?: number }).renderQuantumSize ?? null,
          contextState: context!.state, copyError: data.copyError ?? null };
        quantumDiagnostics.push(diagnostic);
        try {
          if (!(data.samples instanceof Float32Array) || data.samples.length !== 128 || !Number.isSafeInteger(data.frame)) throw new Error('invalid worklet quantum');
          if (!data.samples.every((value: number) => Number.isFinite(value))) throw new Error('non-finite PCM');
          // Paused-element silence before the clock settles is not measured.
          const accepted = gate.accept(data.frame, data.samples.length);
          if (accepted === 'gap') throw new Error('non-contiguous worklet quanta');
          if (accepted === 'preroll') { if (gate.recording) settle?.(); return; }
          samples += data.samples.length;
          if (samples > maxSamples || samples * 4 > maxPcmBytes) throw new Error('PCM capture cap');
          chunks.push(data.samples); quanta.push({ frame: data.frame, length: data.samples.length });
          lastEndFrame = data.frame + data.samples.length;
          if (endedAtFrame !== null && lastEndFrame - endedAtFrame >= drainSamples) resolve();
        } catch (error) { captureIssues.push({ error: String(error), ...diagnostic }); fail(`${String(error)}: ${JSON.stringify(diagnostic)}`); }
      };
      video.addEventListener('ended', () => { endedAtFrame = Math.round(context!.currentTime * rate); }, { once: true });
    });
    void capture.catch(() => {}); // begin() awaits and reports this same failure.
    const button = document.createElement('button'); button.id = 'pcm-start'; button.textContent = 'Capture native audio'; document.body.append(button);
    const begin = async () => {
      if (started) throw new Error('duplicate test click');
      started = true; playback = true;
      try {
        if (failures.length) throw new Error(failures.join('; '));
        await timed(context!.resume(), 'audio context resume');
        gate.arm();
        await timed(settled, 'audio clock settle');
        if (failures.length) throw new Error(failures.join('; '));
        await timed(video.play(), 'native play');
        await timed(capture, 'PCM completion', 10000);
        assert('ended at 1.408 seconds', video.ended && Math.abs(video.currentTime - 1.408) <= 1e-6, video.currentTime);
        assert('playback rate is one', video.playbackRate === 1, video.playbackRate);
        assert('actual clock drain >=4096 samples', endedAtFrame !== null && lastEndFrame - endedAtFrame >= drainSamples);
        assert('all token terminals remain once', tokens.every(row => row.terminals.length === 1));
        if (failures.length) throw new Error(failures.join('; '));
        const pcmBytes = new Uint8Array(samples * 4), view = new DataView(pcmBytes.buffer);
        let sample = 0;
        for (const chunk of chunks) for (const value of chunk) view.setFloat32(sample++ * 4, value, true);
        let binary = '';
        for (let i = 0; i < pcmBytes.length; i += 16384) binary += String.fromCharCode(...pcmBytes.subarray(i, i + 16384));
        return { ...metadata(), rate, playbackRate: video.playbackRate, currentTime: video.currentTime, duration: video.duration,
          ended: video.ended, quanta, samples, endedAtFrame, lastEndFrame, drainSamples: lastEndFrame - endedAtFrame!,
          diagnosticRanges, nativeOrder, pcmBase64: btoa(binary), pcmEncoding: 'f32le', maxSamples, maxPcmBytes };
      } catch (error) { return { ...metadata(), failure: String(error) }; }
      finally { await cleanup(); }
    };
    const api = { done: undefined as ReturnType<typeof begin> | undefined };
    button.addEventListener('click', () => { api.done = begin(); }, { once: true });
    Object.assign(window, { mseAudioOrderCapture: api });
    return { kind, ready: true, nativeOrder, assertions };
  } catch (error) { await cleanup(); return { ...metadata(), ready: false, failure: String(error) }; }
}
Object.assign(window, { mseAudioOrder: { prepare } });
