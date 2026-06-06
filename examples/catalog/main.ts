/**
 * Catalog Viewer — connect to a relay, subscribe to catalog, render tracks.
 *
 * Combines:
 * - Delta catalog accumulation (MSF independent + delta, CF01 patches)
 * - Track table with role badges, expandable raw JSON per track
 * - Protocol debug log
 *
 * @see draft-ietf-moq-transport-16 §3 (Session lifecycle)
 * @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import { MoqtConnection } from '@moqt/webtransport';
import { varint } from '@moqt/transport';
import { createWebTransport } from '../shared/browser/index.js';
import {
  CATALOG_TRACK_NAME,
  applyCatalogUpdate,
  applyCf01Patch,
  parseCatalogFormat01,
  parseDeltaUpdate,
  parseMsfCatalog,
  type CatalogState,
  type CatalogTrack,
} from '@moqt/msf';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ─── DOM ──────────────────────────────────────────────────────────────

const form = document.getElementById('config') as HTMLFormElement;
const runBtn = document.getElementById('run') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const catalogEl = document.getElementById('catalog')!;
const logEl = document.getElementById('log') as HTMLPreElement;

// ─── Inject FETCH controls into the form ──────────────────────────────

{
  const style = document.createElement('style');
  style.textContent = `
    #fetch-fields { display: contents; }
    #fetch-fields.hidden { display: none; }
  `;
  document.head.appendChild(style);

  const methodField = document.createElement('div');
  methodField.className = 'field';
  methodField.innerHTML = `
    <label for="read-method">Method</label>
    <select id="read-method" style="width:8.5rem">
      <option value="subscribe" selected>SUBSCRIBE</option>
      <option value="fetch">FETCH</option>
    </select>
  `;

  const fetchFields = document.createElement('div');
  fetchFields.id = 'fetch-fields';
  fetchFields.className = 'hidden';
  fetchFields.innerHTML = `
    <div class="field">
      <label for="fetch-group">Group ID</label>
      <input type="number" id="fetch-group" value="0" min="0" style="width:6rem" />
    </div>
    <div class="field">
      <label for="fetch-object">Object ID</label>
      <input type="number" id="fetch-object" value="0" min="0" style="width:6rem" />
    </div>
  `;

  const rowBreak = document.createElement('div');
  rowBreak.style.cssText = 'flex-basis: 100%; height: 0;';

  form.insertBefore(rowBreak, runBtn);
  form.insertBefore(methodField, runBtn);
  form.insertBefore(fetchFields, runBtn);

  (document.getElementById('read-method') as HTMLSelectElement).addEventListener('change', (e) => {
    const isFetch = (e.target as HTMLSelectElement).value === 'fetch';
    fetchFields.classList.toggle('hidden', !isFetch);
  });
}

// ─── Catalog Accumulator (handles MSF + CF01 deltas) ─────────────────

class CatalogAccumulator {
  private state: CatalogState | null = null;
  private cf01DeltaSupport = false;
  private lastRawDocument: Record<string, unknown> | null = null;

  constructor(private readonly catalogNamespace: string) {}

  process(payload: Uint8Array): {
    mode: string;
    rawText: string;
    state: CatalogState;
  } {
    const rawText = decoder.decode(payload);
    const parsed = JSON.parse(rawText) as unknown;

    if (Array.isArray(parsed)) {
      if (!this.cf01DeltaSupport || !this.lastRawDocument) {
        throw new Error('CF01 JSON Patch delta before a compatible base catalog');
      }
      const result = applyCf01Patch(this.lastRawDocument, parsed, this.catalogNamespace);
      this.lastRawDocument = result.rawDocument;
      this.state = { version: result.catalog.version, tracks: [...result.catalog.tracks] };
      return { mode: 'cf01-delta', rawText, state: this.state };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Catalog payload is not a valid JSON object or patch array');
    }

    if ('deltaUpdate' in parsed && (parsed as any).deltaUpdate === true) {
      if (!this.state) throw new Error('MSF delta before initial independent catalog');
      const delta = parseDeltaUpdate(payload);
      this.state = applyCatalogUpdate(this.state, delta, this.catalogNamespace);
      return { mode: 'msf-delta', rawText, state: this.state };
    }

    if ('streamingFormat' in parsed) {
      const result = parseCatalogFormat01(payload, this.catalogNamespace);
      this.cf01DeltaSupport = result.supportsDeltaUpdates;
      this.lastRawDocument = result.rawDocument;
      this.state = { version: result.catalog.version, tracks: [...result.catalog.tracks] };
      return { mode: 'cf01-independent', rawText, state: this.state };
    }

    const catalog = parseMsfCatalog(payload, this.catalogNamespace);
    this.cf01DeltaSupport = false;
    this.lastRawDocument = null;
    this.state = {
      version: catalog.version,
      tracks: [...catalog.tracks],
      ...(catalog.generatedAt !== undefined ? { generatedAt: catalog.generatedAt } : {}),
    };
    return { mode: 'msf-independent', rawText, state: this.state };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

let activeRun = 0;
let activeConnection: InstanceType<typeof MoqtConnection> | null = null;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void run();
});

seedForm();
if (!('WebTransport' in window)) {
  setStatus('WebTransport not available. Use Chrome 97+.', 'error');
}

async function run(): Promise<void> {
  const runId = ++activeRun;
  const url = (document.getElementById('relay-url') as HTMLInputElement).value.trim();
  const ns = (document.getElementById('namespace') as HTMLInputElement).value.trim();
  const vRaw = (document.getElementById('draft-version') as HTMLSelectElement).value;
  const hashHex = (document.getElementById('cert-hash') as HTMLInputElement).value.trim();
  const v: 14 | 16 | 18 | undefined = vRaw === '14' ? 14 : vRaw === '16' ? 16 : vRaw === '18' ? 18 : undefined;

  if (!url || !ns) { setStatus('URL and namespace required.', 'error'); return; }

  const method = (document.getElementById('read-method') as HTMLSelectElement).value as 'subscribe' | 'fetch';
  const groupId = BigInt((document.getElementById('fetch-group') as HTMLInputElement).value || '0');
  const objectId = BigInt((document.getElementById('fetch-object') as HTMLInputElement).value || '0');

  // Close previous session to avoid leaking connections
  if (activeConnection) {
    void activeConnection.close().catch(() => {});
    activeConnection = null;
  }

  logEl.textContent = '';
  catalogEl.hidden = true;
  catalogEl.innerHTML = '';
  runBtn.disabled = true;
  setStatus('Connecting...');
  updateUrl(url, ns, v, hashHex);

  try {
    // WebTransport — use shared factory for protocol negotiation
    const certHashBuf = hashHex ? (() => {
      const clean = hashHex.replace(/[^0-9a-fA-F]/g, '');
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return bytes.buffer as ArrayBuffer;
    })() : undefined;
    const transportFactory = createWebTransport({ ...(certHashBuf ? { certHash: certHashBuf } : {}), ...(v ? { draftVersion: v } : {}) });
    const transport = await transportFactory(url);
    log(`WebTransport connected${(transport as any).protocol ? ` (${(transport as any).protocol})` : ''}`);

    // MoqtConnection
    const connection = new MoqtConnection(v);
    activeConnection = connection;
    const accumulator = new CatalogAccumulator(ns);
    let objectCount = 0;
    let closeInitiated = false;

    connection.onMessage = (msg) => {
      if (runId !== activeRun) return;
      if (msg.type === 'REQUEST_ERROR') {
        const err = msg as any;
        log(`[CTRL] ${msg.type} reqId=${err.requestId} code=0x${BigInt(err.errorCode ?? 0).toString(16)} reason="${err.errorReason ?? ''}" retry=${err.retryInterval ?? 0}`);
      } else {
        log(`[CTRL] ${msg.type}${'requestId' in msg ? ` reqId=${(msg as any).requestId}` : ''}`);
      }
    };
    connection.onError = (err) => {
      if (runId !== activeRun || closeInitiated) return;
      // §10.4.3: RESET_STREAM is normal — don't surface as fatal
      log(`Error: ${err.message}`);
    };
    connection.onClose = (err, reason) => {
      if (runId === activeRun) {
        log(`Closed: error=${err ?? 'none'} reason=${reason ?? ''}`);
        activeConnection = null;
      }
    };

    connection.onObject = (_streamId, obj) => {
      if (runId !== activeRun) return;
      if (obj.kind === 'gap') {
        log(`Gap: group=${obj.groupId} obj=${obj.objectId}`);
        if (method === 'fetch' && !closeInitiated) {
          closeInitiated = true;
          setStatus('FETCH returned gap — object not found.', 'error');
          void connection.close().then(() => log('Session closed (FETCH gap).'));
        }
        return;
      }

      objectCount++;
      try {
        const result = accumulator.process(obj.payload!);
        log(`Catalog #${objectCount} (${result.mode}): ${result.state.tracks.length} tracks`);
        renderCatalog(result.state, result.rawText);
        setStatus(`Received ${objectCount} catalog object${objectCount > 1 ? 's' : ''}. ${result.state.tracks.length} tracks.`, 'success');
      } catch (err) {
        log(`Parse error: ${(err as Error).message}`);
        setStatus(`Catalog parse error: ${(err as Error).message}`, 'error');
      }

      if (method === 'fetch') {
        closeInitiated = true;
        void connection.close().then(() => log('Session closed (FETCH complete).'));
      }
    };

    await connection.connect(transport, { maxRequestId: varint(100) });
    log('Session established.');

    const nsBytes = ns.split('/').map(s => encoder.encode(s));

    if (method === 'fetch') {
      // Single-object fetch: endGroup/endObject must equal start.
      // Omitting them defaults to (0,0), causing INVALID_RANGE when start > 0.
      const reqId = await connection.fetch(nsBytes, encoder.encode(CATALOG_TRACK_NAME), {
        startGroup: varint(groupId),
        startObject: varint(objectId),
        endGroup: varint(groupId),
        endObject: varint(objectId),
      });
      log(`FETCH ${ns}/${CATALOG_TRACK_NAME} group=${groupId} object=${objectId} (reqId=${reqId})`);
      setStatus('Fetching catalog object...');
    } else {
      const reqId = await connection.subscribe(nsBytes, encoder.encode(CATALOG_TRACK_NAME), {
        subscriptionFilter: { type: 'LargestObject' },
      });
      log(`Subscribed to ${ns}/${CATALOG_TRACK_NAME} (reqId=${reqId})`);
      setStatus('Waiting for catalog...');
    }
  } catch (err) {
    if (runId === activeRun) {
      const msg = (err as Error).message;
      log(`Fatal: ${msg}`);
      setStatus(msg, 'error');
    }
  } finally {
    if (runId === activeRun) runBtn.disabled = false;
  }
}

// ─── Catalog Table Rendering ──────────────────────────────────────────

function renderCatalog(catalog: CatalogState, rawJson: string): void {
  catalogEl.hidden = false;
  catalogEl.innerHTML = '';

  const h2 = document.createElement('h2');
  h2.textContent = 'Catalog';
  catalogEl.appendChild(h2);

  const meta = document.createElement('p');
  meta.className = 'catalog-meta';
  const parts = [`Version ${catalog.version}`, `${catalog.tracks.length} track${catalog.tracks.length !== 1 ? 's' : ''}`];
  if (catalog.generatedAt) parts.push(new Date(catalog.generatedAt).toISOString());
  meta.textContent = parts.join('  ·  ');
  catalogEl.appendChild(meta);

  const table = document.createElement('table');
  table.className = 'catalog-table';

  // Header
  const thead = table.createTHead();
  const hr = thead.insertRow();
  const cols = ['#', 'Name', 'Packaging', 'Role', 'Codec', 'Bitrate', 'Details', ''];
  const colClasses = ['col-idx', '', '', '', '', '', '', 'col-expand'];
  cols.forEach((text, i) => {
    const th = document.createElement('th');
    th.textContent = text;
    if (colClasses[i]) th.className = colClasses[i]!;
    hr.appendChild(th);
  });

  const tbody = table.createTBody();

  catalog.tracks.forEach((track, idx) => {
    const row = tbody.insertRow();
    row.className = 'data-row';

    // #
    const idxCell = row.insertCell();
    idxCell.className = 'col-idx';
    idxCell.textContent = String(idx);

    // Name
    row.insertCell().textContent = track.name;

    // Packaging
    const pkgCell = row.insertCell();
    pkgCell.textContent = track.packaging ?? '';
    if (!track.packaging) pkgCell.innerHTML = '<span class="dim">—</span>';

    // Role badge
    const roleCell = row.insertCell();
    if (track.role) {
      const badge = document.createElement('span');
      const key = track.role === 'video' ? 'video' : track.role === 'audio' ? 'audio' : track.role === 'data' ? 'data' : 'other';
      badge.className = `badge badge-${key}`;
      badge.textContent = track.role;
      roleCell.appendChild(badge);
    } else {
      roleCell.innerHTML = '<span class="dim">—</span>';
    }

    // Codec
    const codecCell = row.insertCell();
    codecCell.textContent = track.codec ?? '';
    if (!track.codec) codecCell.innerHTML = '<span class="dim">—</span>';

    // Bitrate
    const brCell = row.insertCell();
    if (track.bitrate != null) {
      brCell.textContent = track.bitrate >= 1_000_000
        ? `${(track.bitrate / 1_000_000).toFixed(1)} Mbps`
        : track.bitrate >= 1_000
          ? `${(track.bitrate / 1_000).toFixed(0)} kbps`
          : `${track.bitrate} bps`;
    } else {
      brCell.innerHTML = '<span class="dim">—</span>';
    }

    // Details
    const detailCell = row.insertCell();
    const detailParts: string[] = [];
    if (track.role === 'video') {
      if (track.width && track.height) detailParts.push(`${track.width}×${track.height}`);
      if (track.framerate) detailParts.push(`${track.framerate}fps`);
    } else if (track.role === 'audio') {
      if (track.samplerate) detailParts.push(`${(track.samplerate / 1000).toFixed(1)}kHz`);
      if (track.channelConfig) detailParts.push(`${track.channelConfig}ch`);
    } else if (track.role === 'data' && track.eventType) {
      detailParts.push(track.eventType);
    }
    if (track.depends?.length) detailParts.push(`depends:[${track.depends.join(',')}]`);
    detailCell.textContent = detailParts.join('  ') || '';
    if (!detailParts.length) detailCell.innerHTML = '<span class="dim">—</span>';

    // Expand button
    const expandCell = row.insertCell();
    expandCell.className = 'col-expand';
    const btn = document.createElement('button');
    btn.className = 'expand-btn';
    btn.textContent = '›';
    btn.title = 'Show raw JSON';
    expandCell.appendChild(btn);

    // Detail row
    const detailRow = tbody.insertRow();
    detailRow.className = 'detail-row';
    detailRow.hidden = true;
    const detailTd = detailRow.insertCell();
    detailTd.colSpan = cols.length;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(track, null, 2);
    detailTd.appendChild(pre);

    btn.addEventListener('click', () => {
      const open = !detailRow.hidden;
      detailRow.hidden = open;
      btn.textContent = open ? '›' : '⌄';
    });
  });

  catalogEl.appendChild(table);

  // Raw catalog JSON (collapsible)
  const rawBtn = document.createElement('button');
  rawBtn.className = 'expand-btn';
  rawBtn.textContent = '› Raw catalog JSON';
  rawBtn.style.marginTop = '12px';
  rawBtn.style.fontSize = '0.8rem';
  rawBtn.style.padding = '4px 10px';
  catalogEl.appendChild(rawBtn);

  const rawPre = document.createElement('pre');
  rawPre.className = 'log';
  rawPre.style.marginTop = '8px';
  rawPre.textContent = rawJson;
  rawPre.hidden = true;
  catalogEl.appendChild(rawPre);

  rawBtn.addEventListener('click', () => {
    const open = !rawPre.hidden;
    rawPre.hidden = open;
    rawBtn.textContent = open ? '› Raw catalog JSON' : '⌄ Raw catalog JSON';
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg: string, type: 'info' | 'error' | 'success' = 'info'): void {
  statusEl.textContent = msg;
  statusEl.className = `status${type !== 'info' ? ` ${type}` : ''}`;
}

function seedForm(): void {
  const p = new URLSearchParams(window.location.search);
  (document.getElementById('relay-url') as HTMLInputElement).value =
    p.get('url') ?? `${window.location.origin.replace(/\/$/, '')}:4433`;
  (document.getElementById('namespace') as HTMLInputElement).value = p.get('ns') ?? 'live';
  (document.getElementById('draft-version') as HTMLSelectElement).value = p.get('v') ?? '';
  (document.getElementById('cert-hash') as HTMLInputElement).value = p.get('hash') ?? '';
}

function updateUrl(url: string, ns: string, v?: number, hash?: string): void {
  const p = new URLSearchParams();
  p.set('url', url);
  p.set('ns', ns);
  if (v) p.set('v', String(v));
  if (hash) p.set('hash', hash);
  history.replaceState({}, '', `${location.pathname}?${p.toString()}`);
}
