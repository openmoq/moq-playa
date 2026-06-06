/**
 * Control stream framer.
 *
 * Push-based byte accumulator that extracts complete framed control messages
 * from a byte stream. The framer handles the wire format:
 *   Type (varint, 1-8 bytes) + Length (uint16 big-endian, 2 bytes) + Payload (Length bytes)
 *
 * This is transport-agnostic — no WebTransport dependency. It can be used
 * with any byte source (WebTransport, WebSocket, raw QUIC, test harness).
 *
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import { createControlCodec } from '@moqt/transport';
import type { ControlCodec, DecodedControlMessage } from '@moqt/transport';

/** Result of decoding a single framed message. */
export interface FramedMessage {
  /**
   * The decoded control message. Typed as {@link DecodedControlMessage}: a
   * draft-18 response may not carry its Request ID on the wire (the request
   * stream is the correlation), so it is supplied by the topology/session
   * before dispatch. For draft-14/16 the Request ID is always present.
   */
  message: DecodedControlMessage;
  /** Total bytes consumed from the stream (type + length + payload). */
  bytesRead: number;
}

/**
 * Push-based control stream framer.
 *
 * Usage:
 * ```
 * const framer = new ControlStreamFramer();
 * framer.push(chunk1);
 * framer.push(chunk2);
 * const messages = framer.drain(); // returns all complete messages
 * ```
 */
export class ControlStreamFramer {
  /** Accumulated bytes not yet consumed. */
  private buffer: Uint8Array = new Uint8Array(0);

  /** Codec used for decoding and frame size peeking. */
  private readonly codec: ControlCodec;

  constructor(codec?: ControlCodec) {
    this.codec = codec ?? createControlCodec();
  }

  /**
   * Push a chunk of bytes into the accumulator.
   * @param chunk Bytes received from the stream
   */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      // Append chunk to existing buffer
      const newBuf = new Uint8Array(this.buffer.length + chunk.length);
      newBuf.set(this.buffer, 0);
      newBuf.set(chunk, this.buffer.length);
      this.buffer = newBuf;
    }
  }

  /**
   * Extract all complete messages from the buffer.
   * Incomplete trailing bytes are retained for the next push.
   * @returns Array of decoded messages with bytesRead counts
   */
  drain(): FramedMessage[] {
    const results: FramedMessage[] = [];

    while (this.buffer.length > 0) {
      // Check if we have enough bytes to determine the frame size.
      // Minimum: 1 byte (type varint) + 2 bytes (uint16 length) = 3 bytes
      const frameSize = this.peekFrameSize();
      if (frameSize === undefined) break;

      if (this.buffer.length < frameSize) break;

      // We have a complete frame — decode it.
      // peekFrameSize() already confirmed we have enough bytes for the full frame,
      // so any exception here is a genuine decode error (unknown type, payload
      // mismatch, etc.) — NOT "not enough data".
      // §9: "An endpoint that receives an unknown message type MUST close the session."
      // §9: "If the length does not match... MUST close the session with PROTOCOL_VIOLATION."
      try {
        const { message, bytesRead } = this.codec.decode(this.buffer, 0);
        results.push({ message, bytesRead });
        // Consume the bytes
        this.buffer = this.buffer.subarray(bytesRead);
      } catch (err) {
        // Skip the bad frame so the buffer is not permanently stalled.
        this.buffer = this.buffer.subarray(frameSize);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    return results;
  }

  /**
   * Peek at the buffer to determine the total frame size, or undefined
   * if we don't have enough bytes to know yet.
   *
   * Delegates to the codec's peekFrameSize() which handles draft-specific
   * framing differences.
   */
  private peekFrameSize(): number | undefined {
    return this.codec.peekFrameSize(this.buffer);
  }
}
