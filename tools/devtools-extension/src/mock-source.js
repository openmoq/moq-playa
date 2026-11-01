// A deterministic synthetic source for layout work.
//
// A source hands the panel a VIEW MODEL — already-projected, bounded facts —
// and the panel never looks past it. `ProtocolSource` (adapter.js) builds the
// same view model from the shared diagnostic protocol; this one ports the
// mockup's generator so the layout can be worked on without a page or relay.
// Every value it yields is synthetic, it says so (`synthetic: true`), and the
// panel shows MOCK DATA while it is in use. It observes no page and opens no
// connection. MOQT identities are decimal strings here too, as on the wire.

/**
 * @typedef {object} ViewModel
 * @property {boolean} synthetic           Shown as MOCK DATA; never a measurement.
 * @property {'attach'|'probe'} mode
 * @property {boolean} exposed             A source is exposed and attached.
 * @property {boolean} paused              Panel-local: the view is frozen.
 * @property {{active:boolean, seconds:number, owner:'me'|'other'|null}} recording
 * @property {string} hookStats
 * @property {Array<{id:string,name:string,sub:string,on:boolean}>} instances
 * @property {{name:string,meta:string}} picker
 * @property {Array<[string,string,('na'|undefined)?]>} session   k, v, flag
 * @property {Array<{id:string,track:string,state:'active'|'gone',label:string,chain:number,caption?:string}>} requests
 * @property {Array<[string,string]>} decoder
 * @property {Array<{name:string,on:boolean}>} tracks
 * @property {string} ring
 * @property {string} colHeader
 * @property {number} columns
 * @property {Array<{label:string,head:boolean,meta:string,metaClass:string,cells:Array<{cls:string,sel:boolean,g:string,o:string}>}>} rows
 * @property {Array<[string,string,string?]>} selected           k, v, class
 * @property {Array<{name:string,now:string,na?:string,bars:Array<{h:number,color:string,op:number}>}>} sparks
 * @property {Array<{name:string,count:string,color:string}>} events
 */

const GRN = 'oklch(0.76 0.12 155)', YEL = 'oklch(0.76 0.12 80)', RED = 'oklch(0.86 0.09 25)';
const BLUE = 'oklch(0.76 0.12 250)', VIOLET = 'oklch(0.76 0.12 300)';

export class MockSource {
  /** @param {(vm: ViewModel) => void} onChange */
  constructor(onChange, { tickMs = 120, gapEvery = 5 } = {}) {
    this.onChange = onChange;
    this.gapEvery = gapEvery;
    this.state = { t: 0, paused: false, sel: null, mode: 'attach', exposed: true, track: 'vide_1', rec: false, recStart: 0 };
    this.timer = setInterval(() => { if (!this.state.paused) this.state.t++; this.emit(); }, tickMs);
    this.emit();
  }
  destroy() { clearInterval(this.timer); }

  // Panel-local controls. None of these reaches a page or a relay.
  setMode(mode) { this.state.mode = mode; this.emit(); }
  togglePause() { this.state.paused = !this.state.paused; this.emit(); }
  toggleRecording() { this.state.rec = !this.state.rec; this.state.recStart = this.state.t; this.emit(); }
  toggleExposed() { this.state.exposed = !this.state.exposed; this.state.mode = 'attach'; this.emit(); }
  selectTrack(name) { this.state.track = name; this.state.sel = null; this.emit(); }
  selectCell(g, o) { this.state.sel = { g: String(g), o: String(o) }; this.emit(); }

