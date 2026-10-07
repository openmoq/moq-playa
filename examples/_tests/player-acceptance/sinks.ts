/** Observe successful native draws without changing frame ownership or scheduling. */
export function observeCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')!;
  const original = context.drawImage;
  let pending: { timestampUs: number; width: number; height: number } | undefined;
  let refresh = 0;
  const state = { frames: 0, draws: 0, timestampUs: 0,
    lastDrawTimestampUs: undefined as number | undefined, lastDrawTimeMs: undefined as number | undefined,
    width: 0, height: 0,
    restore() { cancelAnimationFrame(refresh); context.drawImage = original; } };
  // Multiple draws between refreshes overwrite the same surface. Count only
  // the final image available to the next browser refresh, not decode bursts.
  const observeRefresh = () => {
    if (pending) { Object.assign(state, pending); state.frames++; pending = undefined; }
    refresh = requestAnimationFrame(observeRefresh);
  };
  refresh = requestAnimationFrame(observeRefresh);
  context.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    Reflect.apply(original, this, args);
    const frame = args[0];
    if (frame instanceof VideoFrame) {
      state.draws++;
      state.lastDrawTimestampUs = frame.timestamp;
      state.lastDrawTimeMs = performance.now();
      pending = { timestampUs: frame.timestamp, width: frame.displayWidth, height: frame.displayHeight };
    }
  } as typeof original;
  return state;
}

/** Tee the player's post-gain PCM; leave its original speaker connection intact. */
export function observeAudio() {
  const original = AudioNode.prototype.connect;
  const taps: { context: AudioContext; analyser: AnalyserNode; gain: GainNode }[] = [];
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    const destination = args[0];
    if (this instanceof GainNode && destination instanceof AudioDestinationNode
      && this.context instanceof AudioContext && !taps.some((tap) => tap.gain === this)) {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      Reflect.apply(original, this, [analyser]);
      taps.push({ context: this.context, analyser, gain: this });
    }
    return result;
  } as typeof original;
  return { taps, restore() {
    AudioNode.prototype.connect = original;
    for (const tap of taps) tap.gain.disconnect(tap.analyser);
  } };
}
