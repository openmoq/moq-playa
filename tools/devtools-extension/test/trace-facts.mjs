// Facts recorded in a `.moqtrace` (qlog JSON-SEQ) are parsed, never grepped: the recorder's contract is one event
// whose `data.message` is the exact marker `[devtools_observation:v1] ` followed by ONE JSON value — the fact as the
// panel decoded it. Nothing else in the file counts: not the `diagnostic_baseline` metadata (which nests whole facts),
// not metric definitions, not free text that happens to contain the word "appended".
export const OBSERVATION_MARKER = '[devtools_observation:v1] ';

/** Every fact carried by an observation record, in file order. Malformed suffixes are reported, not skipped silently. */
export function recordedFacts(records) {
  const facts = [], malformed = [];
  for (const r of records) {
    const message = r?.data?.message;
    if (typeof message !== 'string' || !message.startsWith(OBSERVATION_MARKER)) continue;
    const suffix = message.slice(OBSERVATION_MARKER.length);
    try { const fact = JSON.parse(suffix); if (fact && typeof fact === 'object' && typeof fact.kind === 'string') facts.push(fact); else malformed.push(suffix.slice(0, 80)); }
    catch { malformed.push(suffix.slice(0, 80)); }
  }
  return { facts, malformed };
}

/**
 * The association the live facts pin, required of the RECORDING too: a recorded `object` fact whose deliveryId also
 * has recorded `reconstructed` and `appended` stages sharing one non-null unitId. Returns the first such correlation
 * or null; counts are returned alongside for the report.
 */
export function stageCorrelation(facts) {
  const objects = new Map(facts.filter(f => f.kind === 'object' && typeof f.deliveryId === 'string').map(f => [f.deliveryId, f]));
  const stages = facts.filter(f => f.kind === 'stage' && typeof f.deliveryId === 'string');
  const counts = { reconstructed: stages.filter(s => s.stage === 'reconstructed').length, appended: stages.filter(s => s.stage === 'appended').length, discarded: stages.filter(s => s.stage === 'discarded').length };
  let correlated = null;
  for (const [deliveryId, object] of objects) {
    const mine = stages.filter(s => s.deliveryId === deliveryId);
    const rec = mine.find(s => s.stage === 'reconstructed'), app = mine.find(s => s.stage === 'appended');
    if (rec && app && typeof rec.unitId === 'string' && rec.unitId === app.unitId) { correlated = { deliveryId, unitId: rec.unitId, object: { groupId: object.groupId, objectId: object.objectId } }; break; }
  }
  return { counts, correlated, objects: objects.size };
}

/**
 * The LOC association, judged per (deliveryId, unitId): one input can yield several native output units, so stages are
 * grouped by unit and a unit must carry every required stage itself (a discarded first unit followed by a complete
 * second unit on the same delivery is found; stages spread across units never are). Track identity comes from the
 * caller (the source's own track facts: which trackIds are video, which are audio, optionally which video track is
 * selected) — never inferred from the stages. Video correlation needs decoded + scheduled + presented on one unit of
 * an object of a video track (the selected one when given); audio correlation needs decoded + scheduled on one unit
 * of an object of an audio track. `audioPresented` counts EVERY presented stage on any audio delivery, so the caller
 * can reject the claim outright rather than merely skip it.
 */
