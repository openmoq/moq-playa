import { encodeMessage, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import type { AttachmentTarget } from '@openmoq/devtools-protocol';

/** Pull-driven text export. Each call yields at most one bounded protocol frame. */
export class TraceExport {
  private text: string;
  private offset = 0;
  private index = 0;
  private closed = false;
  private readonly target: AttachmentTarget;
  private readonly requestId: string;
  private readonly exportId: string;

  get done(): boolean { return this.closed; }

  constructor(options: { target: AttachmentTarget; requestId: string; exportId: string; text: string; maxBytes?: number }) {
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid export limit');
    let bytes = 0;
    for (const char of options.text) {
      const point = char.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff) throw new Error('Invalid Unicode in trace export');
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (bytes > maxBytes) throw new Error('Trace export byte limit exceeded');
    }
    this.target = { ...options.target };
    this.requestId = options.requestId;
    this.exportId = options.exportId;
    this.text = options.text;
    // Validate correlation fields at admission, including the empty export.
    this.frame('', true);
  }

  next(): string | null {
    if (this.closed) return null;
    const start = this.offset;
    let end = start, bytes = 0;
    while (end < this.text.length) {
      const point = this.text.codePointAt(end)!;
      const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (bytes + size > 16384) break;
      bytes += size; end += point > 0xffff ? 2 : 1;
    }
    const final = end === this.text.length;
    const frame = this.frame(this.text.slice(start, end), final);
    this.offset = end; this.index++;
    if (final) this.close();
    return frame;
  }

  close(): void { this.closed = true; this.text = ''; }

  private frame(data: string, final: boolean): string {
    return encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION,
      kind: 'export.chunk', requestId: this.requestId, target: this.target,
      exportId: this.exportId, index: this.index, final, data });
  }
}
