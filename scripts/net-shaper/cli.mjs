#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createShaper } from './shaper.mjs';
import { netShapePresets } from './presets.mjs';

const usage = `Usage: node scripts/net-shaper/cli.mjs --upstream HOST:PORT [options]

  --listen PORT            local UDP port (0 picks one; default 0)
  --listen-host HOST       local address (default 127.0.0.1)
  --upstream HOST:PORT     relay QUIC/WebTransport address (required)
  --preset NAME            ${Object.keys(netShapePresets).join(', ')}
  --{down,up}-rate BPS     token-bucket rate; omitted leaves the direction unshaped
  --{down,up}-delay MS     fixed one-way delay
  --{down,up}-jitter MS    seeded +/- jitter, never reordering
  --{down,up}-queue BYTES  tail-drop queue (default ~100 ms or one BDP)
  --{down,up}-loss PCT     seeded random loss
  --{down,up}-schedule S   AT_MS:BPS[,AT_MS:BPS...] from the first packet
  --seed N                 random seed (default 1)
  --stats-out FILE         JSON stats written on exit
  --record-packets         include per-packet intended/actual times in stats
  --spin-ms MS             poll this close to a due time instead of sleeping (default 1; 0 saves CPU)`;

const linkFlags = ['rate', 'delay', 'jitter', 'queue', 'loss', 'schedule'];
const options = {
  listen: { type: 'string' }, 'listen-host': { type: 'string' }, upstream: { type: 'string' }, preset: { type: 'string' },
  seed: { type: 'string' }, 'stats-out': { type: 'string' }, 'record-packets': { type: 'boolean' }, 'spin-ms': { type: 'string' }, help: { type: 'boolean' },
  ...Object.fromEntries(['down', 'up'].flatMap(direction => linkFlags.map(flag => [`${direction}-${flag}`, { type: 'string' }]))),
};

const number = (name, value) => {
  const parsed = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(parsed)) throw new Error(`--${name} needs a number, got ${value}`);
  return parsed;
};

export function parseSchedule(text) {
  return text.split(',').filter(Boolean).map(step => {
    const [atMs, rateBps] = step.split(':');
    return { atMs: number('schedule time', atMs), rateBps: number('schedule rate', rateBps) };
  });
}

/** Parse only: a preset gives the base, explicit flags override it field by field. */
export function parseShaperArgs(argv) {
  const { values } = parseArgs({ args: argv, options, strict: true });
  if (values.help) return { help: true };
  if (!values.upstream) throw new Error('--upstream HOST:PORT is required');
  const preset = values.preset === undefined ? {} : netShapePresets[values.preset];
  if (!preset) throw new Error(`Unknown preset ${values.preset}; known: ${Object.keys(netShapePresets).join(', ')}`);
  const link = (direction) => {
    const out = { ...preset[direction] };
    const field = { rate: 'rateBps', delay: 'delayMs', jitter: 'jitterMs', queue: 'queueBytes', loss: 'lossPct' };
    for (const [flag, key] of Object.entries(field)) {
      const value = values[`${direction}-${flag}`];
      if (value !== undefined) out[key] = number(`${direction}-${flag}`, value);
    }
    const schedule = values[`${direction}-schedule`];
    if (schedule !== undefined) out.schedule = parseSchedule(schedule);
    return out;
  };
  return {
    listen: values.listen === undefined ? 0 : number('listen', values.listen),
    listenHost: values['listen-host'] ?? '127.0.0.1',
    upstream: values.upstream,
    down: link('down'), up: link('up'),
    seed: values.seed === undefined ? 1 : number('seed', values.seed),
    recordPackets: values['record-packets'] ?? false,
    ...(values['spin-ms'] !== undefined ? { spinMs: number('spin-ms', values['spin-ms']) } : {}),
    ...(values['stats-out'] ? { statsFile: values['stats-out'] } : {}),
  };
}

async function main() {
  let config;
  try { config = parseShaperArgs(process.argv.slice(2)); } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    process.exit(2);
  }
  if (config.help) { console.log(usage); return; }
  const shaper = await createShaper(config);
  console.log(`net-shaper listening on ${config.listenHost}:${shaper.port} -> ${config.upstream} `
    + `down=${JSON.stringify(config.down)} up=${JSON.stringify(config.up)} seed=${config.seed}`);
  const stop = async (signal) => {
    const stats = await shaper.close();
    const { down } = stats;
    console.log(`net-shaper ${signal}: down delivered=${down.deliveredPackets} loss=${down.lossPackets} tail=${down.tailPackets} `
      + `bps=${down.deliveredBps} late p99=${down.lateness.p99Ms}ms max=${down.lateness.maxMs.toFixed(2)}ms`);
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(signal).catch(error => { console.error(error); process.exit(1); }); });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