export function locCorrelation(facts, { videoTracks = new Set(), audioTracks = new Set(), selectedTrack = null } = {}) {
  const objects = new Map(facts.filter(f => f.kind === 'object' && typeof f.deliveryId === 'string').map(f => [f.deliveryId, f]));
  const stages = facts.filter(f => f.kind === 'stage' && typeof f.deliveryId === 'string');
  const counts = Object.fromEntries(['decoded', 'scheduled', 'presented', 'discarded', 'reconstructed', 'appended'].map(s => [s, stages.filter(x => x.stage === s).length]));
  const units = new Map();   // `${deliveryId}\u0000${unitId}` → Set of stage names
  for (const st of stages) {
    if (typeof st.unitId !== 'string') continue;
    const key = `${st.deliveryId}\u0000${st.unitId}`;
    (units.get(key) ?? units.set(key, new Set()).get(key)).add(st.stage);
  }
  const unitsOf = deliveryId => [...units].filter(([key]) => key.startsWith(`${deliveryId}\u0000`)).map(([key, set]) => ({ unitId: key.slice(deliveryId.length + 1), stages: set }));
  const describe = (deliveryId, unitId) => { const o = objects.get(deliveryId); return { deliveryId, unitId, trackId: o.trackId, object: { groupId: o.groupId, objectId: o.objectId } }; };
  let video = null, audio = null, audioPresented = 0;
  for (const [deliveryId, object] of objects) {
    const isVideo = videoTracks.has(object.trackId) && (selectedTrack === null || object.trackId === selectedTrack);
    const isAudio = audioTracks.has(object.trackId);
    for (const u of unitsOf(deliveryId)) {
      if (isAudio && u.stages.has('presented')) audioPresented++;
      if (!video && isVideo && u.stages.has('decoded') && u.stages.has('scheduled') && u.stages.has('presented')) video = describe(deliveryId, u.unitId);
      if (!audio && isAudio && u.stages.has('decoded') && u.stages.has('scheduled') && !u.stages.has('presented')) audio = describe(deliveryId, u.unitId);
    }
  }
  return { counts, video, audio, audioPresented, objects: objects.size };
}

/**
 * Verdict for ONE delivery's rendered cell against its stage facts, judged per unit. The panel marks a delivery's
 * cell "discarded" when ANY of its units discarded, and the runtime may yield several units per delivery, so a
 * presented unit beside another unit's truthful discard is legitimate. What is never legitimate: the proven unit
 * itself carrying both `presented` and `discarded`, a "discarded" cell with no discarded unit behind it, or a
 * presented unit whose cell is not drawn at all (that is a bounded-view/eviction condition the caller must name).
 * `units` is a Map unitId → Set of stage names for this delivery; `cell` is the panel's cell for the object or null.
 */
export function cellVerdict(units, unitId, cell) {
  const own = units.get(unitId) ?? new Set();
  const problems = [];
  if (!own.has('presented')) problems.push(`unit ${unitId} has no presented stage (${[...own].join(', ') || 'none'})`);
  if (own.has('discarded')) problems.push(`unit ${unitId} is both presented and discarded`);
  const otherDiscarded = [...units].filter(([id, set]) => id !== unitId && set.has('discarded')).map(([id]) => id);
  if (!cell || !cell.present) return { ok: false, kind: 'absent', problems: [...problems, 'the object has no drawn cell (outside the retained rows/window, or evicted)'], otherDiscarded };
  const marked = /\bdiscarded\b/.test(cell.cls ?? '');
  if (marked && otherDiscarded.length === 0) problems.push('cell is marked discarded but no unit of this delivery discarded');
  return { ok: problems.length === 0, kind: marked ? 'drawn-discarded-by-other-unit' : 'drawn', problems, otherDiscarded };
}

/** Contradictory terminal evidence is fatal even when its object already left the bounded grid. */
export function stageSnapshotProblems(facts, rows) {
  const stages = facts.filter(f => f.kind === 'stage');
  const units = new Map();
  for (const s of stages) if (s.unitId !== null) {
    const key = JSON.stringify([s.deliveryId, s.unitId]);
    (units.get(key) ?? units.set(key, new Set()).get(key)).add(s.stage);
  }
  const problems = [];
  for (const [key, set] of units) if (set.has('discarded') && (set.has('presented') || set.has('appended'))) problems.push(`${key} has successful and discarded terminal stages`);
  const objects = new Map(facts.filter(f => f.kind === 'object').map(o => [`${o.sessionId}/${o.trackAlias}/${o.groupId}/${o.objectId}`, o]));
  for (const c of rows.flatMap(r => r.cells)) if (c.present && /\bdiscarded\b/.test(c.cls ?? '')) {
    const object = objects.get(`${c.g}/${c.o}`);
    if (object && !stages.some(s => s.deliveryId === object.deliveryId && s.stage === 'discarded')) problems.push(`${object.deliveryId} has a discarded cell without a discarded unit`);
  }
  return problems;
}

