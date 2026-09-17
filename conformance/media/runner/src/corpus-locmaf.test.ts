import { describe, it, expect } from 'vitest';
import {
    LocmafEncoder,
    LocmafGroupState,
    LocmafReconstructor,
    LocmafTrackDecoder,
    deserializeLocmafObject,
    parseLocmafTrackContext,
    serializeLocmafObject,
    sliceFrames,
    parseEmsgBoxes,
    LOCMAF_VERSION,
} from '@moqt/locmaf';
import { effectiveProjection, loadLocmafCorpus, rawProjection, splitFramed } from './locmaf-exec.js';

const corpus = loadLocmafCorpus();

describe('corpus/locmaf — Eyevinn golden vectors (third-party, interop)', () => {
    it('loads 14 verified cases with 38 objects, pinned to a source commit under MIT', () => {
        expect(corpus.cases.length).toBe(14);
        expect(corpus.cases.reduce((n, c) => n + c.objects.length, 0)).toBe(38);
        expect(corpus.manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(corpus.manifest.source.license).toBe('MIT');
        expect(corpus.manifest.provenance.class).toBe('third-party');
        expect(corpus.manifest.provenance.locmafVersion).toBe(LOCMAF_VERSION);
    });

    for (const c of corpus.cases) {
        describe(c.name, () => {
            it('decodes every object to the canonical chunk and effective values (section 15)', () => {
                const context = parseLocmafTrackContext(c.init);
                const reconstructor = new LocmafReconstructor();
                let group = -1;
                let state = new LocmafGroupState();
                for (const o of c.objects) {
                    if (o.group !== group) {
                        group = o.group;
                        state = new LocmafGroupState();
                    }
                    const object = deserializeLocmafObject(o.payload);
                    const out = reconstructor.reconstruct(object, state, context, BigInt(o.object));
                    expect(out.bytes, `${o.file} canonical`).toEqual(o.canonical);
                    const projection = out.kind === 'raw' || object.kind === 'rawBoxes'
                        ? rawProjection(out.bytes)
                        : effectiveProjection(out.effective, object.genBoxes, object.mdat);
                    expect(projection, `${o.file} effective`).toEqual(o.effective);
                    expect(serializeLocmafObject(object), `${o.file} re-serializes byte-identically`).toEqual(o.payload);
                }
            });

            it('decodes through LocmafTrackDecoder with the same bytes', () => {
                const decoder = new LocmafTrackDecoder(c.init);
                for (const o of c.objects) {
                    const result = decoder.push(BigInt(o.group), BigInt(o.object), o.payload);
                    expect(result.kind, o.file).not.toBe('rejected');
                    if (result.kind !== 'rejected') expect(result.bytes, o.file).toEqual(o.canonical);
                }
            });

            it('slices every chunk into frames that tile its mdat payload (section 16)', () => {
                const decoder = new LocmafTrackDecoder(c.init);
                for (const o of c.objects) {
                    const result = decoder.push(BigInt(o.group), BigInt(o.object), o.payload);
                    if (result.kind !== 'chunk') continue;
                    const frames = sliceFrames(result.effective, result.mdat);
                    expect(frames.length, o.file).toBe(result.sampleCount);
                    expect(frames.reduce((n, f) => n + f.data.length, 0), o.file).toBe(result.mdat.length);
                    expect(result.bytes.subarray(result.bytes.length - result.mdat.length), o.file).toEqual(result.mdat);
                    let expectedDecodeTime = result.baseMediaDecodeTime;
                    for (const f of frames) {
                        expect(f.decodeTime, `${o.file} frame ${f.index}`).toBe(expectedDecodeTime);
                        expectedDecodeTime += BigInt(f.duration);
                    }
                    if (c.name === 'event-only') {
                        const events = parseEmsgBoxes(result.genBoxes);
                        expect(events.length, o.file).toBe(1);
                        expect(events[0]!.schemeIdUri, o.file).toBe('urn:y');
                    }
                }
            });

            it('re-encodes the canonical chunks to the canonical objects (section 15.9)', () => {
                const context = parseLocmafTrackContext(c.init);
                const encoder = new LocmafEncoder();
                let group = -1;
                let state = new LocmafGroupState();
                for (const o of c.objects) {
                    if (o.group !== group) {
                        group = o.group;
                        state = new LocmafGroupState();
                    }
                    const encoded = serializeLocmafObject(encoder.encode(o.canonical, state, context, false, BigInt(o.object)));
                    expect(encoded, `${o.file} encode`).toEqual(o.payload);
                }
            });

            if (c.framed !== undefined) {
                it('splits the self-framed file into the same objects (section 17)', () => {
                    expect(splitFramed(c.framed!)).toEqual(c.objects.map((o) => o.payload));
                });
            }
        });
    }
});
