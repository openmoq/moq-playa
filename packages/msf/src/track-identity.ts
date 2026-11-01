/**
 * Track identity — the one place that decides what makes two tracks the same.
 *
 * A track namespace is an ORDERED SET OF FIELDS compared by exact bytes:
 * draft-22 §2.4.1 and draft-18 allow 0–32 fields, draft-16 requires 1–32.
 * Prefix matching operates on those fields. Display text is not identity, and
 * joining fields for display loses the structure that identity depends on.
 *
 * Both catalog formats declare a namespace as a JSON string and defer to
 * transport for its meaning (msf-01 §5.2.2, cf01 §3.2.9), and neither defines
 * how that string maps to fields — though transport §2.4.1 says a using
 * specification must define such a canonicalization. {@link fieldsFromCatalogText}
 * is therefore THIS LIBRARY'S convention, not a normative rule, and is the
 * only place it is applied.
 *
 * @see draft-ietf-moq-transport-22 §2.4.1
 * @see draft-ietf-moq-msf-01 §5.2.2, §5.2.3
 * @see draft-ietf-moq-catalogformat-01 §3.2.9
 */

/**
 * A track's resolved wire namespace.
 *
 * LIBRARY-PRODUCED. It is never read from catalog JSON: a catalog declares
 * only the `namespace` string, and accepting this from the wire would let a
 * publisher assert a resolution the format has no syntax for. Parsers compute
 * it; an application supplying already-normalized track objects may set it on
 * its own entry path, which is how a field containing the separator can be
 * expressed at all.
 */
export interface ResolvedTrackNamespace {
    /** Ordered wire fields. Compared by exact content and order. */
    readonly fields: readonly string[];
    /** `declared` — from this track's own `namespace` text.
     *  `inherited` — from the catalog context the track was parsed with. */
    readonly source: 'declared' | 'inherited';
}

/**
 * The namespace a catalog was retrieved under.
 *
 * `readonly string[]` is the wire tuple, used verbatim; a `string` is catalog
 * text and is canonicalized; `undefined` means the caller did not supply the
 * context, which stays UNRESOLVED rather than being invented.
 */
export type CatalogNamespaceContext = string | readonly string[] | undefined;

/**
 * Canonicalize catalog TEXT into wire fields.
 *
 * This library's convention: split on `/`. Note the consequences, which are
 * deliberate rather than incidental — `''` yields one empty field, not zero
 * fields, so it is NOT the same namespace as a zero-field tuple; and text can
 * never express a field that itself contains `/`. A publisher needing that is
 * a gap in the catalog formats, not something to encode with new syntax here.
 */
export function fieldsFromCatalogText(text: string): string[] {
    return text.split('/');
}

/** Display form. Presentation only — never compared, never re-split. */
export function namespaceDisplay(fields: readonly string[]): string {
    return fields.join('/');
}

/**
 * The fields a context denotes, or undefined when there is no context.
 *
 * A supplied array is COPIED: taking a caller's array by reference would let
 * identity change under us after it was validated.
 */
export function contextFields(context: CatalogNamespaceContext): readonly string[] | undefined {
    if (context === undefined) return undefined;
    return typeof context === 'string' ? fieldsFromCatalogText(context) : [...context];
}

/**
 * Resolve one track's namespace: its own declared text, else the catalog
 * context, else unresolved.
 *
 * Returning undefined is meaningful. A standalone parse with no context
 * cannot know a track's namespace, and inventing `[]` or `['']` would assert
 * a specific wire namespace that was never supplied — the resolution is
 * completed later against real context, or reported missing by whichever
 * operation needs it.
 */
export function resolveTrackNamespace(
    declaredText: string | undefined,
    context: CatalogNamespaceContext,
): ResolvedTrackNamespace | undefined {
    if (declaredText !== undefined) {
        return { fields: fieldsFromCatalogText(declaredText), source: 'declared' };
    }
    const inherited = contextFields(context);
    return inherited === undefined ? undefined : { fields: inherited, source: 'inherited' };
}

/**
 * The identity key for a namespace/name pair.
 *
 * Structured, so it is injective: a delimiter-joined key collides whenever
 * either part can contain the delimiter, and neither format excludes any byte
 * from a namespace field or a track name. An unresolved namespace keys
 * distinctly from every resolved one, and two unresolved tracks of the same
 * name share a key — which is what keeps a contextless parse rejecting a
 * genuine duplicate.
 *
 * Both parts must be UTF-8 encodable, so keying an identity enforces the byte
 * contract. Keying is NOT the only way an identity is built, though: a model
 * may compare identities field by field without ever asking for a key, so
 * every construction site calls {@link assertUtf8EncodableIdentity} itself.
 */
