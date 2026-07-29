import { describe, it, expect } from 'vitest';
import { acceptCatalogSubscribe } from './catalog-publisher.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';
import { parseCatalog } from '@moqt/msf';

const PARAMS: BroadcastCatalogParams = {
  videoCodec: 'avc1.42001f',
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrate: 2_000_000,
  audio: { sampleRate: 48_000, channels: 1 },
};
const D16 = { draft: 16 as const };

/**
 * Records every connection call, INCLUDING any terminal the implementation
 * might try to send: publishDone is present on the mock precisely so that a
 * regression reintroducing it is observed rather than thrown on.
 */
function recordingConnection() {
  const calls: string[] = [];
  const sent: Uint8Array[] = [];
  const openOptions: Array<Record<string, unknown>> = [];
  const terminals: Array<{ requestId: unknown; statusCode: unknown; reason: string }> = [];
  const rejections: string[] = [];
  return {
    calls,
    sent,
    openOptions,
    terminals,
    rejections,
    acceptSubscribe: async () => { calls.push('acceptSubscribe'); },
    openSubgroup: async (_alias: unknown, _gid: unknown, _sgid: unknown, options: Record<string, unknown>) => {
      calls.push('openSubgroup'); openOptions.push(options); return 7n;
    },
    sendObject: async (_sid: bigint, _oid: unknown, payload: Uint8Array) => {
      calls.push('sendObject');
      sent.push(payload);
    },
    rejectSubscribe: async (_requestId: unknown, _code: unknown, reason: string) => {
      calls.push('rejectSubscribe'); rejections.push(reason);
    },
    closeSubgroup: async () => { calls.push('closeSubgroup'); },
    publishDone: async (requestId: unknown, statusCode: unknown, reason: string) => {
      calls.push('publishDone');
      terminals.push({ requestId, statusCode, reason });
    },
    close: async () => { calls.push('close'); },
    unsubscribe: async () => { calls.push('unsubscribe'); },
  };
}

describe('broadcast catalog subscription lifecycle', () => {
  it('accepts the subscribe and sends one parseable catalog object', async () => {
    const conn = recordingConnection();
    const bytes = await acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, D16);

    expect(conn.calls).toEqual(['acceptSubscribe', 'openSubgroup', 'sendObject', 'closeSubgroup']);
    expect(conn.sent).toHaveLength(1);
    expect(bytes).toBe(conn.sent[0]!.byteLength);

    const catalog = parseCatalog(conn.sent[0]!);
    const names = catalog.tracks.map((t) => t.name).sort();
    expect(names).toEqual(['audio', 'video']);
  });

  it('leaves the catalog subscription established: no terminal is sent for a live broadcast', async () => {
    // The catalog track must stay live for viewers that join later and for
    // future delta updates; ending it at broadcast start makes relays treat
    // the track as over (observed: a relay leaving subsequent catalog
    // SUBSCRIBEs unanswered after the upstream terminal).
    const conn = recordingConnection();
    await acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, D16);

    expect(conn.calls).not.toContain('publishDone');
    expect(conn.calls).not.toContain('unsubscribe');
    // closeSubgroup ends the DATA STREAM (mojito's `defer stream.Close()`),
    // which is not a subscription terminal — it must still happen.
    expect(conn.calls).toContain('closeSubgroup');
  });

  it('builds the catalog BEFORE accepting: a build failure never leaves an accepted subscription', async () => {
    const conn = recordingConnection();
    // Fail during the BUILD phase specifically: the params are read while
    // assembling the catalog, so a throw here lands before acceptance iff the
    // build genuinely precedes it.
    const exploding: BroadcastCatalogParams = { ...PARAMS };
    Object.defineProperty(exploding, 'videoCodec', {
      get() { throw new Error('catalog build failed'); },
    });
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, exploding, D16)).rejects.toThrow('catalog build failed');
    // Never accepted — but the request MUST still be answered. Leaving a
    // SUBSCRIBE with no response is exactly the silent-request defect we
    // reported to a relay vendor; we must not ship it ourselves.
    expect(conn.calls).not.toContain('acceptSubscribe');
    expect(conn.calls).toContain('rejectSubscribe');
    expect(conn.rejections[0]).toMatch(/catalog/i);
  });

  it('when the REJECT itself fails, the session is closed rather than leaving the request silent', async () => {
    const conn = recordingConnection();
    conn.rejectSubscribe = async () => { throw new Error('control write failed'); };
    const exploding: BroadcastCatalogParams = { ...PARAMS };
    Object.defineProperty(exploding, 'videoCodec', {
      get() { throw new Error('catalog build failed'); },
    });
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, exploding, D16)).rejects.toThrow('catalog build failed');
    expect(conn.calls).toContain('close');
  });

  it('a stuck best-effort stream close cannot delay the error terminal indefinitely', async () => {
    // The terminal is what un-strands the subscriber; a hung closeSubgroup on
    // the failed data stream must not hold it up.
    const conn = recordingConnection();
    conn.sendObject = async () => { throw new Error('stream reset'); };
    conn.closeSubgroup = () => new Promise<void>(() => { /* never settles */ });
    const start = Date.now();
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, { draft: 16 as const, terminalCloseDeadlineMs: 20 }))
      .rejects.toThrow('stream reset');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(conn.calls).toContain('publishDone'); // the terminal still went out
  });

  it('a failed openSubgroup after acceptance sends an explicit error terminal (never silent)', async () => {
    const conn = recordingConnection();
    conn.openSubgroup = async () => { throw new Error('no streams available'); };
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, D16)).rejects.toThrow('no streams available');
    // The subscription was ESTABLISHED by acceptSubscribe — it must not be
    // left established with no catalog and no terminal.
    expect(conn.calls).toContain('acceptSubscribe');
    expect(conn.calls).toContain('publishDone');
    expect(Number(conn.terminals[0]!.statusCode)).toBe(0x0); // INTERNAL_ERROR
  });

  it('a failed sendObject closes the data stream AND sends an explicit error terminal', async () => {
    const conn = recordingConnection();
    conn.sendObject = async () => { throw new Error('stream reset'); };
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, D16)).rejects.toThrow('stream reset');
    expect(conn.calls).toContain('closeSubgroup'); // no leaked open subgroup
    expect(conn.calls).toContain('publishDone');
    expect(Number(conn.terminals[0]!.statusCode)).toBe(0x0);
  });

  it('a failed clean-FIN is a FAILURE, not success: it terminals and rejects', async () => {
    const conn = recordingConnection();
    conn.closeSubgroup = async () => { throw new Error('FIN failed'); };
    // Without a clean FIN the receiver cannot tell the catalog group ended —
    // reporting success (and "Broadcasting") would be a lie.
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, D16)).rejects.toThrow('FIN failed');
    expect(conn.calls).toContain('publishDone');
  });

  it('when the error terminal ITSELF fails, the session is closed rather than left silent', async () => {
    const conn = recordingConnection();
    conn.sendObject = async () => { throw new Error('stream reset'); };
    conn.publishDone = async () => { throw new Error('control write failed'); };
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, D16)).rejects.toThrow('stream reset');
    // Last resort: an established subscription we cannot terminate means the
    // session itself must go — never an established, silent catalog.
    expect(conn.calls).toContain('close');
  });

  it('omits the audio track when the capture has none', async () => {
    const conn = recordingConnection();
    const { audio: _audio, ...noAudio } = PARAMS;
    await acceptCatalogSubscribe(conn, 1n, 1n, noAudio, D16);
    const catalog = parseCatalog(conn.sent[0]!);
    expect(catalog.tracks.map((t) => t.name)).toEqual(['video']);
  });

  it('draft-18 sets FIRST_OBJECT on the catalog subgroup; 16/14 do not', async () => {
    for (const draft of [14, 16, 18] as const) {
      const conn = recordingConnection();
      await acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, { draft });
      const options = conn.openOptions[0]!;
      if (draft === 18) {
        expect(options['firstObject']).toBe(true);
      } else {
        expect('firstObject' in options).toBe(false);
      }
    }
  });
});

