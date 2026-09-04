import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  connectInteropWebTransport,
  selectRelayTransport,
  transportSecurityDiagnostic,
  WEBTRANSPORT_VERIFICATION_NOTE,
} from '../src/transport-factory.js';

let wtCalls = 0;
let quicCalls = 0;
const factories = () => ({
  webtransport: async (url: string, draft: number) => {
    wtCalls++;
    return { url, draft };
  },
  quic: async (url: string) => {
    quicCalls++;
    return { kind: 'quic', url, setupOptions: { authority: 'relay:4443', path: '/moq' } };
  },
});

interface FakeWebTransportHarness {
  readonly module: {
    readonly quicheLoaded: Promise<void>;
    readonly WebTransport: new (url: string, options: Record<string, unknown>) => {
      readonly ready: Promise<void>;
    };
  };
  readonly constructions: Array<{ url: string; options: Record<string, unknown> }>;
}

function fakeWebTransport(ready: Promise<void> = Promise.resolve()): FakeWebTransportHarness {
  const constructions: Array<{ url: string; options: Record<string, unknown> }> = [];
  class FakeWebTransport {
    readonly ready = ready;
    constructor(url: string, options: Record<string, unknown>) {
      constructions.push({ url, options });
    }
  }
  return {
    module: { quicheLoaded: Promise.resolve(), WebTransport: FakeWebTransport },
    constructions,
  };
}

const missingCertificate = (): never => {
  throw Object.assign(new Error('not found'), { code: 'ENOENT' });
};

async function testWebTransportVerificationContract() {
  const url = 'https://relay.example:4443/moq';
  const certBytes = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]);
  const certPem = [
    '-----BEGIN CERTIFICATE-----',
    certBytes.toString('base64'),
    '-----END CERTIFICATE-----',
  ].join('\n');

  {
    const fake = fakeWebTransport();
    const notes: string[] = [];
    await connectInteropWebTransport(url, {
      protocols: ['moqt-18'],
      disableCertificateVerification: true,
      certificatePath: '/certs/cert.pem',
      onTapComment: (message) => notes.push(message),
    }, {
      loadWebTransport: async () => fake.module,
      readCertificate: () => certPem,
    });

    assert.equal(fake.constructions.length, 1);
    assert.equal(fake.constructions[0]!.url, url);
    assert.deepEqual(fake.constructions[0]!.options.protocols, ['moqt-18']);
    const hashes = fake.constructions[0]!.options.serverCertificateHashes as Array<{
      algorithm: string;
      value: Uint8Array;
    }>;
    assert.equal(hashes[0]!.algorithm, 'sha-256');
    assert.deepEqual(
      hashes[0]!.value,
      new Uint8Array(createHash('sha256').update(certBytes).digest()),
    );
    assert.deepEqual(notes, []);
  }

  {
    const fake = fakeWebTransport();
    const notes: string[] = [];
    await connectInteropWebTransport(url, {
      protocols: ['moqt-18'],
      disableCertificateVerification: true,
      certificatePath: '/certs/cert.pem',
      onTapComment: (message) => notes.push(message),
    }, {
      loadWebTransport: async () => fake.module,
      readCertificate: missingCertificate,
    });

    assert.deepEqual(fake.constructions[0]!.options, { protocols: ['moqt-18'] });
    assert.deepEqual(notes, [WEBTRANSPORT_VERIFICATION_NOTE]);
  }

  {
    const fake = fakeWebTransport(Promise.reject(new Error('self signed certificate')));
    const notes: string[] = [];
    await assert.rejects(
      connectInteropWebTransport(url, {
        protocols: ['moqt-18'],
        disableCertificateVerification: true,
        certificatePath: '/certs/cert.pem',
        onTapComment: (message) => notes.push(message),
      }, {
        loadWebTransport: async () => fake.module,
        readCertificate: missingCertificate,
      }),
      /@fails-components\/webtransport 1\.6\.7.*no documented.*skip.*ordinary.*self signed certificate/i,
    );
    assert.deepEqual(notes, []);
  }

  {
    const fake = fakeWebTransport();
    let certificateRead = false;
    const notes: string[] = [];
    await connectInteropWebTransport(url, {
      protocols: ['moqt-18'],
      disableCertificateVerification: false,
      certificatePath: '/certs/cert.pem',
      onTapComment: (message) => notes.push(message),
    }, {
      loadWebTransport: async () => fake.module,
      readCertificate: () => {
        certificateRead = true;
        return certPem;
      },
    });

    assert.equal(certificateRead, false);
    assert.deepEqual(fake.constructions[0]!.options, { protocols: ['moqt-18'] });
    assert.deepEqual(notes, []);
  }

  {
    const fake = fakeWebTransport();
    let constructed = false;
    const FakeConstructor = class {
      readonly ready = Promise.resolve();
      constructor() { constructed = true; }
    };
    await assert.rejects(
      connectInteropWebTransport(url, {
        disableCertificateVerification: true,
        certificatePath: '/certs/cert.pem',
      }, {
        loadWebTransport: async () => ({
          quicheLoaded: Promise.resolve(),
          WebTransport: FakeConstructor,
        }),
        readCertificate: () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      }),
      /cert\.pem is unreadable.*permission denied/i,
    );
    assert.equal(constructed, false);
  }
}

async function main() {
  wtCalls = 0;
  quicCalls = 0;
  const wt = await selectRelayTransport('https://relay:4443/moq', 18, factories());
  assert.equal(wt.url, 'https://relay:4443/moq');
  assert.equal(wtCalls, 1);
  assert.equal(quicCalls, 0);

  wtCalls = 0;
  quicCalls = 0;
  const quic = await selectRelayTransport('moqt://relay:4443/moq', 18, factories());
  assert.equal(quic.kind, 'quic');
  assert.deepEqual(quic.setupOptions, { authority: 'relay:4443', path: '/moq' });
  assert.equal(wtCalls, 0);
  assert.equal(quicCalls, 1);

  wtCalls = 0;
  quicCalls = 0;
  await assert.rejects(
    selectRelayTransport('wss://relay:4443/moq', 18, factories()),
    /unsupported relay URL scheme/,
  );
  assert.equal(wtCalls, 0);
  assert.equal(quicCalls, 0);

  await assert.rejects(
    selectRelayTransport('moqt://relay:4443/moq', 16, factories()),
    /draft 18 only/,
  );

  await assert.rejects(
    selectRelayTransport('moqt://relay:4443/moq', 18, {
      ...factories(),
      quic: async () => ({ setupOptions: {} }),
    }),
    /kind="quic"/,
  );

  assert.equal(
    transportSecurityDiagnostic('moqt://relay:4443/moq', true),
    'WARNING: native QUIC certificate verification disabled by TLS_DISABLE_VERIFY=1',
  );
  assert.equal(transportSecurityDiagnostic('moqt://relay:4443/moq', false), undefined);
  assert.equal(transportSecurityDiagnostic('https://relay:4443/moq', true), undefined);

  await testWebTransportVerificationContract();

  process.stdout.write('transport factory: pass\n');
}

await main();
