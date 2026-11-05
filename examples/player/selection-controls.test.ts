import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCatalogSelection, type MoqtPlayer, type MediaSelectionSnapshot } from '@openmoq/player';
import type { CatalogTrack } from '@openmoq/msf';
import { renderTrackMenus, selectionMenus, updateSelectionLink, playbackOwnerIsCurrent, type TrackMenuElements } from './selection-controls.js';

// A small DOM surface keeps control tests local and independent of transport/browser startup.
class Element extends EventTarget {
    className = '';
    textContent = '';
    title = '';
    hidden = false;
    disabled = false;
    value = '';
    onchange: ((event: Event) => void) | null = null;
    style: Record<string, string> = {};
    children: Element[] = [];
    attributes = new Map<string, string>();
    classList = {
        contains: (name: string) => this.className.split(' ').includes(name),
        add: (name: string) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
        remove: (name: string) => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
        toggle: (name: string, force?: boolean) => {
            const add = force ?? !this.classList.contains(name);
            if (add) this.classList.add(name); else this.classList.remove(name);
            return add;
        },
    };
    set innerHTML(value: string) { this.textContent = value; this.children = []; }
    appendChild(child: Element) { this.children.push(child); return child; }
    replaceChildren(...children: Element[]) { this.children = children; }
    querySelector() { return null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
    change(value: string) { this.value = value; if (!this.disabled) this.onchange?.(new Event('change')); }
}

function elements() {
    const result = Object.fromEntries([
        'programControl', 'programSelect', 'viewControl', 'viewSelect',
        'videoTrackDropdown', 'videoTrackBtn', 'videoTrackLabel', 'videoTrackMenu',
        'audioTrackDropdown', 'audioTrackBtn', 'audioTrackLabel', 'audioTrackMenu',
    ].map(key => [key, new Element()]));
    return result as unknown as TrackMenuElements;
}
const node = (value: unknown) => value as Element;
const track = (name: string, role: 'video' | 'audio', extra: Partial<CatalogTrack> = {}): CatalogTrack => ({
    name, role, packaging: 'loc', isLive: false, ...extra,
});
const id = (name: string, namespaceFields = ['live']) => ({ name, namespaceFields });
function setup(tracks: CatalogTrack[], selection: Partial<MediaSelectionSnapshot> = {}) {
    vi.stubGlobal('document', { createElement: () => new Element(), getElementById: () => null });
    const selected: MediaSelectionSnapshot = { revision: 1, scope: { kind: 'render-group', renderGroup: 0 },
        video: null, audio: null, videoAlternatives: [], audioChoices: [], autoQuality: false, ...selection };
    const p = { selection: selected, availableVideoTracks: tracks.filter(t => t.role === 'video'),
        availableVideoGroups: [{ altGroup: 0, tracks }], stats: { currentResolution: { width: 1280, height: 720 } },
        selectVideoTrack: vi.fn(async () => {}) };
    const model = buildCatalogSelection({ version: 1, tracks }, { catalogNamespace: ['live'] });
    const dom = elements();
    const actions = { video: p.selectVideoTrack, retune: vi.fn() };
    const render = (disabled = false) => renderTrackMenus(p as unknown as MoqtPlayer, dom, model, actions, disabled);
    return { p, dom, actions, model, render };
}
afterEach(() => vi.unstubAllGlobals());

describe('example selection controls', () => {
    it('marks the adopted full identity, even when names and resolutions match', () => {
        const a = track('main', 'video', { namespace: 'a', renderGroup: 0, altGroup: 0, width: 1280, height: 720 });
        const b = { ...a, namespace: 'b' };
        const { dom, render } = setup([a, b], { video: id('main', ['b']),
            videoAlternatives: [id('main', ['a']), id('main', ['b'])] });
        render();
        expect(node(dom.videoTrackMenu).children.map(item => item.classList.contains('active'))).toEqual([false, true]);
    });
    it('passes an exact namespace tuple to video quality selection', () => {
        const t = track('main', 'video', { renderGroup: 0, altGroup: 0,
            resolvedNamespace: { fields: ['a/b'], source: 'inherited' } });
        const { dom, p, render } = setup([t], { videoAlternatives: [id('main', ['a/b'])] });
        render();
        node(dom.videoTrackMenu).children[0]!.click();
        expect(p.selectVideoTrack).toHaveBeenCalledWith({ name: 'main', namespace: ['a/b'] });
    });
    it('offers scoped audio choices using the public catalog model', () => {
        const tracks = [track('en', 'audio', { renderGroup: 0, lang: 'en', altGroup: 0 }),
            track('es', 'audio', { renderGroup: 0, lang: 'es', altGroup: 0 }), track('loose', 'audio', { lang: 'fr' })];
        const { dom, p, actions, render } = setup(tracks, { audio: id('en'), audioChoices: [id('en'), id('es')] });
        Object.defineProperty(p, '_catalogState', { get() { throw new Error('Private catalog accessed'); } });
        render();
        expect(node(dom.audioTrackMenu).children).toHaveLength(2);
        node(dom.audioTrackMenu).children[1]!.click();
        expect(actions.retune).toHaveBeenCalled();
    });
});


describe('scopes, sets and fresh configuration', () => {
    it('offers render group zero and unassigned separately and never borrows loose audio', () => {
        const { dom, p, model, render, actions } = setup([
            track('main', 'video', { renderGroup: 0, altGroup: 0 }),
            track('other', 'video', { renderGroup: 7 }), track('loose', 'audio', { lang: 'fr' }),
        ], { video: id('main'), videoAlternatives: [id('main')], audioChoices: [id('loose')] });
        render();
        expect(node(dom.programSelect).children.map(option => option.textContent)).toEqual(['Render group 0', 'Render group 7', 'Unassigned']);
        expect(node(dom.programSelect).value).toBe(node(dom.programSelect).children[0]!.value);
        expect(node(dom.audioTrackMenu).children).toHaveLength(0);
        expect(selectionMenus(model, p.selection).audio).toEqual([]);
        node(dom.programSelect).change(node(dom.programSelect).children[2]!.value);
        expect(actions.retune.mock.calls[0]![0].selection).toEqual({ renderGroup: null });
        expect(node(dom.programSelect).value).toBe(node(dom.programSelect).children[0]!.value);
    });
    it('keeps singleton views exact when a slash field and two fields print alike', () => {
        const tracks = [
            track('main', 'video', { renderGroup: 0, resolvedNamespace: { fields: ['a/b'], source: 'inherited' } }),
            track('main', 'video', { renderGroup: 0, resolvedNamespace: { fields: ['a', 'b'], source: 'inherited' } }),
            track('ladder', 'video', { renderGroup: 0, altGroup: 0 }),
        ];
        const { dom, p, model, render, actions } = setup(tracks, { video: id('main', ['a', 'b']),
            videoAlternatives: [id('main', ['a', 'b'])] });
        render();
        const menus = selectionMenus(model, p.selection);
        expect(menus.views.map(choice => choice.active)).toEqual([false, true, false]);
        expect(new Set(menus.views.map(choice => choice.key)).size).toBe(3);
        expect(new Set(menus.views.map(choice => choice.label)).size).toBe(3);
        expect(node(dom.viewSelect).value).toBe(menus.views[1]!.key);
        node(dom.viewSelect).change(menus.views[0]!.key);
        expect(actions.retune.mock.calls[0]![0].selection).toEqual({ renderGroup: 0, videoTrack: { name: 'main', namespace: ['a/b'] } });
        expect(menus.views[2]!.selection).toEqual({ renderGroup: 0, videoAltGroup: 0 });
        expect(node(dom.videoTrackMenu).children).toHaveLength(1);
    });
    it('uses only offered members and adopted choices rather than unsupported catalog entries', () => {
        const { dom, render } = setup([
            track('ok', 'video', { renderGroup: 0, altGroup: 0 }),
            track('excluded', 'video', { renderGroup: 0, altGroup: 9, packaging: 'locmaf', locmafVersion: 'draft-99' }),
            track('unaccepted', 'video', { renderGroup: 0, altGroup: 0 }),
        ], { video: id('ok'), videoAlternatives: [id('ok')] });
        render();
        expect(node(dom.videoTrackMenu).children).toHaveLength(1);
        expect(node(dom.viewSelect).children).toHaveLength(1);
    });
    it('shows audio language and label and adopts only the exact current identity', () => {
        const { dom, model, p, render, actions } = setup([
            track('main', 'video', { renderGroup: 0, altGroup: 0 }),
            track('voice', 'audio', { namespace: 'a', renderGroup: 0, altGroup: 3, label: '<b>Commentary</b>', lang: 'en' }),
            track('voice', 'audio', { namespace: 'b', renderGroup: 0, altGroup: 3, label: '<b>Commentary</b>', lang: 'en' }),
            track('other', 'audio', { renderGroup: 2, lang: 'es' }),
        ], { video: id('main'), videoAlternatives: [id('main')], audio: id('voice', ['b']),
            audioChoices: [id('voice', ['a']), id('voice', ['b']), id('other')] });
        render();
        const items = node(dom.audioTrackMenu).children;
        expect(items.map(item => item.classList.contains('active'))).toEqual([false, true]);
        expect(items[0]!.textContent).toContain('<b>Commentary</b>');
        expect(items[0]!.children).toEqual([]);
        expect(node(dom.audioTrackLabel).textContent).toBe(items[1]!.textContent);
        items[0]!.click();
        const choice = actions.retune.mock.calls[0]![0];
        expect(choice.language).toBe('en');
        expect(choice.selection).toEqual({ renderGroup: 0, videoTrack: { name: 'main', namespace: ['live'] },
            audioTrack: { name: 'voice', namespace: ['a'] } });
        const programs = selectionMenus(model, p.selection).programs;
        expect(programs[1]!.selection).toEqual({ renderGroup: 2 });
        expect(programs[1]!.selection).not.toHaveProperty('audioTrack');
    });
    it('keeps automatic video set selection when fresh audio is chosen', () => {
        const { model, p } = setup([track('v', 'video', { renderGroup: 0, altGroup: 0 }),
            track('a', 'audio', { renderGroup: 0 })], { video: id('v'), autoQuality: true, audioChoices: [id('a')] });
        expect(selectionMenus(model, p.selection).audio[0]!.selection).toEqual({ renderGroup: 0, videoAltGroup: 0,
            audioTrack: { name: 'a', namespace: ['live'] } });
    });
    it('preserves unrelated link parameters and the legacy altGroup convention without flattening singletons', () => {
        const params = new URLSearchParams('url=relay&nsField=a%2Fb&res=720&altGroup=-1');
        updateSelectionLink(params, { renderGroup: 0, videoAltGroup: 0 });
        expect(params.get('altGroup')).toBe('0');
        updateSelectionLink(params, { renderGroup: 0, videoTrack: { name: 'main', namespace: ['a/b'] } });
        expect(params.has('altGroup')).toBe(false);
        expect([...params]).toEqual([['url', 'relay'], ['nsField', 'a/b'], ['res', '720']]);
    });
});

describe('control availability and stale ownership', () => {
    it('disables every control while busy and recovers on a fresh render', () => {
        const { dom, render, actions, p } = setup([
            track('a', 'video', { renderGroup: 0, altGroup: 0 }), track('b', 'video', { renderGroup: 0, altGroup: 1 }),
            track('c', 'video', { renderGroup: 1 }), track('en', 'audio', { renderGroup: 0 }), track('es', 'audio', { renderGroup: 0 }),
        ], { video: id('a'), videoAlternatives: [id('a')], audio: id('en'), audioChoices: [id('en'), id('es')] });
        render(true);
        expect([dom.programSelect, dom.viewSelect, dom.videoTrackBtn, dom.audioTrackBtn].every(control => control.disabled)).toBe(true);
        expect(node(dom.videoTrackMenu).children.every(item => item.disabled)).toBe(true);
        expect(node(dom.audioTrackMenu).children.every(item => item.disabled)).toBe(true);
        node(dom.audioTrackMenu).children[1]!.click();
        expect(actions.retune).not.toHaveBeenCalled();
        render(false);
        expect([dom.programSelect, dom.viewSelect, dom.videoTrackBtn, dom.audioTrackBtn].every(control => !control.disabled)).toBe(true);
        node(dom.audioTrackMenu).children[1]!.click();
        expect(actions.retune).toHaveBeenCalledTimes(1);
        expect(p.selectVideoTrack).not.toHaveBeenCalled();
    });
    it('clears stale audio controls when the adopted scope has no audio', () => {
        const { dom, p, render } = setup([track('a', 'audio', { renderGroup: 0 }), track('v', 'video', { renderGroup: 1 })],
            { audio: id('a'), audioChoices: [id('a')] });
        render();
        expect(node(dom.audioTrackDropdown).classList.contains('visible')).toBe(true);
        p.selection = { ...p.selection, scope: { kind: 'render-group', renderGroup: 1 }, audio: null, audioChoices: [] };
        render();
        expect(node(dom.audioTrackDropdown).classList.contains('visible')).toBe(false);
        expect(node(dom.audioTrackMenu).children).toHaveLength(0);
        expect(node(dom.audioTrackLabel).textContent).toBe('Audio');
    });
    it('does not guess an active view or quality before adoption', () => {
        const { dom, render } = setup([track('a', 'video', { renderGroup: 0, altGroup: 0 }),
            track('b', 'video', { renderGroup: 0, altGroup: 1 })], { videoAlternatives: [id('a')] });
        render();
        expect(node(dom.viewSelect).value).toBe('');
        expect(node(dom.videoTrackMenu).children.some(item => item.classList.contains('active'))).toBe(false);
        expect(node(dom.videoTrackLabel).textContent).toBe('Video');
    });
    it('allows recovery to the only remaining offered program when the old scope disappears', () => {
        const { dom, render, actions } = setup([track('new', 'video', { renderGroup: 1 })]);
        render();
        expect(dom.programSelect.disabled).toBe(false);
        node(dom.programSelect).change(node(dom.programSelect).children[0]!.value);
        expect(actions.retune.mock.calls[0]![0].selection).toEqual({ renderGroup: 1 });
    });
    it('rejects retired players and epochs even when an owner object is reused', () => {
        const old = {};
        expect(playbackOwnerIsCurrent(old, 1, old, 1)).toBe(true);
        expect(playbackOwnerIsCurrent(old, 1, {}, 1)).toBe(false);
        expect(playbackOwnerIsCurrent(old, 1, old, 2)).toBe(false);
        expect(playbackOwnerIsCurrent(old, 1, null, 2)).toBe(false);
    });
});
