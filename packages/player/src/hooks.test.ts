/**
 * HookChain tests — red/green TDD.
 *
 * HookChain provides composable interception points.
 * Hooks run in order; returning null cancels the chain.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { HookChain } from './hooks.js';

interface TestPayload {
  value: number;
  label: string;
}

describe('HookChain', () => {
  it('run() on empty chain returns the input unchanged', () => {
    const chain = new HookChain<TestPayload>();
    const input: TestPayload = { value: 1, label: 'a' };
    expect(chain.run(input)).toEqual(input);
  });

  it('single hook modifies the value', () => {
    const chain = new HookChain<TestPayload>();
    chain.add((v) => ({ ...v, value: v.value * 2 }));
    expect(chain.run({ value: 3, label: 'x' })).toEqual({ value: 6, label: 'x' });
  });

  it('hooks chain in insertion order', () => {
    const chain = new HookChain<TestPayload>();
    chain.add((v) => ({ ...v, label: v.label + '1' }));
    chain.add((v) => ({ ...v, label: v.label + '2' }));
    expect(chain.run({ value: 0, label: '' })).toEqual({ value: 0, label: '12' });
  });

  it('returning null cancels the chain', () => {
    const chain = new HookChain<TestPayload>();
    const hook1 = vi.fn(() => null);
    const hook2 = vi.fn((v: TestPayload) => v);
    chain.add(hook1);
    chain.add(hook2);
    expect(chain.run({ value: 1, label: 'a' })).toBeNull();
    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).not.toHaveBeenCalled();
  });

  it('later hook can cancel after earlier hook modifies', () => {
    const chain = new HookChain<TestPayload>();
    chain.add((v) => ({ ...v, value: v.value + 10 }));
    chain.add((v) => v.value > 5 ? null : v);
    expect(chain.run({ value: 1, label: 'a' })).toBeNull();
  });

  it('remove() removes a specific hook', () => {
    const chain = new HookChain<TestPayload>();
    const hook = (v: TestPayload): TestPayload => ({ ...v, value: 999 });
    chain.add(hook);
    chain.remove(hook);
    expect(chain.run({ value: 1, label: 'a' })).toEqual({ value: 1, label: 'a' });
  });
});
