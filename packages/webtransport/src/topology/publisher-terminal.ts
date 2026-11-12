import type { WebTransportLike } from '../types.js';

export interface PublisherTerminalOptions {
  readonly reason: Error;
  readonly resetSendStream?: WebTransportLike['resetSendStream'];
}

export class PublisherTerminalFailure extends Error {
  constructor(readonly original: unknown, readonly ended: boolean, readonly receiveOnly = false) {
    super('Publisher terminal did not complete', { cause: original });
  }
}

export async function finishPublisherTerminal(
  writer: WritableStreamDefaultWriter<Uint8Array>, reader: ReadableStreamDefaultReader<Uint8Array>,
  write: () => Promise<void>, options: PublisherTerminalOptions,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Publisher terminal timed out')), 1000);
  });
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline]);
  let written = false, fin: Promise<void> | undefined;
  const cancel = () => reader.cancel(options.reason);
  try {
    try {
      await bounded(write());
      written = true;
      fin = writer.close();
      await bounded(fin);
    } catch (error) {
      void cancel().catch(() => {});
      const reset = bounded(Promise.resolve().then(() => options.resetSendStream
        ? options.resetSendStream(writer, options.reason, fin) : writer.abort(options.reason))).then(() => true, () => false);
      // A missing DONE already violates the forced terminal, independent of reset.
      throw new PublisherTerminalFailure(error, written && await reset);
    }
    try { await bounded(cancel()); }
    catch (error) { throw new PublisherTerminalFailure(error, true, true); }
  } finally { clearTimeout(timer); }
}
