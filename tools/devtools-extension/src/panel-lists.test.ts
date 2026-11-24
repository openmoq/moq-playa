import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// A small DOM model checks renderer identity and action binding; native mouse delivery is covered in real-panel.
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  className = ''; textContent = ''; title = ''; value = '';
  style: Record<string, string> = {};
  classList = { toggle() {} };
  onclick: (() => void) | null = null;
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes: Node[]) { for (const n of this.children) n.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  replaceWith(n: Node) { const p = this.parent!; p.children[p.children.indexOf(this)] = n; n.parent = p; this.parent = null; }
  isEqualNode(n: Node): boolean { return this.tag === n.tag && this.className === n.className && this.textContent === n.textContent && this.title === n.title && JSON.stringify(this.style) === JSON.stringify(n.style) && this.children.length === n.children.length && this.children.every((c, i) => c.isEqualNode(n.children[i]!)); }
}
function setup() {
  const nodes = new Map<string, Node>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node('div')); return nodes.get(id)!; };
  const actions: unknown[] = [];
  const state = {
    $, el: (tag: string, cls = '', text = '') => Object.assign(new Node(tag), { className: cls, textContent: text }),
    document: { title: '' }, mockPreview: false, mode: 'probe',
    vm: { exposed: true, picker: {}, actions: {}, recording: {}, hookStats: '', tracks: [], instances: [], ring: '' },
    host: { probe: { core: { phase: 'attached' } }, core: { phase: 'discovered', sources: [] as unknown[] } }, presets: { items: [] as unknown[] },
    viewPort: { postMessage: (m: unknown) => actions.push(m) },
    active: () => ({ selectTrack: (id: string) => actions.push(id) }),
    hostLabel: () => ({}), recordLabel: () => ({}), compactStats: (s: string) => s,
    probeRunning: () => false, probeBlocked: () => false, probeStatusLine: () => '',
  };
  const source = readFileSync(new URL('./panel.js', import.meta.url), 'utf8');
  // Execute the actual list-rendering portion, without booting ports or unrelated grid/chart rendering.
  const helper = source.match(/function renderList\([\s\S]*?\n}\n/)?.[0] ?? '';
  const render = source.slice(source.indexOf('function render() {'), source.indexOf('  // Long exact values')) + '}';
  const paint: () => void = runInNewContext(`const listNodes = new Map(); ${helper}\n${render}\nrender`, state);
  return { state, $, actions, paint };
}

describe('clickable list rows', () => {
  for (const list of ['pickList', 'trackTabs', 'instances', 'probePresetList']) {
    const prepare = () => {
      const t = setup();
      const set = (version: number) => {
        t.state.host.core.sources = [{ sourceId: 'source', runId: `run-${version}`, label: `Source ${version}`, kind: 'player' }];
        Object.assign(t.state.vm, { tracks: [{ id: `track-${version}`, name: `Track ${version}` }], instances: [{ id: 'source', name: `Instance ${version}`, sub: 'ready' }] });
        t.state.presets.items = [{ name: `Preset ${version}`, namespace: `ns-${version}` }];
        t.paint();
      };
      const act = (version: number) => {
        t.$(list).children[0]!.onclick!();
        if (list === 'probePresetList') expect(t.$('probeNs').value).toBe(JSON.stringify([`ns-${version}`]));
        else expect(t.actions.splice(0)).toEqual([list === 'trackTabs' ? `track-${version}` : { kind: list === 'pickList' ? 'select' : 'switch', sourceId: 'source', runId: `run-${version}` }]);
      };
      return { ...t, set, act };
    };
    it(`${list} keeps the row and its children on an unchanged render`, () => {
      const t = prepare(); t.set(1);
      const row = t.$(list).children[0]!, children = [...row.children];
      t.set(1);
      expect(t.$(list).children[0]!).toBe(row);
      children.forEach((c, i) => expect(row.children[i]).toBe(c));
      t.act(1);
    });
    it(`${list} displays and acts on the changed item`, () => {
      const t = prepare(); t.set(1); t.set(2);
      const row = t.$(list).children[0]!;
      expect(row.textContent || row.children[0]!.textContent).toContain('2');
      t.act(2);
      t.state.host.core.sources = []; t.state.presets.items = [];
      Object.assign(t.state.vm, { tracks: [], instances: [] }); t.paint();
      expect(t.$(list).children).toHaveLength(0);
      t.set(3); t.act(3);
    });
  }
  it('refreshes a kept instance handler when only the source run changes', () => {
    const t = setup();
    Object.assign(t.state.vm, { instances: [{ id: 'source', name: 'Same label', sub: 'ready' }] });
    t.state.host.core.sources = [{ sourceId: 'source', runId: 'old' }]; t.paint();
    const row = t.$('instances').children[0]!;
    t.state.host.core.sources = [{ sourceId: 'source', runId: 'new' }]; t.paint();
    expect(t.$('instances').children[0]!).toBe(row);
    row.onclick!();
    expect(t.actions).toEqual([{ kind: 'switch', sourceId: 'source', runId: 'new' }]);
  });
});
