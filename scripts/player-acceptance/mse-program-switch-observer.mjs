// @ts-check
import { CmafAssembler } from '@openmoq/browser';
import { readFirstSamplePresentationTime, readMdhdTimescale, readSegmentTimeRanges, readTrexDefaults } from '../../packages/browser/src/mp4-box.js';

/**
 * Fixture-only sensor: one complete CMAF chunk per push, unchanged sample data.
 * Raw PTS is read before the real assembler, then the emitted bytes are matched
 * to the real MSE submission and its update/updateend-backed terminal. A native
 * frame's source PTS is not observable here; the driver separately checks rVFC.
 */
export function observeMseProgramSwitch() {
  /** @typedef {import('./mse-program-switch-observer.mjs').MseProgramSegment} Segment */
  /** @type {Segment[]} */ const segments = [];
  /** @type {import('./mse-program-switch-observer.mjs').MseProgramObserverSnapshot['queues']} */ const queues = [];
  /** @type {string[]} */ const failures = [];
  /** @type {Map<Segment, Uint8Array>} */ const payloads = new Map();
  /** @type {Map<object, Segment>} */ const pending = new Map();
  /** @type {WeakSet<object>} */ const completed = new WeakSet();
  /** @type {Set<() => void>} */ const cleanup = new Set();
  let sources = 0, overflow = false, disposed = false, refuseQueue = false, retainedBytes = 0;
  const fail = /** @param {string} reason */ reason => { if (failures.length < 32) failures.push(reason); else overflow = true; };
  const sameBytes = /** @param {Uint8Array} a @param {Uint8Array} b */ (a, b) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  const snapshot = () => ({ sources, overflow, failures: [...failures], segments: segments.map(record => ({ ...record })),
    queues: queues.map(record => ({ ...record, roles: [...record.roles] })) });
  return {
    /** @template {import('../../packages/player/src/interfaces.js').MediaSourceLike} T @param {T} source @returns {T} */
    source(source) {
      if (disposed) throw new Error('MSE program sensor is disposed');
      if (++sources !== 1 || !source.observeAppends || !source.holdQueuedAppends) {
        fail('missing or replaced observable native source'); return source;
      }
      const append = source.appendChunk, hold = source.holdQueuedAppends;
      const remove = source.observeAppends(event => {
        if (completed.has(event.token)) { fail('duplicate append terminal'); return; }
        const record = pending.get(event.token);
        if (!record) return;
        pending.delete(event.token);
        completed.add(event.token);
        if (record.state !== 'submitted') { fail('duplicate append terminal'); return; }
        record.state = event.state; record.reason = event.reason; record.completedAtMs = performance.now();
      });
      /** @type {typeof source.appendChunk} */
      const observedAppend = function (...args) {
        if (disposed) return Reflect.apply(append, source, args);
        const [type, bytes, name, group, token, sourceKey] = args;
        const record = [...segments].reverse().find(candidate => {
          const stored = payloads.get(candidate);
          return candidate.state === 'assembled' && candidate.mediaType === type && candidate.trackName === name
            && candidate.sourceKey === (sourceKey ?? null) && candidate.groupId === String(group)
            && stored !== undefined && sameBytes(stored, bytes);
        });
        if (!record) fail('submission without matching assembler bytes');
        const ownedToken = token ?? {};
        if (record) {
          payloads.delete(record); retainedBytes -= bytes.byteLength;
          record.state = 'submitted'; record.submittedAtMs = performance.now();
          const offset = source.getTimestampOffset?.(type);
          record.offset = typeof offset === 'number' && Number.isFinite(offset) ? offset : null;
          if (pending.has(ownedToken) || pending.size >= 256) { overflow = true; fail('append token unavailable'); }
          else pending.set(ownedToken, record);
        }
        // Supply a forensic token only when the engine supplied none. Existing
        // tokens, bytes, labels, source keys and native return values are retained.
        args[4] = ownedToken;
        try { return Reflect.apply(append, source, args); }
        catch (error) {
          pending.delete(ownedToken);
          if (record && record.state === 'submitted') {
            record.state = 'discarded'; record.reason = 'synchronous append throw'; record.completedAtMs = performance.now();
          }
          throw error;
        }
      };
      /** @type {typeof source.holdQueuedAppends} */
      const observedHold = function (...args) {
        if (disposed) return Reflect.apply(hold, source, args);
        const refused = refuseQueue; refuseQueue = false;
        if (queues.length >= 32) overflow = true;
        else queues.push({ timeMs: performance.now(), kind: refused ? 'refused' : 'acquire', roles: [...args[0]] });
        // A deterministic API refusal before acquiring or mutating the native
        // queue. This is a rollback control, not a simulated native splice.
        if (refused) throw new Error('MSE acceptance injected queue acquisition refusal');
        return Reflect.apply(hold, source, args);
      };
      source.appendChunk = observedAppend; source.holdQueuedAppends = observedHold;
      cleanup.add(() => {
        remove();
        if (source.appendChunk === observedAppend) source.appendChunk = append;
        if (source.holdQueuedAppends === observedHold) source.holdQueuedAppends = hold;
      });
      return source;
    },
    /** @param {Parameters<NonNullable<import('../../packages/player/src/config.js').MoqtPlayerConfig['createCmafAssembler']>>[0]} callbacks */
    createAssembler(callbacks) {
      if (disposed) throw new Error('MSE program sensor is disposed');
      /** @type {Map<'video' | 'audio', { scale: number | null; trex: import('../../packages/browser/src/mp4-box.js').TrexDefaults | undefined }>} */
      const contexts = new Map();
      /** @type {Array<{ type: 'video' | 'audio'; name: string; group: bigint; key: string | undefined; raw: bigint | null }>} */
      const stack = [];
      const assembler = new CmafAssembler({ ...callbacks, onSegment(...args) {
        const [type, bytes, name, group, , key] = args;
        const producing = stack.at(-1), context = contexts.get(type);
        if (disposed) return Reflect.apply(callbacks.onSegment, callbacks, args);
        if (segments.length >= 2048 || retainedBytes + bytes.byteLength > 32 * 1024 * 1024) overflow = true;
        else {
          const ranges = readSegmentTimeRanges(bytes, context?.trex);
          const pts = readFirstSamplePresentationTime(bytes);
          const matched = producing?.type === type && producing.name === name && producing.group === group && producing.key === key;
          if (!matched || producing.raw === null || pts === null || !context?.scale || ranges?.length !== 1) fail('unscorable fixture source/placement');
          /** @type {Segment} */
          const record = { seq: segments.length, mediaType: type, trackName: name, sourceKey: key ?? null, groupId: String(group),
            rawPtsTicks: matched && producing.raw !== null ? String(producing.raw) : null,
            rebasedPtsTicks: pts === null ? null : String(pts), endTicks: ranges?.[0] ? String(ranges[0].endTime) : null,
            timescale: context?.scale ?? null, offset: null, submittedAtMs: null, completedAtMs: null, state: 'assembled', reason: null };
          segments.push(record); payloads.set(record, bytes.slice()); retainedBytes += bytes.byteLength;
        }
        return Reflect.apply(callbacks.onSegment, callbacks, args);
      } });
      const initialize = assembler.setInitSegment, push = assembler.push;
      const observedInit = /** @type {typeof assembler.setInitSegment} */ (function (...args) {
        const [type, bytes] = args;
        contexts.set(type, { scale: readMdhdTimescale(bytes), trex: readTrexDefaults(bytes).values().next().value });
        return Reflect.apply(initialize, assembler, args);
      });
      const observedPush = /** @type {typeof assembler.push} */ (function (...args) {
        const [type, name, group, bytes, , , key] = args;
        stack.push({ type, name, group, key, raw: readFirstSamplePresentationTime(bytes) });
        try { return Reflect.apply(push, assembler, args); }
        finally { stack.pop(); }
      });
      assembler.setInitSegment = observedInit; assembler.push = observedPush;
      cleanup.add(() => {
        if (assembler.setInitSegment === observedInit) assembler.setInitSegment = initialize;
        if (assembler.push === observedPush) assembler.push = push;
      });
      return assembler;
    },
    /** @param {Pick<import('../../packages/playa/src/player.js').Player, 'programs' | 'views' | 'mediaTimelineReference' | 'selectProgram' | 'selectView'>} player */
    pageHooks(player) { return { mseProgramSnapshot: snapshot, armMseQueueRefusal() {
      if (disposed || sources !== 1 || refuseQueue || queues.some(record => record.kind === 'refused')) throw new Error('Queue refusal cannot be armed');
      refuseQueue = true;
    },
    /** @param {'program' | 'view'} mode @param {import('./program-switch.fixture.mjs').ProgramSwitchVariant} variant */
    async selectMseMapped(mode, variant) {
      const target = mode === 'program' ? player.programs.find(item => item.renderGroup === 2)
        : player.views.find(item => item.levels.some(level => level.trackName === variant.tracks.viewVideo.name));
      if (!target) throw new Error('Missing public MSE program/view id');
      let reference = player.mediaTimelineReference;
      const deadline = performance.now() + 5000;
      while (reference === null && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50)); reference = player.mediaTimelineReference;
      }
      if (reference === null || performance.now() >= deadline) throw new Error('No current canonical raw MSE reference');
      const anchors = mode === 'program' ? variant.maps.program : variant.maps.view;
      /** @param {{ sourceTimeUs: string; referenceTimeUs: string }} anchor */
      const parse = anchor => {
        if (!/^\d+$/.test(anchor.sourceTimeUs) || !/^\d+$/.test(anchor.referenceTimeUs)) throw new Error('Invalid application raw map anchor');
        return { sourceTimeUs: BigInt(anchor.sourceTimeUs), referenceTimeUs: BigInt(anchor.referenceTimeUs) };
      };
      const timeline = { id: target.id, track: reference.track, domain: reference.domain,
        observedSourceTimeUs: String(reference.observedSourceTimeUs), anchors };
      const options = { timeline: { kind: /** @type {const} */ ('reference-map'), referenceToken: reference.token,
        video: parse(anchors.video), ...(mode === 'program' ? { audio: parse(variant.maps.program.audio) } : {}) } };
      try {
        if (mode === 'program') await player.selectProgram(target.id, options);
        else await player.selectView(target.id, options);
        return { timeline, refusal: null };
      } catch (error) { return { timeline, refusal: error instanceof Error ? error.message : String(error) }; }
    } }; },
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const restore of cleanup) restore();
      cleanup.clear(); payloads.clear(); pending.clear(); retainedBytes = 0;
    },
  };
}
