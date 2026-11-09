import { describe, expect, it, vi } from 'vitest';
import type { DecoderCommand } from '@openmoq/playback';
import { DEFAULT_PLAYER_CONFIG } from './config.js';
import { MoqtPlayer } from './player.js';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoDecoderLike, AudioDecoderLike } from './interfaces.js';

describe('configure receipt consumer ownership', () => {
  for (const role of ['video', 'audio'] as const) {
    it.each([false, true])(`an incoming ${role} config getter cannot replace a newer installed receipt: %s`, async reenter => {
      const first = Uint8Array.of(1), newer = Uint8Array.of(2);
      const calls: Array<{ bytes: Uint8Array; codec: string }> = [];
      const video: VideoDecoderLike = { configure(bytes, codec) { calls.push({ bytes, codec }); }, decode: vi.fn(),
        flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onFrame: null, onError: null };
      const audio: AudioDecoderLike = { configure(bytes, codec) { calls.push({ bytes, codec }); }, decode: vi.fn(),
        flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
      const dispatcher = new CommandDispatcher({ videoDecoder: video, audioDecoder: audio, videoCodec: 'outer', audioCodec: 'outer' });
      const next: DecoderCommand = { type: 'configure', mediaType: role, config: newer };
      let reads = 0, nested = false;
      const original: DecoderCommand = { type: 'configure', mediaType: role, get config() {
        if (++reads === 1 && reenter) {
          nested = true;
          if (role === 'video') dispatcher.updateVideoCodec('inner');
          invoke(next);
        }
        return first;
      } };
      const transformed: DecoderCommand = { type: 'configure', mediaType: role, config: first };
      const player = new MoqtPlayer({ ...DEFAULT_PLAYER_CONFIG, url: 'https://receipt.invalid/moq', namespace: ['receipt'],
        clock: { now: () => 0 }, commandTransform: command => command === original ? transformed : command });
      // Controlled consumer-unit setup: install the real dispatcher dependency.
      // Do not replace the handler, token map, ledger, lifecycle or return body.
      expect(Reflect.set(player, 'commandDispatcher', dispatcher)).toBe(true);
      function invoke(command: DecoderCommand): void {
        const handler: unknown = Reflect.get(player, 'handlePipelineCommand');
        if (typeof handler !== 'function') throw new Error('Consumer fixture handler unavailable');
        Reflect.apply(handler, player, [command]);
      }
      try {
        invoke(original);
        const expectedBytes = reenter ? newer : first, expectedCodec = reenter && role === 'video' ? 'inner' : 'outer';
        expect(nested).toBe(reenter);
        expect(calls.at(-1)).toEqual({ bytes: expectedBytes, codec: expectedCodec });
        const ledger: unknown = Reflect.get(player, 'installedDecoderConfigurations');
        if (!(ledger instanceof Map)) throw new Error('Consumer fixture ledger unavailable');
        const record: unknown = ledger.get(role);
        expect(record).toEqual({ dispatcher, requested: expectedBytes, configured: expectedBytes,
          format: { mediaType: role, codec: expectedCodec, config: expectedBytes } });
      } finally { await player.destroy(); }
    });

    it(`keeps original ${role} request bytes and the exact native argument despite getters and mutation`, async () => {
      const requested = Uint8Array.of(3, 4), invoked: number[][] = [];
      let reads = 0, nativeArgument: Uint8Array | undefined;
      const configure = (bytes: Uint8Array) => { invoked.push([...bytes]); nativeArgument = bytes; bytes.fill(0); };
      const video: VideoDecoderLike = { configure, decode() {}, flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null };
      const audio: AudioDecoderLike = { configure, decode() {}, flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null };
      const dispatcher = new CommandDispatcher({ videoDecoder: video, audioDecoder: audio, videoCodec: 'codec', audioCodec: 'codec' });
      const command: DecoderCommand = { type: 'configure', mediaType: role, config: requested };
      const player = new MoqtPlayer({ ...DEFAULT_PLAYER_CONFIG, url: 'https://receipt.invalid/moq', namespace: ['receipt'],
        clock: { now: () => 0 }, commandTransform: input => {
          if (input.type !== 'configure') return input;
          input.config[0] = 9;
          return { type: 'configure', mediaType: role, get config() { return Uint8Array.of(++reads === 1 ? 9 : 7, 4); } };
        } });
      Reflect.set(player, 'commandDispatcher', dispatcher);
      try {
        const handler: unknown = Reflect.get(player, 'handlePipelineCommand');
        if (typeof handler !== 'function') throw new Error('Configuration fixture handler unavailable');
        Reflect.apply(handler, player, [command]);
        expect(invoked).toEqual([[9, 4]]); expect(reads).toBe(1); expect(nativeArgument).toEqual(Uint8Array.of(0, 0));
        const ledger: unknown = Reflect.get(player, 'installedDecoderConfigurations');
        if (!(ledger instanceof Map)) throw new Error('Configuration fixture ledger unavailable');
        expect(ledger.get(role)).toEqual({ dispatcher, requested: Uint8Array.of(3, 4), configured: Uint8Array.of(9, 4),
          format: { mediaType: role, codec: 'codec', config: Uint8Array.of(9, 4) } });
      } finally { await player.destroy(); }
    });
  }
});

describe('configure receipt consumer ownership', () => {
  for (const role of ['video', 'audio'] as const) {
    it.each([false, true])(`a transformed ${role} config getter cannot replace a newer installed receipt: %s`, async reenter => {
      const first = Uint8Array.of(1), newer = Uint8Array.of(2);
      const calls: Array<{ bytes: Uint8Array; codec: string }> = [];
      const video: VideoDecoderLike = { configure(bytes, codec) { calls.push({ bytes, codec }); }, decode: vi.fn(),
        flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onFrame: null, onError: null };
      const audio: AudioDecoderLike = { configure(bytes, codec) { calls.push({ bytes, codec }); }, decode: vi.fn(),
        flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
      const dispatcher = new CommandDispatcher({ videoDecoder: video, audioDecoder: audio, videoCodec: 'outer', audioCodec: 'outer' });
      const original: DecoderCommand = { type: 'configure', mediaType: role, config: first };
      const next: DecoderCommand = { type: 'configure', mediaType: role, config: newer };
      let reads = 0;
      const transformed: DecoderCommand = { type: 'configure', mediaType: role, get config() {
        if (++reads === 1 && reenter) {
          if (role === 'video') dispatcher.updateVideoCodec('inner');
          invoke(next);
        }
        return first;
      } };
      const player = new MoqtPlayer({ ...DEFAULT_PLAYER_CONFIG, url: 'https://receipt.invalid/moq', namespace: ['receipt'],
        clock: { now: () => 0 }, commandTransform: command => command === original ? transformed : command });
      // Controlled consumer-unit setup: install the real dispatcher dependency.
      // Do not replace the handler, token map, ledger, lifecycle or return body.
      expect(Reflect.set(player, 'commandDispatcher', dispatcher)).toBe(true);
      function invoke(command: DecoderCommand): void {
        const handler: unknown = Reflect.get(player, 'handlePipelineCommand');
        if (typeof handler !== 'function') throw new Error('Consumer fixture handler unavailable');
        Reflect.apply(handler, player, [command]);
      }
      try {
        invoke(original);
        const expectedBytes = reenter ? newer : first, expectedCodec = reenter && role === 'video' ? 'inner' : 'outer';
        expect(calls.at(-1)).toEqual({ bytes: expectedBytes, codec: expectedCodec });
        const ledger: unknown = Reflect.get(player, 'installedDecoderConfigurations');
        if (!(ledger instanceof Map)) throw new Error('Consumer fixture ledger unavailable');
        const record: unknown = ledger.get(role);
        expect(record).toEqual({ dispatcher, requested: expectedBytes, configured: expectedBytes,
          format: { mediaType: role, codec: expectedCodec, config: expectedBytes } });
      } finally { await player.destroy(); }
    });
  }
});
