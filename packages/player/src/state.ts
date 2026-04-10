/**
 * Player lifecycle state machine.
 *
 * ```
 * idle → loading → playing ↔ paused → ended
 *   \       \         \         \
 *    └───────└─────────└─────────└──→ error
 * ```
 *
 * - `idle`: constructed, not connected
 * - `loading`: connecting + subscribing to catalog + initial tracks
 * - `playing`: tick loop active, objects flowing (Forward State = 1)
 * - `paused`: tick loop stopped, REQUEST_UPDATE forward:0 sent (§9.11)
 * - `ended`: all tracks ended (PUBLISH_DONE with TRACK_ENDED §9.15)
 * - `error`: unrecoverable error
 *
 * @see draft-ietf-moq-transport-16 §3 (session lifecycle)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @module
 */

export const PlayerState = {
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDED: 'ended',
  ERROR: 'error',
} as const;

export type PlayerStateValue = (typeof PlayerState)[keyof typeof PlayerState];

/** Valid transitions from each state. */
const VALID_TRANSITIONS: Record<PlayerStateValue, readonly PlayerStateValue[]> = {
  [PlayerState.IDLE]: [PlayerState.LOADING, PlayerState.ENDED, PlayerState.ERROR],
  [PlayerState.LOADING]: [PlayerState.PLAYING, PlayerState.ENDED, PlayerState.ERROR],
  [PlayerState.PLAYING]: [PlayerState.PAUSED, PlayerState.ENDED, PlayerState.ERROR],
  [PlayerState.PAUSED]: [PlayerState.PLAYING, PlayerState.ENDED, PlayerState.ERROR],
  [PlayerState.ENDED]: [],
  [PlayerState.ERROR]: [PlayerState.ENDED],
};

/**
 * Player lifecycle state machine with validated transitions.
 */
export class PlayerStateMachine {
  private _state: PlayerStateValue = PlayerState.IDLE;

  /** Current state. */
  get state(): PlayerStateValue {
    return this._state;
  }

  /**
   * Transition to a new state.
   * @throws {Error} If the transition is invalid.
   */
  transition(to: PlayerStateValue): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid state transition: ${this._state} → ${to}`,
      );
    }
    this._state = to;
  }
}
