/**
 * Track alias manager tests.
 * @see draft-ietf-moq-transport-16 §10
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrackAliasManager } from './track-alias.js';
import { varint } from '../primitives/varint.js';

describe('TrackAliasManager', () => {
  let manager: TrackAliasManager;

  beforeEach(() => {
    manager = new TrackAliasManager();
  });

  describe('alias registration', () => {
    it('registers track alias with namespace and name', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]); // "video"
      const alias = varint(42n);

      manager.register(alias, namespace, name);

      const track = manager.getByAlias(alias);
      expect(track).toBeDefined();
      expect(track?.namespace).toEqual(namespace);
      expect(track?.name).toEqual(name);
    });

    it('returns undefined for unknown alias', () => {
      expect(manager.getByAlias(varint(999n))).toBeUndefined();
    });

    it('allows looking up alias by track', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const alias = varint(42n);

      manager.register(alias, namespace, name);

      const foundAlias = manager.getAliasByTrack(namespace, name);
      expect(foundAlias).toBe(42n);
    });

    it('returns undefined for unknown track', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      expect(manager.getAliasByTrack(namespace, name)).toBeUndefined();
    });
  });

  describe('alias uniqueness', () => {
    it('throws when registering duplicate alias', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name1 = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const name2 = new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f]);
      const alias = varint(42n);

      manager.register(alias, namespace, name1);

      expect(() => manager.register(alias, namespace, name2)).toThrow();
    });

    it('allows registering a second alias for the same track (§11.1 permits multiple aliases per track)', () => {
      // draft-18 §11.1 only prohibits ONE alias referring to two different tracks;
      // multiple aliases for one track is legal (e.g. the §5.1 collision race).
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const alias1 = varint(42n);
      const alias2 = varint(43n);

      manager.register(alias1, namespace, name);
      expect(() => manager.register(alias2, namespace, name)).not.toThrow();

      // Both aliases resolve to the track; each maps to only that one track.
      expect(manager.getByAlias(alias1)?.name).toEqual(name);
      expect(manager.getByAlias(alias2)?.name).toEqual(name);
      // Removing one leaves the other registered.
      manager.unregister(alias1);
      expect(manager.getByAlias(alias1)).toBeUndefined();
      expect(manager.getByAlias(alias2)?.name).toEqual(name);
      expect(manager.hasTrack(namespace, name)).toBe(true);
    });

    it('still throws when registering the same alias for a DIFFERENT track (§11.1)', () => {
      const ns = [new Uint8Array([0x6c])];
      const name1 = new Uint8Array([0x76]);
      const name2 = new Uint8Array([0x77]);
      manager.register(varint(42n), ns, name1);
      expect(() => manager.register(varint(42n), ns, name2)).toThrow();
    });

    it('allows re-registering same alias with same track', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const alias = varint(42n);

      manager.register(alias, namespace, name);

      // Should not throw - idempotent
      expect(() => manager.register(alias, namespace, name)).not.toThrow();
    });
  });

  describe('alias removal', () => {
    it('removes alias by value', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const alias = varint(42n);

      manager.register(alias, namespace, name);
      manager.unregister(alias);

      expect(manager.getByAlias(alias)).toBeUndefined();
      expect(manager.getAliasByTrack(namespace, name)).toBeUndefined();
    });

    it('does nothing when removing unknown alias', () => {
      expect(() => manager.unregister(varint(999n))).not.toThrow();
    });

    it('allows re-registering after removal', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name1 = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const name2 = new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f]);
      const alias = varint(42n);

      manager.register(alias, namespace, name1);
      manager.unregister(alias);
      manager.register(alias, namespace, name2);

      const track = manager.getByAlias(alias);
      expect(track?.name).toEqual(name2);
    });
  });

  describe('multiple tracks', () => {
    it('manages multiple track aliases', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const video = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const audio = new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f]);

      manager.register(varint(1n), namespace, video);
      manager.register(varint(2n), namespace, audio);

      expect(manager.getByAlias(varint(1n))?.name).toEqual(video);
      expect(manager.getByAlias(varint(2n))?.name).toEqual(audio);
    });

    it('tracks count of registered aliases', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];

      expect(manager.size).toBe(0);

      manager.register(varint(1n), namespace, new Uint8Array([0x76]));
      expect(manager.size).toBe(1);

      manager.register(varint(2n), namespace, new Uint8Array([0x61]));
      expect(manager.size).toBe(2);

      manager.unregister(varint(1n));
      expect(manager.size).toBe(1);
    });

    it('clears all aliases', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];

      manager.register(varint(1n), namespace, new Uint8Array([0x76]));
      manager.register(varint(2n), namespace, new Uint8Array([0x61]));

      manager.clear();

      expect(manager.size).toBe(0);
      expect(manager.getByAlias(varint(1n))).toBeUndefined();
      expect(manager.getByAlias(varint(2n))).toBeUndefined();
    });
  });

  describe('track key computation', () => {
    it('produces same key for equivalent byte arrays', () => {
      const namespace1 = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const namespace2 = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name1 = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const name2 = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      manager.register(varint(42n), namespace1, name1);

      // Different array instances with same content
      const alias = manager.getAliasByTrack(namespace2, name2);
      expect(alias).toBe(42n);
    });

    it('handles multi-segment namespaces', () => {
      const namespace = [
        new Uint8Array([0x6c, 0x69, 0x76, 0x65]), // "live"
        new Uint8Array([0x63, 0x68, 0x61, 0x74]), // "chat"
      ];
      const name = new Uint8Array([0x6d, 0x73, 0x67]); // "msg"

      manager.register(varint(100n), namespace, name);

      const track = manager.getByAlias(varint(100n));
      expect(track?.namespace).toEqual(namespace);
    });
  });

  describe('hasAlias and hasTrack', () => {
    it('hasAlias returns true for registered alias', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);

      manager.register(varint(42n), namespace, name);

      expect(manager.hasAlias(varint(42n))).toBe(true);
      expect(manager.hasAlias(varint(999n))).toBe(false);
    });

    it('hasTrack returns true for registered track', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);
      const otherName = new Uint8Array([0x61]);

      manager.register(varint(42n), namespace, name);

      expect(manager.hasTrack(namespace, name)).toBe(true);
      expect(manager.hasTrack(namespace, otherName)).toBe(false);
    });
  });
});