describe('catalog error responses are bounded end to end', () => {
  it('a HANGING publishDone still reaches the session-close fallback within the deadline', async () => {
    // Bounding only the stream close is not enough: if the terminal itself
    // never settles, the accepted subscription stays silent forever and the
    // session-close fallback never runs.
    const conn = recordingConnection();
    conn.sendObject = async () => { throw new Error('stream reset'); };
    conn.publishDone = () => new Promise<void>(() => { /* never settles */ });
    const start = Date.now();
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, { draft: 16 as const, terminalCloseDeadlineMs: 20 }))
      .rejects.toThrow('stream reset');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(conn.calls).toContain('close'); // fell back to closing the session
  });

  it('a HANGING rejectSubscribe still reaches the session-close fallback within the deadline', async () => {
    const conn = recordingConnection();
    conn.rejectSubscribe = () => new Promise<void>(() => { /* never settles */ });
    const exploding: BroadcastCatalogParams = { ...PARAMS };
    Object.defineProperty(exploding, 'videoCodec', {
      get() { throw new Error('catalog build failed'); },
    });
    const start = Date.now();
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, exploding, { draft: 16 as const, terminalCloseDeadlineMs: 20 }))
      .rejects.toThrow('catalog build failed');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(conn.calls).toContain('close');
  });

  it.each([NaN, Infinity, 0, -5, 1.5])('rejects an invalid terminalCloseDeadlineMs of %s', async (value) => {
    const conn = recordingConnection();
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, { draft: 16 as const, terminalCloseDeadlineMs: value }))
      .rejects.toThrow(/terminalCloseDeadlineMs must be a positive/i);
    // Validation happens before ANY wire effect.
    expect(conn.calls).toEqual([]);
  });

  it('a SUCCESSFUL send whose FIN never settles fails closed within the deadline', async () => {
    // The FIN is part of the success criterion, so awaiting it unbounded would
    // hang broadcast startup and never reach the terminal path — the accepted
    // catalog subscription would stay silent forever.
    const conn = recordingConnection();
    conn.closeSubgroup = () => new Promise<void>(() => { /* never settles */ });
    const start = Date.now();
    await expect(acceptCatalogSubscribe(conn, 1n, 1n, PARAMS, { draft: 16 as const, terminalCloseDeadlineMs: 20 }))
      .rejects.toThrow(/did not settle/i);
    expect(Date.now() - start).toBeLessThan(2000);
    // The subscription was accepted, so it is owed a terminal.
    expect(conn.calls).toContain('acceptSubscribe');
    expect(conn.calls).toContain('publishDone');
  });
});
