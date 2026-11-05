import { expect, it } from 'vitest';
import { viewChoiceValue, programChoiceValue } from './view-choice.mjs';

const group = (number: number) => JSON.stringify(['view', { kind: 'render-group', renderGroup: 0 }, number]);
it('selects declared group zero without mistaking an ungrouped singleton for it', () => {
  expect(viewChoiceValue([JSON.stringify(['view', { kind: 'unassigned' }, { name: '0', namespaceFields: ['live/show'] }]),
    group(1), group(0)], 0)).toBe(group(0));
});
it('refuses absent, ambiguous and malformed choices instead of taking the first option', () => {
  expect(() => viewChoiceValue(['0', 'malformed', group(1)], 0)).toThrow('found 0');
  expect(() => viewChoiceValue([group(0), group(0)], 0)).toThrow('found 2');
});

it('keeps program zero and the unassigned pool separate', () => {
  const zero = JSON.stringify(['scope', { kind: 'render-group', renderGroup: 0 }]);
  const none = JSON.stringify(['scope', { kind: 'unassigned' }]);
  expect(programChoiceValue([none, zero], 0)).toBe(zero);
  expect(programChoiceValue([zero, none], null)).toBe(none);
  expect(() => programChoiceValue([zero, zero], 0)).toThrow('found 2');
  expect(() => programChoiceValue([none], 0)).toThrow('found 0');
});