export function identityKey(fields: readonly string[] | undefined, name: string): string {
    assertUtf8EncodableIdentity(fields, name);
    return JSON.stringify([fields ?? null, name]);
}

/**
 * Enforce the byte contract on a namespace/name pair.
 *
 * The shared validator for every place an identity is CONSTRUCTED, whether or
 * not a key is then taken from it. Call it once the namespace is actually
 * resolved — validating declared text before inheritance would check something
 * the identity does not contain.
 */
export function assertUtf8EncodableIdentity(
    fields: readonly string[] | undefined, name: string,
): void {
    assertUtf8EncodableIdentityText(name, `Track name "${name}"`);
    if (fields === undefined) return;
    for (const [index, field] of fields.entries()) {
        assertUtf8EncodableIdentityText(field, `Namespace field ${index} of track "${name}"`);
    }
}

/** Identity key for a normalized track, using its resolution when present. */
export function trackIdentityKey(
    track: { readonly name: string; readonly namespace?: string; readonly resolvedNamespace?: ResolvedTrackNamespace },
): string {
    return identityKey(namespaceFieldsOf(track), track.name);
}

/**
 * The wire fields of a normalized track.
 *
 * Falls back to canonicalizing its declared text, so a track that predates
 * resolution still keys consistently with one that carries it.
 */
export function namespaceFieldsOf(
    track: { readonly namespace?: string; readonly resolvedNamespace?: ResolvedTrackNamespace },
): readonly string[] | undefined {
    if (track.resolvedNamespace !== undefined) return track.resolvedNamespace.fields;
    return track.namespace === undefined ? undefined : fieldsFromCatalogText(track.namespace);
}

/**
 * Whether two namespaces are the same: same fields, same order, exact text.
 *
 * JS string equality stands in for byte equality because every identity that
 * reaches a comparison was validated when it was constructed, by
 * {@link assertUtf8EncodableIdentity}, which rejects text that would not
 * encode to distinct UTF-8 bytes. Comparing is not itself a boundary.
 */
export function sameNamespaceFields(
    a: readonly string[] | undefined, b: readonly string[] | undefined,
): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.length === b.length && a.every((field, i) => field === b[i]);
}

/**
 * The identity a delta operation REFERS to.
 *
 * A reference carries text, and an omitted namespace means the catalog's —
 * msf-01 §5.2.34 states this for a clone's parent, and the same reading
 * applies to an operation's own namespace field.
 */
export function referenceIdentityKey(
    reference: { readonly name: string; readonly namespace?: string },
    context: CatalogNamespaceContext,
): string {
    const fields = reference.namespace !== undefined
        ? fieldsFromCatalogText(reference.namespace)
        : contextFields(context);
    return identityKey(fields, reference.name);
}

/**
 * Whether a string is well-formed UTF-16, i.e. contains no unpaired surrogate.
 *
 * Scanned by code unit rather than with a lookbehind regexp so the check runs
 * the same everywhere this package ships.
 */
function isWellFormedUtf16(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit < 0xd800 || unit > 0xdfff) continue;
        // A low surrogate here is unpaired: a valid pair was consumed below.
        if (unit > 0xdbff) return false;
        const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
        if (next < 0xdc00 || next > 0xdfff) return false;
        i++;
    }
    return true;
}

/**
 * Reject identity text that cannot round-trip to UTF-8 bytes.
 *
 * Identity is EXACT BYTES on the wire (transport §2.4.1), but a JS string can
 * hold an unpaired surrogate, and every UTF-8 encoder — `TextEncoder` included
 * — replaces one with U+FFFD. Two such strings compare as distinct here and
 * encode to identical bytes, so a catalog could advertise two tracks that are
 * one track to the transport. The string APIs in this library express UTF-8,
 * so ill-formed text is rejected at the boundary rather than silently folded.
 *
 * This is a well-formedness rule only. No Unicode normalization (NFC, case
 * folding) is applied anywhere: that would merge wire identities the transport
 * keeps distinct, which is the opposite error.
 */
export function assertUtf8EncodableIdentityText(text: string, what: string): void {
    if (isWellFormedUtf16(text)) return;
    throw new Error(
        `${what} contains an unpaired surrogate and cannot be encoded as UTF-8. ` +
        `A track namespace field and a track name are compared as exact bytes ` +
        `(transport §2.4.1); ill-formed text would encode to U+FFFD and collide ` +
        `with a different declared identity.`,
    );
}
