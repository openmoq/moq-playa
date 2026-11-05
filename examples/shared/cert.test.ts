/**
 * Tests for the example query-string parameters.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWithSearch(search: string): Promise<typeof import('./cert.js')> {
  vi.resetModules();
  vi.stubGlobal('window', { location: { search } });
  return import('./cert.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('catalogTrackName query parameter', () => {
  it('defaults to "catalog" when absent', async () => {
    expect((await loadWithSearch('')).catalogTrackName).toBe('catalog');
  });

  it('treats an empty value as absent rather than the empty track name', async () => {
    expect((await loadWithSearch('?catalogTrackName=')).catalogTrackName).toBe('catalog');
  });

  it('uses a supplied name', async () => {
    expect((await loadWithSearch('?catalogTrackName=.catalog')).catalogTrackName).toBe('.catalog');
  });
});
