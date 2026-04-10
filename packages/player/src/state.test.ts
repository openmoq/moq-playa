/**
 * PlayerState machine tests — red/green TDD.
 *
 * Player lifecycle: idle → loading → playing ↔ paused → ended | error
 *
 * @see draft-ietf-moq-transport-16 §3 (session lifecycle)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { PlayerStateMachine, PlayerState } from './state.js';

describe('PlayerStateMachine', () => {
  it('starts in idle state', () => {
    const sm = new PlayerStateMachine();
    expect(sm.state).toBe(PlayerState.IDLE);
  });

  it('idle → loading via load()', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.LOADING);
    expect(sm.state).toBe(PlayerState.LOADING);
  });

  it('loading → playing via play()', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.LOADING);
    sm.transition(PlayerState.PLAYING);
    expect(sm.state).toBe(PlayerState.PLAYING);
  });

  it('playing → paused', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.LOADING);
    sm.transition(PlayerState.PLAYING);
    sm.transition(PlayerState.PAUSED);
    expect(sm.state).toBe(PlayerState.PAUSED);
  });

  it('paused → playing', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.LOADING);
    sm.transition(PlayerState.PLAYING);
    sm.transition(PlayerState.PAUSED);
    sm.transition(PlayerState.PLAYING);
    expect(sm.state).toBe(PlayerState.PLAYING);
  });

  it('playing → ended', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.LOADING);
    sm.transition(PlayerState.PLAYING);
    sm.transition(PlayerState.ENDED);
    expect(sm.state).toBe(PlayerState.ENDED);
  });

  it('any state → error', () => {
    for (const from of [
      PlayerState.IDLE,
      PlayerState.LOADING,
      PlayerState.PLAYING,
      PlayerState.PAUSED,
    ] as const) {
      const sm = new PlayerStateMachine();
      // Drive to the 'from' state
      if (from === PlayerState.LOADING || from === PlayerState.PLAYING || from === PlayerState.PAUSED) {
        sm.transition(PlayerState.LOADING);
      }
      if (from === PlayerState.PLAYING || from === PlayerState.PAUSED) {
        sm.transition(PlayerState.PLAYING);
      }
      if (from === PlayerState.PAUSED) {
        sm.transition(PlayerState.PAUSED);
      }
      sm.transition(PlayerState.ERROR);
      expect(sm.state).toBe(PlayerState.ERROR);
    }
  });

  it('rejects invalid transitions', () => {
    const sm = new PlayerStateMachine();
    // idle → playing is invalid (must go through loading)
    expect(() => sm.transition(PlayerState.PLAYING)).toThrow();
    expect(sm.state).toBe(PlayerState.IDLE);
  });

  it('ended is terminal — cannot transition out', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.LOADING);
    sm.transition(PlayerState.PLAYING);
    sm.transition(PlayerState.ENDED);
    expect(() => sm.transition(PlayerState.PLAYING)).toThrow();
  });

  it('error is terminal — cannot transition out', () => {
    const sm = new PlayerStateMachine();
    sm.transition(PlayerState.ERROR);
    expect(() => sm.transition(PlayerState.IDLE)).toThrow();
  });
});
