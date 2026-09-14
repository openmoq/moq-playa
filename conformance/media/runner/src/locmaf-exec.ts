/**
 * LOCMAF golden-vector corpus (Eyevinn reference implementation): loader with
 * SHA-256 and reachability verification, and the projections used to compare
 * `@moqt/locmaf` output against the recorded canonical chunks and effective
 * values.
 *
 * @see draft-einarsson-moq-locmaf-01 section 15 (canonical reconstruction)
 * @module
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

import { readVi64, type GenBox, type LocmafEffectiveSamples } from '@moqt/locmaf';
import { vectorsRoot } from './load-corpus.js';
import { toHex } from './canonical.js';

export interface LocmafCorpusObject {
    readonly file: string;
    readonly group: number;
    readonly object: number;
    readonly payload: Uint8Array;
    readonly canonical: Uint8Array;
    readonly effective: unknown;
}

export interface LocmafCorpusCase {
    readonly name: string;
    readonly description: string;
    readonly init: Uint8Array;
    readonly objects: readonly LocmafCorpusObject[];
    readonly framed: Uint8Array | undefined;
}

export interface LocmafCorpus {
    readonly manifest: {
        readonly source: { readonly repository: string; readonly commit: string; readonly license: string; readonly licenseFile: string };
        readonly provenance: { readonly class: string; readonly locmafVersion: string };
        readonly cases: ReadonlyArray<{ readonly name: string; readonly objects: number; readonly framedFile: boolean }>;
    };
    readonly cases: readonly LocmafCorpusCase[];
}

export function locmafVectorsDir(): string {
    return join(vectorsRoot(), 'locmaf');
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

/**
 * Load and verify the corpus: every case listed, every file hashed against its
 * case manifest, no unlisted files, object counts as declared.
 * @throws {Error} on any mismatch.
 */
export function loadLocmafCorpus(dir: string = locmafVectorsDir()): LocmafCorpus {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as LocmafCorpus['manifest'];
    const expectedTop = new Set(['manifest.json', manifest.source.licenseFile, ...manifest.cases.map((c) => c.name)]);
    const onDisk = new Set(readdirSync(dir));
    for (const entry of onDisk) {
        if (!expectedTop.has(entry)) throw new Error(`locmaf corpus: unlisted entry ${entry}`);
    }
    for (const entry of expectedTop) {
        if (!onDisk.has(entry)) throw new Error(`locmaf corpus: missing entry ${entry}`);
    }

    const cases = manifest.cases.map((listed): LocmafCorpusCase => {
        const caseDir = join(dir, listed.name);
        const caseManifest = JSON.parse(readFileSync(join(caseDir, 'manifest.json'), 'utf-8')) as {
            name: string; description: string; objects: number; files: Record<string, string>;
        };
        if (caseManifest.name !== listed.name) throw new Error(`locmaf corpus: ${listed.name} manifest names ${caseManifest.name}`);
        const files = new Map<string, Uint8Array>();
        for (const [file, digest] of Object.entries(caseManifest.files)) {
            const bytes = new Uint8Array(readFileSync(join(caseDir, file)));
            const actual = sha256Hex(bytes);
            if (actual !== digest) throw new Error(`locmaf corpus: ${listed.name}/${file} sha256 ${actual} != ${digest}`);
            files.set(file, bytes);
        }
        for (const path of walk(caseDir)) {
            const rel = relative(caseDir, path).split('\\').join('/');
            if (rel !== 'manifest.json' && !files.has(rel)) throw new Error(`locmaf corpus: orphan file ${listed.name}/${rel}`);
        }

        const objects = [...files.keys()]
            .filter((f) => f.startsWith('objects/'))
            .sort()
            .map((file): LocmafCorpusObject => {
                const match = /^objects\/g(\d{3})_o(\d{3})\.locmafobj$/.exec(file);
                if (match === null) throw new Error(`locmaf corpus: unexpected object file ${file}`);
                const stem = file.slice('objects/'.length, -'.locmafobj'.length);
                const canonical = files.get(`canonical/${stem}.cmfc`);
                const effective = files.get(`effective/${stem}.json`);
                if (canonical === undefined || effective === undefined) throw new Error(`locmaf corpus: ${listed.name}/${stem} incomplete`);
                return {
                    file: `${listed.name}/${stem}`,
                    group: Number(match[1]),
                    object: Number(match[2]),
                    payload: files.get(file)!,
                    canonical,
                    effective: JSON.parse(new TextDecoder().decode(effective)) as unknown,
                };
            });
        if (objects.length !== listed.objects || objects.length !== caseManifest.objects) {
            throw new Error(`locmaf corpus: ${listed.name} has ${objects.length} objects, manifest says ${listed.objects}`);
        }
        const framed = files.get('file.locmaf');
        if ((framed !== undefined) !== listed.framedFile) throw new Error(`locmaf corpus: ${listed.name} framed file mismatch`);
        const init = files.get('init.mp4');
        if (init === undefined) throw new Error(`locmaf corpus: ${listed.name} has no init.mp4`);
        return { name: listed.name, description: caseManifest.description, init, objects, framed };
    });
    return { manifest, cases };
}

/** Project a decoded chunk into the reference JSON shape (Go `omitempty` rules). */
export function effectiveProjection(e: LocmafEffectiveSamples, genBoxes: readonly GenBox[], mdat: Uint8Array): Record<string, unknown> {
    const out: Record<string, unknown> = {
        sampleCount: e.durations.length,
        bmdt: Number(e.baseMediaDecodeTime),
        sampleDescriptionIndex: e.sampleDescriptionIndex,
        durations: [...e.durations],
        sizes: [...e.sizes],
        flags: [...e.flags],
        ctos: [...e.compositionTimeOffsets],
    };
    const c = e.cenc;
    if (c !== null) {
        if (c.perSampleIvSize !== 0) out['perSampleIVSize'] = c.perSampleIvSize;
        if (c.ivs.length > 0) out['ivs'] = toHex(c.ivs);
        if (c.subsampleCounts !== null) {
            out['hasSubsamples'] = true;
            if (c.subsampleCounts.length > 0) out['subsampleCounts'] = [...c.subsampleCounts];
            if (c.clearBytes !== null && c.clearBytes.length > 0) out['clearBytes'] = [...c.clearBytes];
            if (c.protectedBytes !== null && c.protectedBytes.length > 0) out['protectedBytes'] = [...c.protectedBytes];
        }
    }
    if (genBoxes.length > 0) out['genBoxes'] = genBoxes.map((b) => ({ name: b.type, payload: toHex(b.payload) }));
    out['mdatLength'] = mdat.length;
    out['mdatSha256'] = sha256Hex(mdat);
    return out;
}

/** Projection of a rawBoxes Object. */
export function rawProjection(bytes: Uint8Array): Record<string, unknown> {
    return { rawBoxes: { length: bytes.length, sha256: sha256Hex(bytes) } };
}

/** Split a self-framed LOCMAF file (vi64 length-prefixed Objects, draft section 17). */
export function splitFramed(file: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let pos = 0;
    while (pos < file.length) {
        const length = readVi64(file, pos);
        pos += length.bytesRead;
        const end = pos + Number(length.value);
        if (length.value > BigInt(file.length - pos)) throw new Error(`framed object at ${pos} overruns the file`);
        out.push(file.subarray(pos, end));
        pos = end;
    }
    return out;
}
