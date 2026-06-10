/**
 * Capability probe: which existing @moqt packages can this Node publisher reuse?
 * Exercises the publisher-side APIs with fake data and prints a concise capability
 * report. Exits 0 if the REQUIRED capabilities (@moqt/msf buildCatalog) work; the
 * @moqt/browser mp4-box probe is informational only (relevant to a possible future
 * fragmented-MP4 ingest step — the publisher publishes prepared files and never
 * parses media).
 */
import { buildCatalog, parseCatalogAuto, CATALOG_TRACK_NAME } from '@moqt/msf';
import { encodeLocHeaders, parseLocHeaders } from '@moqt/loc';

const row = (label: string, value: string) => console.log(`  ${label.padEnd(34)} ${value}`);

async function main(): Promise<number> {
  console.log('=== node-publisher — capability probe ===\n');
  let ok = true;

  // ── REQUIRED: @moqt/msf catalog build (publisher side) ─────────────────────
  console.log('@moqt/msf:');
  try {
    const fakeInit = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]).toString('base64');
    const bytes = buildCatalog({
      tracks: [
        { name: 'video-720', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 3_000_000, renderGroup: 1, initData: fakeInit },
        { name: 'audio-en', packaging: 'cmaf', isLive: true, role: 'audio', codec: 'mp4a.40.2', samplerate: 48_000, channelConfig: '2', renderGroup: 1 },
      ],
    });
    const parsed = parseCatalogAuto(bytes);
    const names = parsed.tracks.map((t) => t.name).join(', ');
    row('buildCatalog()', `OK — ${bytes.byteLength} bytes`);
    row('parseCatalogAuto(round-trip)', `OK — tracks: ${names}`);
    row('CATALOG_TRACK_NAME', JSON.stringify(CATALOG_TRACK_NAME));
  } catch (err) {
    row('buildCatalog()', `FAILED: ${(err as Error).message}`);
    ok = false;
  }

  // ── AVAILABLE: @moqt/loc header encode (not needed for the CMAF demo) ──────
  console.log('\n@moqt/loc:');
  try {
    const ext = encodeLocHeaders({ captureTimestamp: 1_000_000n });
    if (!ext) throw new Error('encodeLocHeaders returned undefined for a non-empty header set');
    const back = parseLocHeaders(ext);
    row('encodeLocHeaders/parseLocHeaders', `OK — ${ext.byteLength} bytes, ts=${back.captureTimestamp}`);
  } catch (err) {
    row('encodeLocHeaders', `unavailable: ${(err as Error).message} (informational — CMAF demo does not need LOC)`);
  }

  // ── INFORMATIONAL: @moqt/browser mp4-box from Node? ────────────────────────
  // Needed only for a later fragmented-MP4 INGEST slice; prepared fixtures avoid it.
  console.log('\n@moqt/browser (informational):');
  try {
    const browser: Record<string, unknown> = await import('@moqt/browser');
    const wanted = ['boxType', 'filterInitSegment', 'iterateTrunSamples', 'peekSegmentMetadata'];
    const found = wanted.filter((n) => typeof browser[n] === 'function');
    row('package import from Node', 'OK (no import-time DOM crash)');
    row('mp4-box helpers exported?', found.length > 0 ? `YES: ${found.join(', ')}` : 'NO — mp4-box is internal (index does not re-export it)');
    if (found.length === 0) {
      row('=> ingest-slice implication', 'defer: needs a deliberate export (or vendoring) decision');
    }
  } catch (err) {
    row('package import from Node', `FAILED: ${(err as Error).message}`);
    row('=> ingest-slice implication', 'defer mp4-box; prepared fixtures do not need it');
  }

  console.log(`\nRESULT: ${ok ? 'required capabilities available (msf catalog build). PASS.' : 'REQUIRED capability missing. FAIL.'}`);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('probe crashed:', err); process.exit(1); });
