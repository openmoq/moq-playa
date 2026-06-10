/**
 * Slice A — Node WebTransport API probe.
 *
 * Goal: discover and document the @fails-components/webtransport SERVER API at
 * runtime WITHOUT implementing any MoQT behavior. It answers the questions Slice B
 * depends on:
 *   - Does the package import on this platform/Node (native binding loads)?
 *   - Is `Http3Server` present and constructible?
 *   - Which methods exist (startServer/stopServer/address/sessionStream/ready/closed)?
 *   - Does `sessionStream(path)` return a W3C `ReadableStream` (→ direct adapter)
 *     or something else (→ events/async-iterator-to-ReadableStream bridge)?
 *   - Can we obtain a cert from the package, and can the server bind on :0?
 *
 * It NEVER fakes anything: if a cert/bind isn't achievable it records the blocker
 * and still exits 0 as long as static API discovery succeeded. A hard import
 * failure (native build/load) exits 1.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function row(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(38)} ${typeof value === 'string' ? value : String(value)}`);
}

function shapeOf(v: any): string {
  if (v == null) return String(v);
  const ctor = v.constructor && v.constructor.name ? v.constructor.name : typeof v;
  const isReadable = typeof v.getReader === 'function';
  const isAsyncIter = typeof v[Symbol.asyncIterator] === 'function';
  return `${ctor}${isReadable ? ' [ReadableStream: has getReader]' : ''}${isAsyncIter ? ' [asyncIterable]' : ''}`;
}

async function main(): Promise<number> {
  console.log('=== @fails-components/webtransport — Slice A API probe ===\n');

  // ── 1. Import the package (native binding may fail to load here) ───────────
  let wt: any;
  try {
    wt = await import('@fails-components/webtransport');
  } catch (err) {
    console.error('IMPORT FAILED: @fails-components/webtransport did not load.');
    console.error(`  ${(err as Error).message}`);
    console.error('  Likely a native build/load failure (bindings + http3-quiche addon).');
    console.error('  See README "Native dependency" section.');
    return 1;
  }
  console.log('Package imported OK.');
  console.log('Top-level exports:', Object.keys(wt).sort().join(', '), '\n');

  // The http3 backend is a separate package; report whether it loads too. We import
  // it for its runtime side effect only (does the native addon load?), via a non-literal
  // specifier so TS doesn't try to resolve its types — that package ships .d.ts but its
  // package.json "exports" doesn't map them under NodeNext (a Slice-A finding).
  const backendSpecifier = '@fails-components/webtransport-transport-http3-quiche';
  try {
    const backend: any = await import(backendSpecifier);
    row('http3-quiche backend import', 'OK (' + Object.keys(backend).sort().join(', ') + ')');
  } catch (err) {
    row('http3-quiche backend import', 'FAILED: ' + (err as Error).message);
  }

  // ── 2. Key symbols ────────────────────────────────────────────────────────
  console.log('\nKey symbols:');
  const Http3Server = wt.Http3Server;
  const generateCert = wt.generateWebTransportCertificate;
  row('Http3Server', typeof Http3Server);
  row('Http3WebTransport', typeof wt.Http3WebTransport);
  row('WebTransport (client)', typeof wt.WebTransport);
  row('generateWebTransportCertificate', typeof generateCert);

  const apiDiscovered = typeof Http3Server === 'function';

  // ── 3. Obtain a cert from the package (do NOT fake one) ───────────────────
  console.log('\nCertificate:');
  let cert: any;
  if (typeof generateCert === 'function') {
    try {
      cert = await generateCert([{ shortName: 'C', value: 'US' }, { shortName: 'CN', value: 'localhost' }], { days: 5 });
      row('generateWebTransportCertificate()', 'OK — fields: ' + Object.keys(cert).join(', '));
    } catch (err) {
      row('generateWebTransportCertificate()', 'THREW: ' + (err as Error).message);
    }
  } else {
    row('cert helper', 'NOT exported by this version — Slice B must source a cert another way');
  }

  // ── 4. Construct + introspect Http3Server (bind on :0 if a cert was obtained) ─
  console.log('\nHttp3Server:');
  if (typeof Http3Server === 'function' && cert) {
    let server: any;
    try {
      server = new Http3Server({
        port: 0,
        host: '127.0.0.1',
        secret: 'slice-a-probe-secret',
        cert: cert.cert,
        privKey: cert.private ?? cert.privKey ?? cert.key,
      });
      row('construct', 'OK');
      for (const m of ['startServer', 'stopServer', 'address', 'sessionStream', 'ready', 'closed', 'updateCert', 'setRequestCallback', 'createUnidirectionalStream']) {
        row(`  .${m}`, typeof server[m]);
      }

      if (typeof server.sessionStream === 'function') {
        const s = server.sessionStream('/moq');
        row('  sessionStream("/moq") shape', shapeOf(s));
      }

      // Try a real bind on an ephemeral port, then tear down.
      if (typeof server.startServer === 'function') {
        try {
          server.startServer();
          if (server.ready && typeof server.ready.then === 'function') await server.ready;
          const addr = typeof server.address === 'function' ? server.address() : '(no address())';
          row('  startServer + ready', 'OK');
          row('  address()', JSON.stringify(addr));
        } catch (err) {
          row('  startServer/bind', 'FAILED: ' + (err as Error).message);
        } finally {
          try { if (typeof server.stopServer === 'function') server.stopServer(); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      row('construct', 'FAILED: ' + (err as Error).message);
    }
  } else {
    console.log('  Skipped (need both Http3Server and a cert).');
  }

  console.log('\n=== probe complete ===');
  console.log(apiDiscovered
    ? 'RESULT: API discovery SUCCEEDED (Http3Server present). See output above for Slice B.'
    : 'RESULT: API discovery INCOMPLETE — Http3Server not found; record in README.');
  return apiDiscovered ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('PROBE CRASHED:', err);
    process.exit(1);
  });
