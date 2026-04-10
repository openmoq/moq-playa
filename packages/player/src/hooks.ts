/**
 * HookChain — composable interception points for player decisions.
 *
 * Hooks run in insertion order. Each receives the (possibly modified)
 * value from the previous hook. Returning null cancels the chain.
 *
 * Used for:
 * - beforeSubscribe: intercept/modify/cancel subscription intents
 * - beforeQualitySwitch: intercept ABR decisions
 * - onRecovery: intercept/override recovery actions
 *
 * @module
 */

/** A hook function: transforms the value, or returns null to cancel. */
export type HookFn<T> = (value: T) => T | null;

/**
 * An ordered chain of hook functions.
 *
 * @typeParam T - The type flowing through the chain.
 */
export class HookChain<T> {
  private readonly hooks: HookFn<T>[] = [];

  /** Append a hook to the end of the chain. */
  add(hook: HookFn<T>): void {
    this.hooks.push(hook);
  }

  /** Remove a specific hook from the chain. */
  remove(hook: HookFn<T>): void {
    const idx = this.hooks.indexOf(hook);
    if (idx !== -1) {
      this.hooks.splice(idx, 1);
    }
  }

  /**
   * Run the value through all hooks in order.
   * @returns The final value, or null if any hook cancelled.
   */
  run(value: T): T | null {
    let current: T | null = value;
    for (const hook of this.hooks) {
      current = hook(current);
      if (current === null) return null;
    }
    return current;
  }
}