/** The stage names recorded for one exact (deliveryId, unitId), and whether that delivery's object fact is in the file. */
export function recordedUnit(facts, deliveryId, unitId) {
  const object = facts.find(f => f.kind === 'object' && f.deliveryId === deliveryId) ?? null;
  const stages = new Set(facts.filter(f => f.kind === 'stage' && f.deliveryId === deliveryId && f.unitId === unitId).map(f => f.stage));
  return { object: object && { trackId: object.trackId, groupId: object.groupId, objectId: object.objectId }, stages: [...stages].sort() };
}

/**
 * Recording CUT: the source's own `recording` fact (state 'recording', the active recordingId) arrives as a BATCH
 * event with an exact decimal seq. The registry starts the recorder BEFORE publishing that fact, so every event with
 * seq strictly greater was emitted while the writer was active. Snapshot-baseline facts carry no seq and never prove
 * a new receipt. Returns the cut seq as a BigInt, or null when no such marker is among the events.
 * `events`: [{ seq: string | null, fact, origin: 'batch' | 'snapshot' }].
 */
export function recordingCut(events, recordingId) {
  for (const e of events) {
    if (e.origin !== 'batch' || e.seq === null) continue;
    const f = e.fact;
    if (f.kind === 'recording' && f.state === 'recording' && f.recordingId === recordingId) return BigInt(e.seq);
  }
  return null;
}

/**
 * The first object EVENT received strictly after the cut (BigInt seq compare, batch origin only) whose delivery has
 * a unit carrying every `needs` stage and none of `forbid` (stages may arrive in any event). A pre-cut object with
 * post-cut stages is never a witness; nor is an in-flight pre-cut delivery; nor anything from the snapshot baseline.
 */
export function chainAfterCut(events, cutSeq, { trackOk = () => true, needs = [], forbid = [] } = {}) {
  if (cutSeq === null) return null;
  const units = new Map();
  for (const e of events) { const f = e.fact; if (f.kind === 'stage' && typeof f.unitId === 'string') { const key = `${f.deliveryId}\u0000${f.unitId}`; (units.get(key) ?? units.set(key, new Set()).get(key)).add(f.stage); } }
  for (const e of events) {
    if (e.origin !== 'batch' || e.seq === null || BigInt(e.seq) <= cutSeq) continue;
    const o = e.fact;
    if (o.kind !== 'object' || !trackOk(o.trackId)) continue;
    for (const [key, set] of units) {
      if (!key.startsWith(`${o.deliveryId}\u0000`)) continue;
      if (needs.every(n => set.has(n)) && !forbid.some(n => set.has(n))) return { deliveryId: o.deliveryId, unitId: key.slice(o.deliveryId.length + 1), trackId: o.trackId, groupId: o.groupId, objectId: o.objectId, seq: e.seq };
    }
  }
  return null;
}

/**
 * Observations that the SOURCE timestamped inside a window of its own clock: batch events (snapshots carry no sequence
 * and are excluded) whose clockId equals `clockId` and whose timeMs lies in (afterMs, untilMs]. Returns the object
 * facts in that window for `trackIds` and the `appended` stage facts in the window that correlate to those objects by
 * deliveryId with a non-null unitId. Batch seq order says nothing about when a receipt happened — a late-delivered
 * batch may carry older observations — so the source's timeMs is the only admissible witness.
 */
export function windowedChain(events, { clockId, afterMs, untilMs, trackIds }) {
  const inWindow = events.filter(e => e.seq !== null && e.clockId === clockId && typeof e.timeMs === 'number' && e.timeMs > afterMs && e.timeMs <= untilMs);
  const objects = inWindow.filter(e => e.fact.kind === 'object' && (!trackIds || trackIds.has(e.fact.trackId)));
  const deliveries = new Set(objects.map(e => e.fact.deliveryId));
  const appended = inWindow.filter(e => e.fact.kind === 'stage' && e.fact.stage === 'appended' && deliveries.has(e.fact.deliveryId) && e.fact.unitId !== null && e.fact.unitId !== undefined);
  return { objects, appended, outsideWindow: events.filter(e => e.seq !== null && e.clockId === clockId && !(e.timeMs > afterMs && e.timeMs <= untilMs)).length, otherClocks: events.filter(e => e.seq !== null && e.clockId !== clockId).length };
}
