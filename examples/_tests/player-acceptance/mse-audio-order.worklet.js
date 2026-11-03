/** Transfer every native quantum, including silence, without filtering. */
class MseAudioOrderCapture extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const shape = { frame: currentFrame, workletSampleRate: sampleRate,
      renderQuantumSize: typeof globalThis.renderQuantumSize === 'number' ? globalThis.renderQuantumSize : null,
      inputLengths: inputs.map(channels => channels.map(channel => channel.length)),
      outputLengths: outputs.map(channels => channels.map(channel => channel.length)) };
    const samples = new Float32Array(128);
    const input = inputs[0]?.[0];
    try {
      if (input) samples.set(input);
      for (let channel = 0; channel < outputs[0].length; channel++) outputs[0][channel].set(inputs[0]?.[channel] ?? samples);
    } catch (error) {
      this.port.postMessage({ ...shape, copyError: String(error) });
      throw error;
    }
    this.port.postMessage({ ...shape, samples }, [samples.buffer]);
    return true;
  }
}
registerProcessor('mse-audio-order-capture', MseAudioOrderCapture);