  rnd(n) { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  emit() { this.onChange(this.build()); }

  /** @returns {ViewModel} */
  build() {
    const { t, paused, track, rec, mode, exposed } = this.state;
    const R = n => this.rnd(n);
    const probe = mode === 'probe';
    const live = exposed || probe;
    const audio = track === 'soun_2', N = audio ? 47 : 60;
    const G = 1040 + Math.floor(t / 16), fill = Math.min(N, Math.round(((t % 16) + 1) * N / 16));
    const isMiss = (g, o) => this.gapEvery > 0 && !audio && g % this.gapEvery === 3 && o >= 22 && o < 28;
    const offset = (g, o) => { const b = 18 + R(g * 61 + o + (audio ? 999 : 0)) * 30; return R(g * 7 + o * 3) > 0.975 ? 140 + R(o) * 80 : b; };
    // Identities are strings; the mock's arithmetic happens on its own ints.
    const selRaw = this.state.sel || { g: String(G - 1), o: '0' };
    const sel = { g: Number(selRaw.g), o: Number(selRaw.o) };

    const rows = Array.from({ length: 8 }, (_, r) => {
      const g = G - r; let got = 0, miss = 0; const offs = [];
      const cells = Array.from({ length: N }, (_, o) => {
        const present = r > 0 || o < fill, m = present && isMiss(g, o), L = offset(g, o);
        if (present && !m) { got++; offs.push(L); } if (m) miss++;
        const key = o === 0 && !audio;
        const cls = !present ? '' : m ? 'miss' : key ? 'key' : L > 120 ? 'slow' : L < 35 ? 'fast' : 'mid';
        return { cls, sel: sel.g === g && sel.o === o, g: String(g), o: String(o) };
      });
      offs.sort((a, b) => a - b);
      const p50 = offs.length ? Math.round(offs[Math.floor(offs.length / 2)]) : 0;
      // Observed count and a terminal bound are separate facts: `got` is what
      // was observed; the mock's publisher ends every group at o(N-1). No
      // denominator is invented from that bound.
      const bound = r === 0 ? '' : ` · ends o${N - 1}`;
      return {
        label: 'g ' + g, head: r === 0,
        meta: r === 0 ? `${got} obs · live` : `${got} obs${bound} · ${p50}ms`,
        metaClass: miss ? 'loss' : r === 0 ? 'live' : '',
        cells,
        window: { from: '0', to: String(N - 1), beyond: 0 },
      };
    });

    const sm = isMiss(sel.g, sel.o), sl = offset(sel.g, sel.o), selPresent = sel.g < G || sel.o < fill;
    const size = audio ? (320 + Math.round(R(sel.o) * 60)) + ' B' : sel.o === 0 ? (88 + Math.round(R(sel.g) * 20)) + ' KB' : (14 + Math.round(R(sel.g * 3 + sel.o) * 16)) + ' KB';
    const status = !selPresent ? ['not yet observed', ''] : sm ? ['missing · stream reset', 'lost'] : sl > 120 ? ['appended · offset >120 ms', 'late'] : ['appended', 'ok'];
    const selected = [
      ['selected', `g${sel.g} / o${sel.o}`], ['arrival offset', !selPresent ? 'pending' : sm ? 'never' : '+' + Math.round(sl) + ' ms'],
      ['size', size], ['stream', `subgroup uni ${(audio ? 3 : 2) + (sel.g - 1000) * 4}`], ['status', status[0], status[1]],
    ];

    const spark = (fn, max, color) => Array.from({ length: 60 }, (_, i) => ({ h: Math.max(2, Math.min(34, fn(t - 59 + i) / max * 34)), color, op: 0.4 + 0.6 * i / 60 }));
    const jitF = k => 2 + R(k * 5) * 6, brF = k => 5.6 + R(k * 7) * 0.8;
    const sparks = [
      // End-to-end latency needs capture timing and a clock relation. The mock
      // has neither, so this chart demonstrates the unavailable state rather
      // than inventing a number.
      { name: 'Latency p50', now: 'unavailable', na: 'no capture clock on this source', bars: spark(() => 0, 1, BLUE) },
      { name: 'Arrival jitter', now: jitF(t).toFixed(1) + ' ms', bars: spark(jitF, 10, VIOLET) },
      { name: 'Receive bitrate', now: brF(t).toFixed(2) + ' Mbps', bars: spark(brF, 7, GRN) },
    ];

    let lastGap = G - 1; if (this.gapEvery > 0) while (lastGap % this.gapEvery !== 3) lastGap--;
    const events = [
      { name: 'OBJECT vide_1', count: '×' + (1642 + t * 4).toLocaleString(), color: GRN },
      { name: 'OBJECT soun_2', count: '×' + (820 + Math.round(t * 5.6)).toLocaleString(), color: YEL },
      { name: 'SUBGROUP stream open', count: '×' + (G - 1040 + 82), color: '#d9dee3' },
      ...(this.gapEvery > 0 ? [{ name: `missing g${lastGap} o22–27 · stream reset`, count: '×' + (Math.floor((G - 1040) / this.gapEvery) + 3), color: RED }] : []),
      { name: 'TRACK_STATUS', count: '×2', color: '#b7c0c9' },
      { name: 'SUBSCRIBE_OK req 2, 4', count: '×2', color: '#b7c0c9' },
    ];

    return {
      synthetic: true, mode, exposed, paused,
      actions: { pause: true, mode: true, record: true, detach: true },
      detail: null,
      recording: { active: rec, owner: rec ? 'me' : null, elapsedMs: rec ? Math.floor((t - this.state.recStart) / 8) * 1000 : null },
      hookStats: live ? (paused ? 'hook v1 · paused, source still buffering' : `hook v1 · 4 batches/s · ${(0.28 + R(t) * 0.08).toFixed(2)}% main-thread`) : 'hook v1 · not collecting',
      picker: { name: 'player#1', meta: 'media/avn @ moqr2 · d22' },
      instances: [
        { id: 'p1', name: 'player#1 · <video#main>', sub: exposed ? 'attached · 0.6.1 · d22' : 'exposure off', on: true },
        { id: 'p2', name: 'player#2 · preview', sub: 'media/pip · idle', on: false },
      ],
      session: [
        ['playa', '0.6.1 (a3f9e21)'], ['hook', 'v1 · exposed by app'],
        ['subprotocol', 'moqt-22'],       // WebTransport subprotocol, not QUIC ALPN
        ['transport', 'WebTransport'], ['path', '/moq'],
        ['max_req_id', 'not applicable (d22)', 'na'],   // absent on drafts 18 and 22
        ['setup duration', '138 ms'],      // the exchange, not path RTT
      ],
      requests: [
        { id: 'req 2', track: 'vide_1', state: 'active', label: '● active', chain: 3, caption: 'SUBSCRIBE → OK → objects' },
        { id: 'req 4', track: 'soun_2', state: 'active', label: '● active', chain: 3 },
        { id: 'req 0', track: 'vide_1', state: 'gone', label: 'unsubscribed', chain: 1 },
      ],
      decoder: [['mode', 'CMAF · MSE'], ['buffered', (1.6 + R(t) * 0.4).toFixed(2) + ' s'], ['dropped', '0 frames']],
      tracks: ['vide_1', 'soun_2'].map(name => ({ id: name, name, on: name === track })),
      needsResnapshot: null,
      sourceEnded: null,   // the mock's sparks carry no `range`; they are generated, not retained
      sourceCapabilities: ['session', 'requests', 'objects', 'recording'], canRecord: true,
      ring: `ring buffer: 8 groups · ${G - 1048 + 120} older groups summarized`,
      colHeader: audio ? 'soun_2 · object 0 → 46 (1 s @ 48 kHz / 1024)' : 'vide_1 · object 0 → 59 (2 s @ 30 fps)',
      columns: N, rows, selected, sparks, events,
    };
  }
}
