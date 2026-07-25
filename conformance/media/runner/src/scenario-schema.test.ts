/**
 * The scenario schema (moq-media-scenario/1) is finalized and COMPILED (ajv)
 * ahead of the scenario runner itself. This test exercises a
 * complete valid scenario plus one invalid fixture per operation and per nested
 * contract, so the schema is a real gate rather than a placeholder.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { jsonSchemaValidateScenario } from './schema-json.js';

const PROV = { class: 'spec-derived', source: 'draft-ietf-moq-loc-01', section: '2.3', generator: 'hand-authored', generatorVersion: 'n/a', command: 'n/a', sourceHash: 'a'.repeat(64) };

function scenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scenarioSchema: 'moq-media-scenario/1',
    id: 'scen/example',
    description: 'a scenario',
    expectationBasis: 'normative',
    provenance: PROV,
    input: { presentation: { tracks: [{ name: 'v', kind: 'video', packaging: 'loc', locProfile: 'loc-01' }] }, subscriptions: [{ track: 'v' }] },
    steps: [
      { op: { object: { track: 'v', group: '7', object: '1', payload: { synthetic: { byteLength: 100 } } } } },
      { op: { advanceTimeUs: { byUs: '33000' } } },
      { op: { service: {} } },
      { op: { checkpoint: { label: 'k' } } },
    ],
    // A non-regression scenario must carry shared assertions (golden alone is regression-only).
    expect: { assertions: { events: { required: [{ ev: 'warning', category: 'gap-skipped-to-group' }] } } },
    ...overrides,
  };
}

describe('scenario schema — valid scenarios', () => {
  it('a complete normative scenario with assertions validates', () => {
    expect(jsonSchemaValidateScenario(scenario())).toEqual([]);
  });
  it('a regression scenario may carry ONLY a golden', () => {
    expect(jsonSchemaValidateScenario(scenario({ expectationBasis: 'regression', expect: { golden: { playa: 'expected/x.trace.jsonl' } } }))).toEqual([]);
  });
  it('validates each operation form', () => {
    const ops = [
      { fin: { track: 'v' } },
      { reset: { track: 'v', code: '1' } },
      { trackSwitch: { fromTrack: 'a', toTrack: 'b' } },
      { pressure: { level: 'high' } },
      { sinkFault: { track: 'v', kind: 'decode-error' } },
    ];
    for (const op of ops) {
      expect(jsonSchemaValidateScenario(scenario({ steps: [{ op }] })), JSON.stringify(op)).toEqual([]);
    }
  });
});

describe('scenario schema — discriminating rejections', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['empty expect', scenario({ expect: {} })],
    ['normative with ONLY a golden (assertions required)', scenario({ expect: { golden: { playa: 'x' } } })],
    ['both catalogRef and presentation', scenario({ input: { catalogRef: 'x', presentation: { tracks: [] } } })],
    ['neither catalogRef nor presentation', scenario({ input: {} })],
    ['subscription with atUs (single-clock violation)', scenario({ input: { presentation: { tracks: [] }, subscriptions: [{ track: 'v', atUs: '1' }] } })],
    ['track missing packaging', scenario({ input: { presentation: { tracks: [{ name: 'v', kind: 'video' }] } } })],
    ['cmaf track with a locProfile (incompatible)', scenario({ input: { presentation: { tracks: [{ name: 'v', kind: 'video', packaging: 'cmaf', locProfile: 'loc-04' }] } } })],
    ['loc track without a locProfile', scenario({ input: { presentation: { tracks: [{ name: 'v', kind: 'video', packaging: 'loc' }] } } })],
    ['arbitrary track keys', scenario({ input: { presentation: { tracks: [{ name: 'v', kind: 'video', packaging: 'loc', locProfile: 'loc-01', anything: true }] } } })],
    ['arbitrary presentation keys', scenario({ input: { presentation: { anything: true } } })],
    ['service with extra keys', scenario({ steps: [{ op: { service: { anything: true } } }] })],
    ['synthetic with extra keys', scenario({ steps: [{ op: { object: { track: 'v', group: '1', object: '0', payload: { synthetic: { byteLength: 10, anything: true } } } } }] })],
    ['loc.rawHex with extra keys', scenario({ steps: [{ op: { object: { track: 'v', group: '1', object: '0', loc: { rawHex: '00', anything: true } } } }] })],
    ['loc property with extra keys', scenario({ steps: [{ op: { object: { track: 'v', group: '1', object: '0', loc: [{ id: '2', value: '42', anything: true }] } } }] })],
    ['assertion event with an arbitrary field', scenario({ expect: { assertions: { events: { required: [{ ev: 'warning', category: 'x', bogus: 1 }] } } } })],
    ['unknown event kind', scenario({ expect: { assertions: { events: { required: [{ ev: 'teleported' }] } } } })],
    ['empty assertions', scenario({ expect: { assertions: {} } })],
    ['unknown op', scenario({ steps: [{ op: { teleport: {} } }] })],
    ['pressure with a bad level', scenario({ steps: [{ op: { pressure: { level: 'medium' } } }] })],
    ['object group as a JSON number', scenario({ steps: [{ op: { object: { track: 'v', group: 7, object: '1' } } }] })],
    ['synthetic byteLength above int32 (2^53 hazard)', scenario({ steps: [{ op: { object: { track: 'v', group: '1', object: '0', payload: { synthetic: { byteLength: 9007199254740992 } } } } }] })],
    ['synthetic byteLength negative', scenario({ steps: [{ op: { object: { track: 'v', group: '1', object: '0', payload: { synthetic: { byteLength: -1 } } } } }] })],
    ['unknown top-level field', scenario({ extra: 1 })],
    ['missing expectationBasis', (() => { const s = scenario(); delete s['expectationBasis']; return s; })()],
  ];
  for (const [name, s] of bad) {
    it(`rejects: ${name}`, () => {
      expect(jsonSchemaValidateScenario(s).length, name).toBeGreaterThan(0);
    });
  }
});
