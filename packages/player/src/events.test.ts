/**
 * Player event type tests — verify the event map is well-formed.
 *
 * Since events.ts is mostly types, these tests ensure:
 * - The TypedEmitter can be instantiated with PlayerEventMap
 * - Events can be emitted with correct shapes
 * - Type narrowing works on the discriminated union
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { TypedEmitter } from './emitter.js';
import type { PlayerEventMap, PlayerEvent } from './events.js';

describe('PlayerEventMap', () => {
  it('TypedEmitter<PlayerEventMap> can emit session events', () => {
    const emitter = new TypedEmitter<PlayerEventMap>();
    const fn = vi.fn();
    emitter.on('session_connecting', fn);
    emitter.emit('session_connecting', {
      type: 'session_connecting',
      url: 'https://relay.example.com',
    });
    expect(fn).toHaveBeenCalledWith({
      type: 'session_connecting',
      url: 'https://relay.example.com',
    });
  });

  it('TypedEmitter<PlayerEventMap> can emit playback events', () => {
    const emitter = new TypedEmitter<PlayerEventMap>();
    const fn = vi.fn();
    emitter.on('gap_detected', fn);
    emitter.emit('gap_detected', {
      type: 'gap_detected',
      mediaType: 'video',
      groupId: 42n,
    });
    expect(fn).toHaveBeenCalledWith({
      type: 'gap_detected',
      mediaType: 'video',
      groupId: 42n,
    });
  });

  it('PlayerEvent union discriminates by type field', () => {
    const event: PlayerEvent = {
      type: 'state_changed',
      from: 'idle',
      to: 'loading',
    };
    // Discriminated union narrowing
    if (event.type === 'state_changed') {
      expect(event.from).toBe('idle');
      expect(event.to).toBe('loading');
    }
  });

  it('recovery_action event carries RecoveryAction', () => {
    const emitter = new TypedEmitter<PlayerEventMap>();
    const fn = vi.fn();
    emitter.on('recovery_action', fn);
    emitter.emit('recovery_action', {
      type: 'recovery_action',
      action: { type: 'skip_forward' },
    });
    expect(fn).toHaveBeenCalledWith({
      type: 'recovery_action',
      action: { type: 'skip_forward' },
    });
  });
});
