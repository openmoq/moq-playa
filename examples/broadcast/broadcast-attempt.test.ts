import { describe, it, expect, vi } from 'vitest';
import { BroadcastAttempt } from './broadcast-attempt.js';
import type { BroadcastAttemptDeps, AttemptResources, CaptureHandle, EncoderHandle, SessionLike } from './broadcast-attempt.js';

/**
 * A fully controllable attempt whose steps are NON-ATOMIC — each creates
 * intermediate resources (the real `openSession` builds a transport, then a
 * connection, then performs a handshake, across several awaits) so the tests
 * can cancel or fail *between* those sub-steps.
 */
function controllableAttempt() {
  const disposed: string[] = [];
  const capture: CaptureHandle & { stopped: number } = { stopped: 0, stop() { this.stopped++; disposed.push('capture'); } };
  const encoders: EncoderHandle & { destroyed: number } = { destroyed: 0, destroy() { this.destroyed++; disposed.push('encoders'); } };
  const session = {
    shutdowns: 0,
    shutdown: vi.fn(async function (this: { shutdowns: number }) { this.shutdowns++; disposed.push('session'); }),
  } as unknown as SessionLike & { shutdowns: number };
  const transport = { closed: 0, close() { this.closed++; disposed.push('transport'); } };
  const connection = { closed: 0, close: async function () { this.closed++; disposed.push('connection'); } };

  let releaseCaptureStart!: () => void;
  let failCaptureStart!: (e: Error) => void;
  let releaseTransport!: () => void;
  let failTransport!: (e: Error) => void;
  let releaseHandshake!: () => void;
  let failHandshake!: (e: Error) => void;
  let releaseNamespace!: () => void;
  let failNamespace!: (e: Error) => void;
  let failEncoderConfig = false;
  const wirePublication = vi.fn();

  const deps: BroadcastAttemptDeps = {
    // Non-atomic: the handle exists (and must be owned) BEFORE the start
    // operation resolves.
    startCapture: async (ctx: AttemptResources) => {
      ctx.adopt(capture, (c) => c.stop());
      await new Promise<void>((res, rej) => { releaseCaptureStart = res; failCaptureStart = rej; });
      ctx.throwIfCancelled();
      return capture;
    },
    // Non-atomic: video encoder is created and owned before audio config,
    // which may throw.
    createEncoders: (ctx: AttemptResources) => {
      ctx.adopt(encoders, (e) => e.destroy());
      if (failEncoderConfig) throw new Error('audio encoder config failed');
      return encoders;
    },
    // Non-atomic: transport, then connection, then handshake.
    openSession: async (ctx: AttemptResources) => {
      await new Promise<void>((res, rej) => { releaseTransport = res; failTransport = rej; });
      ctx.adopt(transport, (t) => t.close());
      ctx.throwIfCancelled();
      ctx.adopt(connection, (c) => c.close());
      // Cancellation must reach the in-progress handshake.
      ctx.onCancel(() => { failHandshake?.(new Error('handshake aborted by cancel')); });
      await new Promise<void>((res, rej) => { releaseHandshake = res; failHandshake = rej; });
      ctx.throwIfCancelled();
      ctx.adopt(session, (s) => s.shutdown());
      return session;
    },
    publishNamespace: async (ctx: AttemptResources) => {
      await new Promise<void>((res, rej) => { releaseNamespace = res; failNamespace = rej; });
      ctx.throwIfCancelled();
    },
    wirePublication,
  };
  const attempt = new BroadcastAttempt(deps);
  return {
    attempt, capture, encoders, session, transport, connection, wirePublication, disposed,
    setEncoderConfigFailure: () => { failEncoderConfig = true; },
    releaseCaptureStart: () => releaseCaptureStart(), failCaptureStart: (e: Error) => failCaptureStart(e),
    releaseTransport: () => releaseTransport(), failTransport: (e: Error) => failTransport(e),
    releaseHandshake: () => releaseHandshake(), failHandshake: (e: Error) => failHandshake(e),
    releaseNamespace: () => releaseNamespace(), failNamespace: (e: Error) => failNamespace(e),
  };
}

