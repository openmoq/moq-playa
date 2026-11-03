/** Observe native buffer identity, offsets and delegated retypes without placement. */
export function observeNativeMse() {
  const add = MediaSource.prototype.addSourceBuffer;
  const change = SourceBuffer.prototype.changeType;
  if (typeof change !== 'function') throw new Error('Native SourceBuffer.changeType is required');
  const buffers: { buffer: SourceBuffer; mime: string }[] = [];
  const calls: { timeMs: number; bufferId: number; mime: string; offsetBefore: number; offsetAfter: number | null; error: string | null }[] = [];
  const addObserved: typeof add = function (this: MediaSource, mime) {
    const buffer = Reflect.apply(add, this, arguments) as SourceBuffer;
    buffers.push({ buffer, mime });
    return buffer;
  };
  const changeObserved: typeof change = function (this: SourceBuffer, mime) {
    const call = { timeMs: performance.now(), bufferId: buffers.findIndex(entry => entry.buffer === this),
      mime, offsetBefore: this.timestampOffset, offsetAfter: null as number | null, error: null as string | null };
    calls.push(call);
    try { return Reflect.apply(change, this, arguments); }
    catch (error) { call.error = String(error); throw error; }
    finally { call.offsetAfter = this.timestampOffset; }
  };
  MediaSource.prototype.addSourceBuffer = addObserved;
  SourceBuffer.prototype.changeType = changeObserved;
  return {
    snapshot: () => ({ calls: calls.map(call => ({ ...call })),
      buffers: buffers.map(({ buffer, mime }, id) => ({ id, mime, offset: buffer.timestampOffset })) }),
    restore() {
      if (MediaSource.prototype.addSourceBuffer === addObserved) MediaSource.prototype.addSourceBuffer = add;
      if (SourceBuffer.prototype.changeType === changeObserved) SourceBuffer.prototype.changeType = change;
    },
  };
}
