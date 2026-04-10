#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function usage() {
  console.log(`Usage:
  node scripts/h264-debug.mjs --initdata-base64 <base64>
  node scripts/h264-debug.mjs --initdata-hex <hex>
  node scripts/h264-debug.mjs --sample-file <path> [--format avcc|annexb] [--length-size 4]
  node scripts/h264-debug.mjs --sample-base64 <base64> [--format avcc|annexb] [--length-size 4]
  node scripts/h264-debug.mjs --sample-hex <hex> [--format avcc|annexb] [--length-size 4]
  node scripts/h264-debug.mjs --initdata-base64 <base64> --sample-file <path>

Options:
  --initdata-base64    AVCDecoderConfigurationRecord (avcC) as base64
  --initdata-hex       AVCDecoderConfigurationRecord (avcC) as hex
  --sample-file        Encoded H.264 access unit from a file
  --sample-base64      Encoded H.264 access unit as base64
  --sample-hex         Encoded H.264 access unit as hex
  --format             Sample format: avcc or annexb; default auto-detect
  --length-size        AVCC NAL length field width; default from avcC or 4
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[key.slice(2)] = true;
      continue;
    }
    args[key.slice(2)] = value;
    i++;
  }
  return args;
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

function detectSampleFormat(data) {
  if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x00) {
    if (data[2] === 0x01) return 'annexb';
    if (data[2] === 0x00 && data[3] === 0x01) return 'annexb';
  }
  return 'avcc';
}

function nalTypeName(type) {
  switch (type) {
    case 1: return 'non-IDR slice';
    case 5: return 'IDR slice';
    case 6: return 'SEI';
    case 7: return 'SPS';
    case 8: return 'PPS';
    case 9: return 'AUD';
    default: return 'type-' + type;
  }
}

function parseAvcc(initData) {
  if (initData.length < 7 || initData[0] !== 0x01) {
    throw new Error('initData is not a valid AVCDecoderConfigurationRecord');
  }

  const configurationVersion = initData[0];
  const profileIndication = initData[1];
  const profileCompatibility = initData[2];
  const levelIndication = initData[3];
  const lengthSize = (initData[4] & 0x03) + 1;
  const spsCount = initData[5] & 0x1F;

  let pos = 6;
  const sps = [];
  for (let i = 0; i < spsCount; i++) {
    if (pos + 2 > initData.length) throw new Error('Truncated SPS length');
    const length = (initData[pos] << 8) | initData[pos + 1];
    pos += 2;
    if (pos + length > initData.length) throw new Error('Truncated SPS payload');
    sps.push(initData.slice(pos, pos + length));
    pos += length;
  }

  if (pos >= initData.length) throw new Error('Missing PPS count');
  const ppsCount = initData[pos];
  pos += 1;

  const pps = [];
  for (let i = 0; i < ppsCount; i++) {
    if (pos + 2 > initData.length) throw new Error('Truncated PPS length');
    const length = (initData[pos] << 8) | initData[pos + 1];
    pos += 2;
    if (pos + length > initData.length) throw new Error('Truncated PPS payload');
    pps.push(initData.slice(pos, pos + length));
    pos += length;
  }

  return {
    configurationVersion,
    profileIndication,
    profileCompatibility,
    levelIndication,
    lengthSize,
    sps,
    pps,
    trailingBytes: initData.length - pos,
  };
}

function parseAvccSample(data, lengthSize) {
  const nalUnits = [];
  let pos = 0;
  while (pos + lengthSize <= data.length) {
    let nalLength = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLength = (nalLength << 8) | data[pos + i];
    }
    const headerOffset = pos;
    pos += lengthSize;
    if (nalLength <= 0 || pos + nalLength > data.length) {
      return {
        valid: false,
        headerOffset,
        nalLength,
        consumed: pos - lengthSize,
        total: data.length,
        nalUnits,
      };
    }
    const nal = data.slice(pos, pos + nalLength);
    const nalType = nal[0] & 0x1F;
    nalUnits.push({
      offset: headerOffset,
      length: nalLength,
      nalType,
      nalName: nalTypeName(nalType),
      forbiddenZeroBit: (nal[0] & 0x80) >>> 7,
      nalRefIdc: (nal[0] & 0x60) >>> 5,
      headerByte: nal[0],
    });
    pos += nalLength;
  }

  return {
    valid: pos === data.length,
    consumed: pos,
    total: data.length,
    nalUnits,
  };
}

function findStartCode(data, from) {
  for (let i = from; i <= data.length - 3; i++) {
    if (data[i] === 0x00 && data[i + 1] === 0x00) {
      if (data[i + 2] === 0x01) return { offset: i, length: 3 };
      if (i + 3 < data.length && data[i + 2] === 0x00 && data[i + 3] === 0x01) {
        return { offset: i, length: 4 };
      }
    }
  }
  return null;
}

function parseAnnexBSample(data) {
  const nalUnits = [];
  let start = findStartCode(data, 0);
  while (start) {
    const nalStart = start.offset + start.length;
    const next = findStartCode(data, nalStart);
    const nalEnd = next ? next.offset : data.length;
    if (nalEnd > nalStart) {
      const nal = data.slice(nalStart, nalEnd);
      const nalType = nal[0] & 0x1F;
      nalUnits.push({
        offset: start.offset,
        length: nal.length,
        nalType,
        nalName: nalTypeName(nalType),
        forbiddenZeroBit: (nal[0] & 0x80) >>> 7,
        nalRefIdc: (nal[0] & 0x60) >>> 5,
        headerByte: nal[0],
      });
    }
    start = next;
  }
  return {
    valid: nalUnits.length > 0,
    total: data.length,
    nalUnits,
  };
}

function printAvccInfo(parsed, rawBytes) {
  console.log('AVCDecoderConfigurationRecord');
  console.log(`  bytes: ${rawBytes.length}`);
  console.log(`  configurationVersion: ${parsed.configurationVersion}`);
  console.log(`  profileIndication: 0x${parsed.profileIndication.toString(16).padStart(2, '0')}`);
  console.log(`  profileCompatibility: 0x${parsed.profileCompatibility.toString(16).padStart(2, '0')}`);
  console.log(`  levelIndication: 0x${parsed.levelIndication.toString(16).padStart(2, '0')}`);
  console.log(`  nalLengthSize: ${parsed.lengthSize}`);
  console.log(`  spsCount: ${parsed.sps.length}`);
  parsed.sps.forEach((nal, index) => {
    console.log(`  sps[${index}]: ${nal.length} bytes, header=0x${nal[0].toString(16).padStart(2, '0')}, type=${nalTypeName(nal[0] & 0x1F)}`);
  });
  console.log(`  ppsCount: ${parsed.pps.length}`);
  parsed.pps.forEach((nal, index) => {
    console.log(`  pps[${index}]: ${nal.length} bytes, header=0x${nal[0].toString(16).padStart(2, '0')}, type=${nalTypeName(nal[0] & 0x1F)}`);
  });
  console.log(`  trailingBytes: ${parsed.trailingBytes}`);
  console.log('');
}

function printSampleInfo(label, parsed) {
  console.log(label);
  console.log(`  valid: ${parsed.valid}`);
  console.log(`  bytes: ${parsed.total}`);
  if ('consumed' in parsed) {
    console.log(`  consumed: ${parsed.consumed}`);
  }
  if ('headerOffset' in parsed) {
    console.log(`  invalidHeaderOffset: ${parsed.headerOffset}`);
    console.log(`  invalidNalLength: ${parsed.nalLength}`);
  }
  console.log(`  nalCount: ${parsed.nalUnits.length}`);
  parsed.nalUnits.forEach((nal, index) => {
    console.log(
      `  nal[${index}]: offset=${nal.offset} length=${nal.length} header=0x${nal.headerByte.toString(16).padStart(2, '0')} ` +
      `type=${nal.nalType}(${nal.nalName}) refIdc=${nal.nalRefIdc} forbiddenZeroBit=${nal.forbiddenZeroBit}`,
    );
  });
  console.log('');
}

function loadBytes(args, baseName) {
  if (args[`${baseName}-base64`]) return fromBase64(args[`${baseName}-base64`]);
  if (args[`${baseName}-hex`]) return fromHex(args[`${baseName}-hex`]);
  if (args[`${baseName}-file`]) return new Uint8Array(readFileSync(args[`${baseName}-file`]));
  return undefined;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  const initData = loadBytes(args, 'initdata');
  const sample = loadBytes(args, 'sample');

  if (!initData && !sample) {
    usage();
    process.exitCode = 1;
    return;
  }

  let avccLengthSize = args['length-size'] ? Number(args['length-size']) : 4;

  if (initData) {
    const parsed = parseAvcc(initData);
    avccLengthSize = parsed.lengthSize;
    printAvccInfo(parsed, initData);
  }

  if (sample) {
    const format = args.format ?? detectSampleFormat(sample);
    console.log(`Sample Source`);
    console.log(`  bytes: ${sample.length}`);
    console.log(`  detectedFormat: ${detectSampleFormat(sample)}`);
    console.log(`  selectedFormat: ${format}`);
    if (args['sample-file']) {
      console.log(`  file: ${basename(args['sample-file'])}`);
    }
    console.log('');

    if (format === 'annexb') {
      printSampleInfo('Annex B Sample', parseAnnexBSample(sample));
    } else if (format === 'avcc') {
      printSampleInfo('AVCC Sample', parseAvccSample(sample, avccLengthSize));
    } else {
      throw new Error(`Unsupported format: ${format}`);
    }
  }
}

main();
