/** Structural inputs to an armed Opus proof; not native PCM or clock proof. */
export interface OpusSourceProfile {
  readonly channels: 1 | 2;
  readonly preSkip48k: number;
  /** Coded sample-count units, not a claim about native decoder output rate. */
  readonly codedSampleRate: 48000;
}

export interface OpusPacketSamples {
  /** Samples per channel at 48kHz, before any pre-skip. */
  readonly codedSamples48k: number;
}

/**
 * Inspect the actual applied OpusHead (RFC7845 §5.1). This deliberately narrow
 * profile supports only version1, mapping family0, mono/stereo. Null means
 * unavailable for this proof, not necessarily an invalid future/other stream.
 * Absent-description defaults and actual native48k checks belong to the caller.
 */
export function inspectOpusHead(description: Uint8Array): OpusSourceProfile | null {
  if (description.length !== 19 || description[8] !== 1 || description[18] !== 0) return null;
  const magic = 'OpusHead';
  for (let i = 0; i < magic.length; i++) if (description[i] !== magic.charCodeAt(i)) return null;
  const channels = description[9], low = description[10], high = description[11];
  if ((channels !== 1 && channels !== 2) || low === undefined || high === undefined) return null;
  // Input sample rate is advisory; output gain does not change sample counts.
  return Object.freeze({ channels, preSkip48k: low + high * 256, codedSampleRate: 48000 });
}

/**
 * Validate RFC6716 §§3.1–3.4 framing of ONE ordinary single-stream Opus packet.
 * No entropy decoding: success establishes only its structural coded duration.
 * Valid zero-length DTX/loss frames are excluded because they cannot prove
 * ordinary native PCM here. Padding bytes may have any value (receiver rule).
 * Caller owns an unchanged actual-byte snapshot, provenance, budgets and every
 * generation/native-output check. No source bytes are retained or modified.
 */
export function inspectOpusPacket(packet: Uint8Array): OpusPacketSamples | null {
  const toc = packet[0];
  if (toc === undefined) return null;
  const config = toc >> 3;
  const samples = config < 12 ? (config % 4 === 3 ? 2880 : 480 * 2 ** (config % 4))
    : config < 16 ? 480 * 2 ** (config % 2) : 120 * 2 ** (config % 4);
  const code = toc & 3;
  if (code === 0) return frameSizeSupported(packet.length - 1) ? counted(samples) : null;
  if (code === 1) {
    const bytes = packet.length - 1;
    return bytes % 2 === 0 && frameSizeSupported(bytes / 2) ? counted(samples * 2) : null;
  }
  if (code === 2) {
    const first = readFrameSize(packet, 1, packet.length);
    return first && frameSizeSupported(first.size) && frameSizeSupported(packet.length - first.next - first.size)
      ? counted(samples * 2) : null;
  }

  const control = packet[1];
  if (control === undefined) return null;
  const count = control & 63, total = samples * count;
  if (count === 0 || total > 5760) return null;
  let cursor = 2, padding = 0;
  if ((control & 64) !== 0) {
    let byte: number;
    do {
      const value = packet[cursor++];
      if (value === undefined) return null;
      byte = value;
      padding += byte === 255 ? 254 : byte;
      if (padding > packet.length - cursor) return null;
    } while (byte === 255);
  }
  const end = packet.length - padding;
  if ((control & 128) === 0) {
    const bytes = end - cursor;
    return bytes % count === 0 && frameSizeSupported(bytes / count) ? counted(total) : null;
  }
  let precedingBytes = 0;
  for (let i = 0; i < count - 1; i++) {
    const frame = readFrameSize(packet, cursor, end);
    if (!frame || !frameSizeSupported(frame.size)) return null;
    cursor = frame.next;
    precedingBytes += frame.size;
  }
  return frameSizeSupported(end - cursor - precedingBytes) ? counted(total) : null;
}

function frameSizeSupported(size: number): boolean {
  return Number.isInteger(size) && size > 0 && size <= 1275;
}

function counted(samples: number): OpusPacketSamples {
  return Object.freeze({ codedSamples48k: samples });
}

function readFrameSize(packet: Uint8Array, cursor: number, end: number): { size: number; next: number } | null {
  if (cursor >= end) return null;
  const first = packet[cursor];
  if (first === undefined) return null;
  if (first < 252) return { size: first, next: cursor + 1 };
  const second = cursor + 1 < end ? packet[cursor + 1] : undefined;
  return second === undefined ? null : { size: first + second * 4, next: cursor + 2 };
}
