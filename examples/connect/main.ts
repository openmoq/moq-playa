/**
 * Connect + Catalog example — wire protocol smoke test.
 *
 * Proves:
 * 1. WebTransport connection works
 * 2. MOQT handshake succeeds (CLIENT_SETUP / SERVER_SETUP)
 * 3. Catalog subscription works (SUBSCRIBE / SUBSCRIBE_OK)
 * 4. Catalog format is compatible (MSF schema)
 *
 * Uses the lower packages directly — not @moqt/player.
 *
 * @see draft-ietf-moq-transport-16 §3 (Session lifecycle)
 * @see draft-ietf-moq-transport-16 §9.3 (CLIENT_SETUP)
 * @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 */

import { MoqtConnection } from '@moqt/webtransport';
import { varint } from '@moqt/transport';
import { parseCatalogAuto } from '@moqt/msf';
import type { CatalogTrack } from '@moqt/msf';
import { log } from '../shared/log.js';
import { relayUrl, namespace, certHash, draftVersion } from '../shared/cert.js';

// ─── Capability check ────────────────────────────────────────────────

if (!('WebTransport' in window)) {
  log('WebTransport is not available. Chrome 97+ or Edge 97+ required.');
  throw new Error('WebTransport not supported');
}

// ─── Connect ─────────────────────────────────────────────────────────

const enc = new TextEncoder();

async function main(): Promise<void> {
  log(`Relay: ${relayUrl}`);
  log(`Namespace: ${namespace}`);
  log(`Cert hash: ${certHash ? 'provided' : 'none (using system trust)'}`);
  log('');

  // 1. Create WebTransport connection
  //    serverCertificateHashes pins the relay's self-signed cert.
  //    @see draft-ietf-moq-transport-16 §3.1
  log('Creating WebTransport connection...');
  const transportOptions: WebTransportOptions = {};
  if (certHash) {
    transportOptions.serverCertificateHashes = [{
      algorithm: 'sha-256',
      value: certHash,
    }];
  }
  // §3.1: WT-Available-Protocols for MOQT version negotiation
  if (draftVersion) {
    (transportOptions as any).protocols = [`moqt-${draftVersion}`];
  }
  // Connect to relay URL as-is. Namespace is communicated via SUBSCRIBE,
  // not the connection URL. Some relays (moquito) accept ?ns= but others
  // (Red5) reject unrecognized URL paths.
  const connectUrl = relayUrl;
  const transport = new WebTransport(connectUrl, transportOptions);
  await transport.ready;
  log('WebTransport connected.');

  // 2. Create MoqtConnection — internally creates Session(EndpointRole.CLIENT)
  //    @see draft-ietf-moq-transport-16 §3
  const connection = new MoqtConnection(draftVersion);

  // 3. Wire callbacks before connect
  connection.onMessage = (msg) => {
    if (msg.type === 'REQUEST_ERROR') {
      const err = msg as { errorCode?: unknown; errorReason?: string };
      log(`Control: ${msg.type} code=0x${BigInt(err.errorCode as any).toString(16)} reason="${err.errorReason ?? ''}"`);
    } else {
      log(`Control: ${msg.type}`);
    }
  };

  connection.onClose = (error, reason) => {
    log(`Session closed: error=${error ?? 'none'} reason=${reason ?? ''}`);
  };

  connection.onError = (error) => {
    log(`Session error: ${error.message}`);
  };

  let catalogReceived = false;

  connection.onObject = (_streamId, obj) => {
    if (catalogReceived) return; // Only process first catalog object

    if (obj.kind === 'gap') {
      log(`Catalog gap: objectId=${obj.objectId} status=${obj.status}`);
      return;
    }

    // 8. Parse catalog with @moqt/msf
    //    @see draft-ietf-moq-msf-00 §5.1
    catalogReceived = true;
    try {
      const catalog = parseCatalogAuto(obj.payload!, namespace);
      log('');
      log(`Catalog received (version ${catalog.version}, ${catalog.tracks.length} tracks):`);
      log('');

      for (const track of catalog.tracks) {
        logTrack(track);
      }

      log('');
      log('Success — handshake + catalog flow validated.');
    } catch (err) {
      log(`Catalog parse error: ${(err as Error).message}`);
    }
  };

  // 4. Connect — opens control stream, sends CLIENT_SETUP, waits for SERVER_SETUP
  //    maxRequestId MUST be >= 1 for subscriptions to work.
  //    @see draft-ietf-moq-transport-16 §3.3, §9.3
  //    @see draft-ietf-moq-transport-16 §9.3.1.3 (MAX_REQUEST_ID default 0 blocks all requests)
  log('');
  log('Connecting to MOQT session...');
  await connection.connect(transport, {
    maxRequestId: varint(100),
  });
  log(`Session established (state: ${connection.session.state}).`);

  // 5. Subscribe to catalog
  //    Namespace is Uint8Array[] (array of path segments per §2.4.1).
  //    Track name is raw bytes.
  //    @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
  log('');
  log('Subscribing to catalog...');
  // Namespace is a tuple — split by '/' per §2.4.1
  const nsBytes = namespace.split('/').map(s => enc.encode(s));
  const catalogReqId = await connection.subscribe(
    nsBytes,
    enc.encode('catalog'),
  );
  log(`Catalog subscribed (requestId=${catalogReqId}).`);
  log('Waiting for catalog object...');
}

/** Log a single catalog track's properties. */
function logTrack(t: CatalogTrack): void {
  const parts: string[] = [`  ${t.name}`];
  if (t.role) parts.push(`role=${t.role}`);
  if (t.codec) parts.push(`codec=${t.codec}`);
  if (t.width && t.height) parts.push(`${t.width}x${t.height}`);
  if (t.bitrate) parts.push(`${(t.bitrate / 1000).toFixed(0)}kbps`);
  if (t.framerate) parts.push(`${t.framerate}fps`);
  if (t.samplerate) parts.push(`${t.samplerate}Hz`);
  if (t.channelConfig) parts.push(`ch=${t.channelConfig}`);
  if (t.isLive) parts.push('[live]');
  if (t.packaging) parts.push(`pkg=${t.packaging}`);
  log(parts.join(' | '));
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).message}`);
  console.error(err);
});
