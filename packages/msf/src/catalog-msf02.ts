/** Draft-specific constraints shared by independent and delta catalogs. */
import { assertUtf8EncodableIdentityText, fieldsFromCatalogText } from './track-identity.js';

/** MSF-02 §11.2.1: catalog bytes are UTF-8 without a BOM. */
export function validateMsf02Encoding(json: string | Uint8Array): void {
    if (typeof json === 'string') {
        if (json.startsWith('\uFEFF')) throw new Error('MSF-02 catalog must not start with a BOM (§11.2.1)');
    } else {
        if (json[0] === 239 && json[1] === 187 && json[2] === 191) {
            throw new Error('MSF-02 catalog must not start with a BOM (§11.2.1)');
        }
        new TextDecoder('utf-8', { fatal: true }).decode(json);
    }
}

/** MSF-02 §5.2.2–3 and §11.2: validate declared naming fields before projection. */
export function validateMsf02Fields(obj: Record<string, unknown>, partial = false): void {
    for (const key of ['name', 'namespace', 'parentName', 'parentNamespace']) {
        if (!(key in obj)) continue;
        const value = obj[key];
        if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
            throw new Error(`MSF-02 ${key} must be a non-empty string without NUL (§11.2.1)`);
        }
        assertUtf8EncodableIdentityText(value, key);
        if (key === 'namespace' || key === 'parentNamespace') {
            const fields = fieldsFromCatalogText(value);
            if (fields.length > 32 || fields.some(field => field === '')) {
                throw new Error(`MSF-02 ${key} must contain 1–32 non-empty fields (§5.2.2)`);
            }
        }
    }
    for (const key of ['accessibleWindowTime', 'keyframeSpacing']) {
        if (!(key in obj)) continue;
        const value = obj[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
            || (key === 'keyframeSpacing' && (!Number.isInteger(value) || value === 0))) {
            throw new Error(`Invalid MSF-02 ${key} (§5.2.45–46)`);
        }
    }
    if (partial) return;
    const required: string[] = [];
    const role = obj['role'];
    if (role === 'audio' || role === 'video') required.push('codec', 'bitrate');
    if (role === 'audio' || (obj['packaging'] === 'loc' && role === 'audiodescription')) {
        required.push('codec', 'samplerate', 'channelConfig');
    }
    if (obj['packaging'] === 'loc') {
        if (role === 'video' || role === 'signlanguage') required.push('codec', 'framerate');
        if (role === 'audiodescription') required.push('lang');
    }
    for (const key of required) {
        const type = ['bitrate', 'samplerate', 'framerate'].includes(key) ? 'number' : 'string';
        if (typeof obj[key] !== type) throw new Error(`MSF-02 ${key} is required for ${String(role)} (§5.2.4.1)`);
    }
}

/** MSF-02 §5.2.5: known keys only, first occurrence wins. */
export function parsePackagingMetadata(raw: unknown, packaging: unknown): Readonly<Record<string, string>> {
    const result: Record<string, string> = {};
    if (packaging !== 'loc') return result;
    if (typeof raw === 'string') {
        for (const pair of raw.split(';')) {
            const equals = pair.indexOf('=');
            if (equals < 1) continue;
            const key = pair.slice(0, equals), value = pair.slice(equals + 1);
            if (key === 'streamMapping' && !(key in result) && value && !/[\s=;]/.test(value)) result[key] = value;
        }
    }
    result['streamMapping'] ??= 'group';
    return result;
}
