#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

function usage() {
  console.log(`Usage:
  node scripts/h264-rebuild.mjs --bundle-file <path> --output <path>
  node scripts/h264-rebuild.mjs --initdata-base64 <base64> --sample-file <path> [--sample-file <path> ...] --output <path>
  node scripts/h264-rebuild.mjs --initdata-hex <hex> --sample-hex <hex> [--sample-hex <hex> ...] --output <path>

Options:
  --bundle-file        JSON bundle copied from globalThis.__MOQT_LAST_H264_DEBUG__
  --initdata-base64    AVCDecoderConfigurationRecord (avcC) as base64
  --initdata-hex       AVCDecoderConfigurationRecord (avcC) as hex
  --sample-file        AVCC-framed sample file; may be repeated
  --sample-base64      AVCC-framed sample as base64; may be repeated
  --sample-hex         AVCC-framed sample as hex; may be repeated
  --output             Output Annex B .h264 path
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[name] = true;
      continue;
    }
    if (args[name] === undefined) {
      args[name] = value;
    } else if (Array.isArray(args[name])) {
      args[name].push(value);
    } else {
      args[name] = [args[name], value];
    }
    i++;
  }
  return args;
}

function oneOrMany(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanHex(hex) {
  return hex.replace(/[^0-9a-fA-F]/g, '');
}

function fromHex(hex) {
  const clean = cleanHex(hex);
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex length ${clean.length}`);
  }
  return Uint8Array.from(clean.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
}

function fromBase64(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function parseAvcc(initData) {
  if (initData.length < 7 || initData[0] !== 0x01) {
    throw new Error('initData is not a valid AVCDecoderConfigurationRecord');
  }

  const lengthSize = (initData[4] & 0x03) + 1;
  const spsCount = initData[5] & 0x1F;
  let pos = 6;

  const sps = [];
  for (let i = 0; i < spsCount; i++) {
    const length = (initData[pos] << 8) | initData[pos + 1];
    pos += 2;
    sps.push(initData.slice(pos, pos + length));
    pos += length;
  }

  const ppsCount = initData[pos];
  pos += 1;
  const pps = [];
  for (let i = 0; i < ppsCount; i++) {
    const length = (initData[pos] << 8) | initData[pos + 1];
    pos += 2;
    pps.push(initData.slice(pos, pos + length));
    pos += length;
  }

  return { lengthSize, sps, pps };
}

function avccSampleToAnnexB(sample, lengthSize) {
  const chunks = [];
  let pos = 0;
  while (pos + lengthSize <= sample.length) {
    let nalLength = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLength = (nalLength << 8) | sample[pos + i];
    }
    pos += lengthSize;
    if (nalLength <= 0 || pos + nalLength > sample.length) {
      throw new Error(`Invalid AVCC sample at offset ${pos - lengthSize}: nalLength=${nalLength}`);
    }
    chunks.push(Uint8Array.of(0x00, 0x00, 0x00, 0x01));
    chunks.push(sample.slice(pos, pos + nalLength));
    pos += nalLength;
  }
  if (pos !== sample.length) {
    throw new Error(`Trailing bytes in AVCC sample: ${sample.length - pos}`);
  }
  return concat(chunks);
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function loadBundle(args) {
  if (!args['bundle-file']) return null;
  const json = JSON.parse(readFileSync(args['bundle-file'], 'utf8'));
  return {
    initData: fromBase64(json.initDataBase64),
    samples: [
      ...oneOrMany(json.idrSampleBase64).filter(Boolean).map(fromBase64),
      ...oneOrMany(json.failingSampleBase64).filter(Boolean).map(fromBase64),
    ],
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.output) {
    usage();
    process.exit(args.output ? 0 : 1);
  }

  const bundle = loadBundle(args);
  const initData = bundle
    ? bundle.initData
    : args['initdata-base64']
      ? fromBase64(args['initdata-base64'])
      : args['initdata-hex']
        ? fromHex(args['initdata-hex'])
        : null;

  if (!initData) {
    throw new Error('Missing initData');
  }

  const parsed = parseAvcc(initData);
  const samples = bundle
    ? bundle.samples
    : [
      ...oneOrMany(args['sample-file']).map((path) => new Uint8Array(readFileSync(path))),
      ...oneOrMany(args['sample-base64']).map(fromBase64),
      ...oneOrMany(args['sample-hex']).map(fromHex),
    ];

  if (samples.length === 0) {
    throw new Error('No samples provided');
  }

  const out = concat([
    ...parsed.sps.flatMap((nal) => [Uint8Array.of(0x00, 0x00, 0x00, 0x01), nal]),
    ...parsed.pps.flatMap((nal) => [Uint8Array.of(0x00, 0x00, 0x00, 0x01), nal]),
    ...samples.map((sample) => avccSampleToAnnexB(sample, parsed.lengthSize)),
  ]);

  writeFileSync(args.output, out);
  console.log(`Wrote ${out.length} bytes to ${args.output}`);
  console.log(`lengthSize=${parsed.lengthSize} sps=${parsed.sps.length} pps=${parsed.pps.length} samples=${samples.length}`);
}

main();