async function settle() { await new Promise((r) => setTimeout(r, 0)); }

/** Drive an attempt all the way to 'completed'. */
async function runToCompletion(a: ReturnType<typeof controllableAttempt>) {
  const run = a.attempt.run();
  a.releaseCaptureStart(); await settle();
  a.releaseTransport(); await settle();
  a.releaseHandshake(); await settle();
  a.releaseNamespace();
  return run;
}

describe('BroadcastAttempt — completion', () => {
  it('adopts every resource and wires publication', async () => {
    const a = controllableAttempt();
    await expect(runToCompletion(a)).resolves.toBe('completed');
    expect(a.wirePublication).toHaveBeenCalledTimes(1);
    expect(a.disposed).toEqual([]); // nothing torn down on the happy path
  });
});

describe('BroadcastAttempt — partial-resource ownership', () => {
  it('a capture whose START fails still stops the already-created handle', async () => {
    const a = controllableAttempt();
    const run = a.attempt.run();
    a.failCaptureStart(new Error('getUserMedia denied'));
    await expect(run).rejects.toThrow('getUserMedia denied');
    expect(a.capture.stopped).toBe(1); // adopted before the failure → still disposed
  });

  it('an encoder config failure destroys the encoders created before it', async () => {
    const a = controllableAttempt();
    a.setEncoderConfigFailure();
    const run = a.attempt.run();
    a.releaseCaptureStart();
    await expect(run).rejects.toThrow('audio encoder config failed');
    expect(a.encoders.destroyed).toBe(1);
    expect(a.capture.stopped).toBe(1);
  });

  it('a HANDSHAKE failure closes the transport and connection created before it', async () => {
    const a = controllableAttempt();
    const run = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    a.releaseTransport(); await settle();
    a.failHandshake(new Error('relay unreachable'));
    await expect(run).rejects.toThrow('relay unreachable');
    // The partially-built session resources must not leak.
    expect(a.transport.closed).toBe(1);
    expect(a.connection.closed).toBe(1);
    expect(a.encoders.destroyed).toBe(1);
    expect(a.capture.stopped).toBe(1);
  });

  it('disposes resources in LIFO order (newest first)', async () => {
    const a = controllableAttempt();
    const run = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    a.releaseTransport(); await settle();
    a.failHandshake(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
    expect(a.disposed).toEqual(['connection', 'transport', 'encoders', 'capture']);
  });

  it('a resource adopted AFTER cancellation began is still disposed (never leaked)', async () => {
    const a = controllableAttempt();
    const run = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    // Cancel while openSession is awaiting its transport — the transport is
    // created (and adopted) only AFTER cancellation has started.
    const cancelPromise = a.attempt.cancel();
    a.releaseTransport();
    await expect(run).resolves.toBe('cancelled');
    await cancelPromise;
    expect(a.transport.closed).toBe(1); // adopted post-cancel → disposed anyway
    expect(a.capture.stopped).toBe(1);
  });
});

describe('BroadcastAttempt — cancellation reaches in-progress work', () => {
  it('cancel() aborts an in-progress handshake instead of waiting for it', async () => {
    const a = controllableAttempt();
    const run = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    a.releaseTransport(); await settle(); // now awaiting the handshake

    // No handshake release/failure from the test — cancel must break it.
    await a.attempt.cancel();
    await expect(run).resolves.toBe('cancelled');
    expect(a.transport.closed).toBe(1);
    expect(a.connection.closed).toBe(1);
  });

  it('cancel() AWAITS late session shutdown — run() never completes before teardown', async () => {
    const a = controllableAttempt();
    let releaseShutdown!: () => void;
    (a.session.shutdown as unknown as { mockImplementation: (f: () => Promise<void>) => void })
      .mockImplementation(() => new Promise<void>((resolve) => { releaseShutdown = () => resolve(); }));

    const run = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    a.releaseTransport(); await settle();
    a.releaseHandshake(); await settle(); // session adopted, awaiting namespace
    const cancelPromise = a.attempt.cancel();
    a.releaseNamespace();

    let cancelDone = false;
    void cancelPromise.then(() => { cancelDone = true; });
    await settle();
    expect(cancelDone).toBe(false); // still awaiting the session's shutdown

    releaseShutdown();
    await cancelPromise;
    expect(cancelDone).toBe(true);
  });

  it('a REJECTING late session shutdown is contained (no unhandled rejection, cancel resolves)', async () => {
    const a = controllableAttempt();
    (a.session.shutdown as unknown as { mockRejectedValue: (e: Error) => void })
      .mockRejectedValue(new Error('shutdown blew up'));
    const run = await runToCompletion(a);
    expect(run).toBe('completed');
    await expect(a.attempt.cancel()).resolves.toBeUndefined();
  });

  it('a throwing disposer does not prevent the remaining resources from being disposed', async () => {
    const a = controllableAttempt();
    a.connection.close = async () => { throw new Error('close blew up'); };
    const run = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    a.releaseTransport(); await settle();
    a.failHandshake(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
    expect(a.transport.closed).toBe(1); // disposal continued past the throw
    expect(a.capture.stopped).toBe(1);
  });
});

describe('BroadcastAttempt — overlapping start/stop transactions', () => {
  it('stop A during CAPTURE → start B → release A: A disposes only its own resources', async () => {
    const a = controllableAttempt();
    const runA = a.attempt.run();
    void a.attempt.cancel();

    const b = controllableAttempt();
    await expect(runToCompletion(b)).resolves.toBe('completed');

    a.releaseCaptureStart();
    await expect(runA).resolves.toBe('cancelled');
    expect(a.capture.stopped).toBe(1);
    expect(b.capture.stopped).toBe(0);
    expect(b.session.shutdowns).toBe(0);
    expect(b.wirePublication).toHaveBeenCalledTimes(1);
  });

  it('stop A during the HANDSHAKE → start B → A fails late: A is quiet, B untouched', async () => {
    const a = controllableAttempt();
    const runA = a.attempt.run();
    a.releaseCaptureStart(); await settle();
    a.releaseTransport(); await settle();
    void a.attempt.cancel();

    const b = controllableAttempt();
    await expect(runToCompletion(b)).resolves.toBe('completed');

    // A cancelled attempt's late failure is not an error and must not throw.
    await expect(runA).resolves.toBe('cancelled');
    expect(a.transport.closed).toBe(1);
    expect(b.transport.closed).toBe(0);
    expect(b.session.shutdowns).toBe(0);
  });

  it('cancel() is single-flight: concurrent cancels share one teardown', async () => {
    const a = controllableAttempt();
    await runToCompletion(a);
    const c1 = a.attempt.cancel();
    const c2 = a.attempt.cancel();
    expect(c2).toBe(c1);
    await c1;
    expect(a.session.shutdowns).toBe(1);
    expect(a.capture.stopped).toBe(1);
  });
});

describe('BroadcastAttempt — deferred disposal is awaited (never a leaked acquisition)', () => {
  it('run() is the final barrier: it reports cancelled only after a post-cancel acquisition has been disposed', async () => {
    // The reported repro: run() returned 'cancelled' with disposeStarted=true
    // but disposeFinished=false, so a camera acquired after Stop stayed live.
    //
    // Contract, stated precisely: cancel() covers what is outstanding when it
    // is CALLED — it cannot await an acquisition still pending inside a step
    // (a camera-permission prompt is not cancellable). run() is the final
    // barrier, and a cancel() issued after the late disposal starts awaits it.
    const a = controllableAttempt();
    let disposeStarted = false;
    let disposeFinished = false;
    let releaseDispose!: () => void;

    const deps = {
      startCapture: async (ctx: AttemptResources) => {
        // Acquisition completes only after cancellation has begun.
        await new Promise<void>((res) => { releaseCapture = res; });
        ctx.adopt({ tag: 'late-camera' }, async () => {
          disposeStarted = true;
          await new Promise<void>((res) => { releaseDispose = () => res(); });
          disposeFinished = true;
        });
        ctx.throwIfCancelled();
        return { stop: () => {} };
      },
      createEncoders: () => ({ destroy: () => {} }),
      openSession: async () => a.session,
      publishNamespace: async () => {},
      wirePublication: () => {},
    } as unknown as BroadcastAttemptDeps;
    let releaseCapture!: () => void;
    const attempt = new BroadcastAttempt(deps);

    const run = attempt.run();
    await settle();
    void attempt.cancel();      // Stop pressed while the camera prompt is open
    releaseCapture();           // permission granted afterwards
    await settle();
    expect(disposeStarted).toBe(true);

    let runResolved = false;
    void run.then(() => { runResolved = true; });
    await settle();
    // run() must NOT report cancelled while the disposal is still unfinished.
    expect(runResolved).toBe(false);
    expect(disposeFinished).toBe(false);

    // A cancel() issued NOW — after the late disposal has begun — does own it.
    let lateCancelDone = false;
    void attempt.cancel().then(() => { lateCancelDone = true; });
    await settle();
    expect(lateCancelDone).toBe(false);
    expect(disposeFinished).toBe(false);

    releaseDispose();
    await expect(run).resolves.toBe('cancelled');
    expect(disposeFinished).toBe(true);
    await attempt.cancel();
    expect(lateCancelDone).toBe(true);
  });

  it('re-adopting a handle after its acquisition completes disposes it even though a teardown pass already ran', async () => {
    // How a step handles "the resource became real after Stop": adopt again.
    const stopped: string[] = [];
    let releaseStart!: () => void;
    const handle = { live: false, stop() { if (this.live) stopped.push('stream'); } };

    const deps = {
      startCapture: async (ctx: AttemptResources) => {
        ctx.adopt(handle, (h) => h.stop());           // owns the empty handle
        await new Promise<void>((res) => { releaseStart = res; });
        handle.live = true;                            // the stream is now real
        ctx.adopt(handle, (h) => h.stop());            // re-adopt the ACQUIRED thing
        ctx.throwIfCancelled();
        return { stop: () => {} };
      },
      createEncoders: () => ({ destroy: () => {} }),
      openSession: async () => ({ shutdown: async () => {} }),
      publishNamespace: async () => {},
      wirePublication: () => {},
    } as unknown as BroadcastAttemptDeps;
    const attempt = new BroadcastAttempt(deps);

    const run = attempt.run();
    await settle();
    void attempt.cancel();   // first teardown pass: handle not live yet, stop() is a no-op
    releaseStart();
    await expect(run).resolves.toBe('cancelled');
    expect(stopped).toEqual(['stream']); // the live stream WAS stopped
  });
});

describe('BroadcastAttempt — synchronous retire of local resources', () => {
  it('onCancel hooks run SYNCHRONOUSLY inside cancel(), before any awaited disposal', async () => {
    // Capture and encoders must stop the instant Stop is pressed — not after a
    // multi-second bounded network shutdown further down the LIFO chain.
    const order: string[] = [];
    let releaseSessionShutdown!: () => void;
    const deps = {
      startCapture: async (ctx: AttemptResources) => {
        const cap = { stop: () => order.push('capture.stop') };
        ctx.onCancel(() => cap.stop());
        return cap;
      },
      createEncoders: (ctx: AttemptResources) => {
        const enc = { destroy: () => order.push('encoders.destroy') };
        ctx.onCancel(() => enc.destroy());
        return enc;
      },
      openSession: async (ctx: AttemptResources) => {
        const sess = {
          shutdown: async () => {
            order.push('session.shutdown:start');
            await new Promise<void>((res) => { releaseSessionShutdown = () => res(); });
            order.push('session.shutdown:end');
          },
        };
        ctx.adopt(sess, (s) => s.shutdown());
        return sess;
      },
      publishNamespace: async () => {},
      wirePublication: () => {},
    } as unknown as BroadcastAttemptDeps;
    const attempt = new BroadcastAttempt(deps);
    await expect(attempt.run()).resolves.toBe('completed');

    const cancelPromise = attempt.cancel();
    // Synchronously after cancel() returns, capture and encoders are already
    // retired while the session's bounded shutdown has only just begun.
    expect(order).toEqual(['capture.stop', 'encoders.destroy', 'session.shutdown:start']);

    releaseSessionShutdown();
    await cancelPromise;
    expect(order[order.length - 1]).toBe('session.shutdown:end');
  });
});
