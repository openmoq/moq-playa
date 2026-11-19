import { describe, expect, it } from 'vitest';
import { parseCatalogAuto, parseMsfCatalog } from './index.js';
import { CatalogManager } from '../../player/src/catalog-manager.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('MSF-02 catalog version', () => {
    it('preserves the declared draft through parsing, dispatch and materialization', () => {
        const json = bytes({ version: 'draft-02', tracks: [] });
        expect(parseMsfCatalog(json)).toMatchObject({ version: 1, msfDraft: 'draft-02' });
        expect(parseCatalogAuto(json)).toMatchObject({ version: 1, msfDraft: 'draft-02' });
        const manager = new CatalogManager(['example.com', 'live']);
        expect(manager.processCatalogObject(json)).toMatchObject({ msfDraft: 'draft-02' });
        expect(manager.wireFormat).toBe('msf-02');
        for (const version of ['draft-03', '2']) {
            expect(() => parseMsfCatalog(bytes({ version, tracks: [] }))).toThrow(/Unsupported catalog version/);
        }
        manager.processCatalogObject(bytes({ version: 'draft-01', tracks: [] }));
        expect(manager.currentState).not.toHaveProperty('msfDraft');
        expect(manager.wireFormat).toBe('msf-01');
    });
});
